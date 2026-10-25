import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The plan's chips on the Sources page: a keyword, a subreddit and a
 * competitor are each a row of their own table, and adding, switching and
 * removing one has to reach the right table and the right row. Proven against
 * a real database, because the where-clauses are the whole of it.
 */

const auth = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", () => ({
  requireLocalUser: async () => ({ id: auth.userId }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

async function fixture() {
  const { db } = await import("@/db");
  const schema = await import("@/db/schema");
  const user = await makeUser();
  const project = await makeProject(user.id, { name: "Chips" });
  auth.userId = user.id;
  return { user, project, db, schema };
}

describeDb("the plan's chips", () => {
  // The tier caps are what chipsOn counts against, and a self-hosted install has none.
  let selfHosted: string | undefined;
  let cleanupAuth: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
    selfHosted = process.env.SELF_HOSTED;
    process.env.SELF_HOSTED = "false";
  });
  afterEach(async () => {
    await cleanupAuth?.();
    if (selfHosted === undefined) {
      delete process.env.SELF_HOSTED;
    } else {
      process.env.SELF_HOSTED = selfHosted;
    }
  });

  it("adds, switches and removes each kind in its own table, and only the competitor is a fact", async () => {
    const { user, project, db, schema } = await fixture();
    const { addChipAction, removeChipAction, setChipStateAction } = await import(
      "@/app/app/product/actions"
    );
    const version = async () =>
      (await db().select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]
        .profileVersion;

    expect(await addChipAction("keyword", project.id, "invoice software")).toEqual({ error: null });
    expect(await addChipAction("subreddit", project.id, "r/SaaS")).toEqual({ error: null });
    expect(await version()).toBe(1);
    expect(await addChipAction("competitor", project.id, "acme.com")).toEqual({ error: null });
    expect(await version()).toBe(2);

    const [keyword] = await db()
      .select()
      .from(schema.projectKeywords)
      .where(eq(schema.projectKeywords.projectId, project.id));
    const [subreddit] = await db()
      .select()
      .from(schema.projectSubreddits)
      .where(eq(schema.projectSubreddits.projectId, project.id));
    const [competitor] = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(eq(schema.projectCompetitors.projectId, project.id));
    expect(keyword).toMatchObject({ keyword: "invoice software", source: "user", state: "active" });
    expect(subreddit).toMatchObject({ name: "saas", source: "user", state: "active" });
    expect(competitor).toMatchObject({ name: "acme.com", domain: "acme.com", source: "user" });

    expect(await setChipStateAction("subreddit", project.id, "saas", "pinned")).toEqual({ error: null });
    expect(await setChipStateAction("keyword", project.id, "invoice software", "excluded")).toEqual({
      error: null,
    });
    expect(await version()).toBe(2);
    const states = async () => ({
      keyword: (
        await db()
          .select({ state: schema.projectKeywords.state })
          .from(schema.projectKeywords)
          .where(eq(schema.projectKeywords.projectId, project.id))
      ).map((row) => row.state),
      subreddit: (
        await db()
          .select({ state: schema.projectSubreddits.state })
          .from(schema.projectSubreddits)
          .where(eq(schema.projectSubreddits.projectId, project.id))
      ).map((row) => row.state),
    });
    expect(await states()).toEqual({ keyword: ["excluded"], subreddit: ["pinned"] });

    await removeChipAction("keyword", project.id, "invoice software");
    await removeChipAction("competitor", project.id, "acme.com");
    expect(await version()).toBe(3);
    expect(await states()).toEqual({ keyword: [], subreddit: ["pinned"] });
    const competitors = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(eq(schema.projectCompetitors.projectId, project.id));
    expect(competitors).toEqual([]);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("counts switched-on and pinned rows against the cap, and never an excluded one", async () => {
    const { user, project, db, schema } = await fixture();
    const { TIERS } = await import("@/lib/tiers");
    const { addChipAction, setChipStateAction } = await import("@/app/app/product/actions");
    const cap = TIERS.free.competitors as number;

    await db()
      .insert(schema.projectCompetitors)
      .values(
        Array.from({ length: cap }, (_, index) => ({
          projectId: project.id,
          name: `Rival ${index}`,
          source: "discovery",
          state: index === 0 ? "pinned" : "active",
        })),
      );
    await db()
      .insert(schema.projectCompetitors)
      .values({ projectId: project.id, name: "Ignored", source: "discovery", state: "excluded" });

    expect((await addChipAction("competitor", project.id, "One too many")).error).toContain(
      `allows ${cap} competitors`,
    );
    expect((await setChipStateAction("competitor", project.id, "Ignored", "active")).error).toContain(
      `allows ${cap} competitors`,
    );

    expect(await setChipStateAction("competitor", project.id, "Rival 1", "excluded")).toEqual({
      error: null,
    });
    expect(await addChipAction("competitor", project.id, "Room now")).toEqual({ error: null });
    const added = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(
        and(eq(schema.projectCompetitors.projectId, project.id), eq(schema.projectCompetitors.name, "Room now")),
      );
    expect(added).toHaveLength(1);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});
