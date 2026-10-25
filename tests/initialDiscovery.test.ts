import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The one job a new project starts with, and what it leaves behind. Everything
 * a person waits for after pressing Create is queued here, in one transaction
 * with the marker that says the project is set up, so a crash in the middle
 * leaves a project that is still owed its setup rather than one that silently
 * never gets scanned.
 */

const runDiscovery = vi.fn();
const resolveActiveSubreddits = vi.fn(async () => ["saas"]);

vi.mock("@/lib/discovery/run", () => ({
  runDiscovery,
  discoveryBudget: () => ({ refreshDays: 7 }),
}));
vi.mock("@/lib/profile", () => ({ resolveActiveSubreddits }));

const HOUR_MS = 60 * 60 * 1000;

async function fixture(discovered: Date | null = null) {
  const { db } = await import("@/db");
  const schema = await import("@/db/schema");
  const user = await makeUser();
  const project = await makeProject(user.id, {
    pain: "Forms cannot branch.",
    solution: "A form builder with conditional logic.",
    targetUsers: "Ops teams",
    capabilities: ["branching"],
    problemPhrasings: ["forms that branch"],
    discoveredAt: discovered,
  });
  return { db, schema, user, project };
}

describeDb("the initial discovery", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("all");
    cleanupAuth = auth.cleanup;
    process.env.SELF_HOSTED = "false";
    process.env.X_LEADS = "false";
    runDiscovery.mockClear();
    resolveActiveSubreddits.mockClear();
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  it("publishes a plan and books every first job once", async () => {
    const { db, schema, user, project } = await fixture();
    const { eq } = await import("drizzle-orm");
    const { JOB_HANDLERS } = await import("@/jobs/registry");
    const job = { id: undefined, projectId: project.id } as unknown as Parameters<
      (typeof JOB_HANDLERS)["discovery_initial"]
    >[0];

    await JOB_HANDLERS.discovery_initial(job);

    expect(runDiscovery).toHaveBeenCalledTimes(1);
    expect(runDiscovery.mock.calls[0][0]).toMatchObject({
      projectId: project.id,
      userId: user.id,
      facts: { name: "Formcraft", pain: "Forms cannot branch.", capabilities: ["branching"] },
      problemPhrasings: ["forms that branch"],
    });

    const [marked] = await db()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(marked.discoveredAt).not.toBeNull();

    const queued = async () =>
      db().select().from(schema.jobs).where(eq(schema.jobs.projectId, project.id));
    const first = await queued();
    expect(first.map((row) => row.kind).sort()).toEqual([
      "backfill",
      "discovery_refresh",
      "scan",
    ]);
    const due = (kind: string) =>
      (first.find((row) => row.kind === kind)!.runAt.getTime() - Date.now()) / HOUR_MS;
    expect(due("backfill")).toBeLessThan(0.1);
    // The recurring scan waits for the project's own next slot. A daily cadence
    // puts that anywhere from minutes to a day away depending on the hour the
    // test runs, so it is checked against the slot rather than a fixed gap.
    const { cadenceFor } = await import("@/lib/settings/cadence");
    const { tierForUser } = await import("@/lib/tier");
    const { settings } = await tierForUser(user.id);
    const slot = cadenceFor(settings.settings.cadence).nextRunAt(new Date()).getTime();
    const scanAt = first.find((row) => row.kind === "scan")!.runAt.getTime();
    expect(Math.abs(scanAt - slot)).toBeLessThan(60_000);
    expect(due("scan")).toBeGreaterThan(0);
    expect(due("discovery_refresh")).toBeGreaterThan(24);

    await JOB_HANDLERS.discovery_initial(job);
    expect((await queued()).map((row) => row.kind).sort()).toEqual(
      first.map((row) => row.kind).sort(),
    );
  });

  it("starts X's first look beside the sweep when X is on, and not when it is off", async () => {
    const saved = process.env.X_LEADS;
    try {
      const { eq, and } = await import("drizzle-orm");
      const { JOB_HANDLERS } = await import("@/jobs/registry");
      const xScans = async (projectId: string, db: Awaited<ReturnType<typeof fixture>>["db"], schema: Awaited<ReturnType<typeof fixture>>["schema"]) =>
        db()
          .select()
          .from(schema.jobs)
          .where(and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.kind, "x_scan")));

      process.env.X_LEADS = "false";
      const off = await fixture();
      await JOB_HANDLERS.discovery_initial({ id: undefined, projectId: off.project.id } as never);
      expect(await xScans(off.project.id, off.db, off.schema)).toHaveLength(0);

      process.env.X_LEADS = "true";
      const on = await fixture();
      await JOB_HANDLERS.discovery_initial({ id: undefined, projectId: on.project.id } as never);
      const [scan] = await xScans(on.project.id, on.db, on.schema);
      expect(scan).toBeDefined();
      expect(scan.runAt.getTime()).toBeLessThanOrEqual(Date.now());
      // A second run of the setup queues nothing more.
      await JOB_HANDLERS.discovery_initial({ id: undefined, projectId: on.project.id } as never);
      expect(await xScans(on.project.id, on.db, on.schema)).toHaveLength(1);
    } finally {
      if (saved === undefined) {
        delete process.env.X_LEADS;
      } else {
        process.env.X_LEADS = saved;
      }
    }
  });

  it("reads no community's rules, so the sweep is not kept waiting on them", async () => {
    const { project } = await fixture();
    const { JOB_HANDLERS } = await import("@/jobs/registry");
    const job = { id: undefined, projectId: project.id } as unknown as Parameters<
      (typeof JOB_HANDLERS)["discovery_initial"]
    >[0];

    await JOB_HANDLERS.discovery_initial(job);

    expect(resolveActiveSubreddits).not.toHaveBeenCalled();
  });

  it("comes back on the same cadence a failed first sweep does, not days later", async () => {
    const { db, schema, project } = await fixture();
    const { and, eq, isNull } = await import("drizzle-orm");
    const { JOB_HANDLERS } = await import("@/jobs/registry");
    const { runClaimedJob } = await import("@/jobs/runner");

    const [claimed] = await db()
      .insert(schema.jobs)
      .values({ kind: "discovery_initial", projectId: project.id, startedAt: new Date() })
      .returning();
    const original = JOB_HANDLERS.discovery_initial;
    JOB_HANDLERS.discovery_initial = async () => {
      throw new Error("Google returned 502");
    };
    try {
      await runClaimedJob(claimed);
    } finally {
      JOB_HANDLERS.discovery_initial = original;
    }

    const pending = await db()
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.kind, "discovery_initial"),
          eq(schema.jobs.projectId, project.id),
          isNull(schema.jobs.startedAt),
        ),
      );
    expect(pending).toHaveLength(1);
    const { cadenceFor } = await import("@/lib/settings/cadence");
    const { PRESETS } = await import("@/lib/settings/presets");
    const due = cadenceFor(PRESETS.free.cadence).nextRunAt(new Date()).getTime();
    expect(pending[0].runAt.getTime()).toBeCloseTo(due, -4);
  });
});
