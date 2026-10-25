import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * A project set up before the first sweep kept its searches reads listings
 * only. It is given the sweep's best eight, tool asks first, never covered so
 * the scan asks each over the month, and scanned once. Proven against a real
 * database; the model and the scan are stand-ins.
 */

const sweepSearchItems = vi.fn();
const runScan = vi.fn();

vi.mock("@/lib/scan/searches", async (original) => ({
  ...(await original<typeof import("@/lib/scan/searches")>()),
  sweepSearchItems: (...args: unknown[]) => sweepSearchItems(...args),
}));
vi.mock("@/lib/scan/run", () => ({ runScan: (...args: unknown[]) => runScan(...args) }));
vi.mock("@/lib/alerts/email", () => ({ sendEmail: async () => {} }));

const MADE = [
  ...["a", "b", "c"].map((x) => ({ kind: "symptom", text: `symptom ${x}` })),
  ...["a", "b", "c", "d", "e"].map((x) => ({ kind: "tool_ask", text: `tool for ${x}` })),
  ...["a", "b", "c", "d"].map((x) => ({ kind: "alternative_to", text: `alternative to ${x}` })),
  { kind: "moment", text: "deadline tomorrow" },
];

describe("picking searches", () => {
  it("takes tool asks, then rivals, up to eight", async () => {
    const { pickSearches } = await import("@/lib/scan/widen");
    expect(pickSearches(MADE as never)).toEqual([
      "tool for a",
      "tool for b",
      "tool for c",
      "tool for d",
      "tool for e",
      "alternative to a",
      "alternative to b",
      "alternative to c",
    ]);
  });
});

describeDb("widening a project's searches", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
    sweepSearchItems.mockReset().mockResolvedValue(MADE);
    runScan.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  async function project(opts: { keyword?: boolean; discovered?: boolean; leadPostedDaysAgo?: number } = {}) {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { ALERT_SCORE_FLOOR } = await import("@/lib/leadFilters");
    const user = await makeUser({ email: `w-${randomUUID()}@example.com` });
    const row = await makeProject(user.id, {
      url: "https://formcraft.test",
      discoveredAt: opts.discovered === false ? null : new Date(),
    });
    if (opts.keyword) {
      await db()
        .insert(schema.projectKeywords)
        .values({ projectId: row.id, keyword: "form builder", source: "serp", state: "active" });
    }
    if (opts.leadPostedDaysAgo != null) {
      // A new buyer lead right at the house floor, on a post this many days old.
      const [post] = await upsertPosts([
        {
          id: `p${randomUUID().slice(0, 8)}`,
          subreddit: "saas",
          author: "asker",
          title: "Looking for a form builder",
          body: "Anyone know one?",
          permalink: `/r/saas/comments/${randomUUID().slice(0, 6)}/x/`,
          createdUtc: Math.floor(Date.now() / 1000) - opts.leadPostedDaysAgo * 24 * 3600,
        },
      ]);
      await db().insert(schema.leads).values({ projectId: row.id, postId: post.id, score: ALERT_SCORE_FLOOR });
    }
    return { user, project: row };
  }

  it("adds eight never-covered searches and scans once", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { widenSearches } = await import("@/lib/scan/widen");
    const { project: row } = await project();

    expect(await widenSearches(row.id, "job-1")).toBe(8);

    const kept = await db()
      .select()
      .from(schema.projectKeywords)
      .where(eq(schema.projectKeywords.projectId, row.id));
    expect(kept).toHaveLength(8);
    expect(kept.every((k) => k.source === "sweep" && k.state === "active" && k.lastCoveredAt === null)).toBe(
      true,
    );
    expect(runScan).toHaveBeenCalledWith(row.id, "job-1");
  });

  it("leaves a project that already searches alone", async () => {
    const { widenSearches } = await import("@/lib/scan/widen");
    const { project: row } = await project({ keyword: true });
    expect(await widenSearches(row.id, "job-2")).toBe(0);
    expect(sweepSearchItems).not.toHaveBeenCalled();
    expect(runScan).not.toHaveBeenCalled();
  });

  it("owes boot searches only to set-up projects with no searches and no fresh buyer lead, once", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { projectsOwedSearches } = await import("@/lib/scan/widen");
    const owed = await project();
    const searching = await project({ keyword: true });
    const unset = await project({ discovered: false });
    const widened = await project();
    await db().insert(schema.jobs).values({ kind: "widen_searches", projectId: widened.project.id });
    const findingBuyers = await project({ leadPostedDaysAgo: 1 });
    const onlyStaleBuyers = await project({ leadPostedDaysAgo: 31 });

    const ids = await projectsOwedSearches(new Date());
    expect(ids).toContain(owed.project.id);
    expect(ids).toContain(onlyStaleBuyers.project.id);
    for (const skipped of [searching, unset, widened, findingBuyers]) {
      expect(ids).not.toContain(skipped.project.id);
    }
  });

  it("queues searches for a project with none when its owner turns alerts on", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { acceptInvite } = await import("@/lib/alerts/invite");
    const { user, project: row } = await project();

    await acceptInvite(user.id);

    const queued = await db()
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.projectId, row.id), eq(schema.jobs.kind, "widen_searches")));
    expect(queued).toHaveLength(1);
  });
});
