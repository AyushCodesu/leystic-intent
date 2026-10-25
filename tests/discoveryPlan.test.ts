import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import type { DiscoveryPlan } from "@/lib/discovery/plan";
import type { ThreadLabel } from "@/lib/discovery/label";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * Publishing a plan replaces what discovery itself wrote and nothing else. A
 * person who pinned a community, excluded a search or typed a competitor in
 * has decided something the next rebuild has no right to undo, and the whole
 * replacement happens in one transaction so a scan never reads half a plan.
 * Proven against a real database, because the rules live in it.
 */

const PLAN: DiscoveryPlan = {
  subreddits: [
    { name: "hotels", state: "active", evidence: 3 },
    { name: "askhotels", state: "candidate", evidence: 1 },
  ],
  keywords: [{ keyword: "(hotel OR hotels) AND (18 OR 19)", evidence: 4 }],
  competitors: [
    { name: "hotelages.com", evidence: 2, domain: "hotelages.com" },
  ],
};

describeDb("publishing a discovery plan", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  it("files a round in one trip, each thread's last verdict and last place named on every row", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { applyRelevances, loadEvidence, writeObservations } = await import("@/lib/discovery/store");
    const { eq } = await import("drizzle-orm");
    const user = await makeUser();
    const projects = await db().insert(schema.projects).values(
      ["batch", "untouched"].map((name) => ({ userId: user.id, name })),
    ).returning();
    try {
      for (const project of projects) {
        await writeObservations(project.id, ["a", "b", "c", "d"].flatMap((postId) =>
          [null, "Miami"].map((destination) => ({
            postId, destination, query: destination ?? "broad", family: null,
            canonicalUrl: `https://reddit.com/r/hotels/comments/${postId}`,
            subreddit: "hotels", position: 1, title: "Hotel?", snippet: null,
          })),
        ));
      }
      const labels: ThreadLabel[] = [
        { id: "a", relevance: "relevant", destination: "Las Vegas", entities: [] },
        { id: "b", relevance: "irrelevant", destination: null, entities: [] },
        { id: "c", relevance: "plausible", destination: "", entities: [] },
        // A repeated id keeps its last verdict and its last nonempty place,
        // rather than UPDATE FROM choosing one of the two at random.
        { id: "a", relevance: "plausible", destination: null, entities: [] },
      ];
      await applyRelevances(projects[0].id, labels);
      await applyRelevances(projects[0].id, []);
      const sorted = (rows: (string | null)[][]) =>
        rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const read = async (id: string) =>
        sorted((await loadEvidence(id)).map((row) => [row.postId, row.query, row.relevance, row.destination]));
      // A place the model named replaces the query's own; no place leaves it standing.
      expect(await read(projects[0].id)).toEqual(
        sorted([
          ["a", "broad", "plausible", "Las Vegas"],
          ["a", "Miami", "plausible", "Las Vegas"],
          ["b", "broad", "irrelevant", null],
          ["b", "Miami", "irrelevant", "Miami"],
          ["c", "broad", "plausible", null],
          ["c", "Miami", "plausible", "Miami"],
          ["d", "broad", "unlabeled", null],
          ["d", "Miami", "unlabeled", "Miami"],
        ]),
      );
      expect((await loadEvidence(projects[1].id)).every((row) => row.relevance === "unlabeled")).toBe(true);
    } finally {
      await db().delete(schema.users).where(eq(schema.users.id, user.id));
    }
  });

  it("replaces what discovery wrote and keeps what a person decided", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { publishDiscoveryPlan } = await import("@/lib/discovery/plan");
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "HotelsAllow" });

    await db().insert(schema.projectSubreddits).values([
      { projectId: project.id, name: "vegas", source: "serp", state: "pinned", evidence: 1 },
      { projectId: project.id, name: "travelhacks", source: "serp", state: "excluded" },
      { projectId: project.id, name: "stale", source: "serp", state: "active", evidence: 2 },
    ]);
    await db().insert(schema.projectKeywords).values([
      { projectId: project.id, keyword: "my own search", source: "user", state: "active" },
      { projectId: project.id, keyword: "an old compiled query", source: "serp", state: "active" },
      { projectId: project.id, keyword: "app for hotel check in", source: "sweep", state: "active" },
    ]);
    await db()
      .insert(schema.projectCompetitors)
      .values({ projectId: project.id, name: "Typed by hand", source: "user", state: "active" });

    await publishDiscoveryPlan(project.id, PLAN);

    const subs = await db()
      .select()
      .from(schema.projectSubreddits)
      .where(eq(schema.projectSubreddits.projectId, project.id));
    const byName = new Map(subs.map((row) => [row.name, row]));
    expect(byName.get("vegas")?.state).toBe("pinned");
    expect(byName.get("travelhacks")?.state).toBe("excluded");
    expect(byName.get("stale")).toBeUndefined();
    expect(byName.get("hotels")?.source).toBe("serp");
    expect(byName.get("hotels")?.state).toBe("active");
    expect(byName.get("hotels")?.evidence).toBe(3);
    expect(byName.get("askhotels")?.state).toBe("candidate");

    const keywords = await db()
      .select()
      .from(schema.projectKeywords)
      .where(eq(schema.projectKeywords.projectId, project.id));
    expect(keywords.map((row) => row.keyword).sort()).toEqual([
      "(hotel OR hotels) AND (18 OR 19)",
      "app for hotel check in",
      "my own search",
    ]);

    const competitors = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(eq(schema.projectCompetitors.projectId, project.id));
    expect(competitors.map((row) => row.name).sort()).toEqual([
      "Typed by hand",
      "hotelages.com",
    ]);
    expect(competitors.find((row) => row.name === "hotelages.com")).toMatchObject({
      domain: "hotelages.com",
      evidence: 2,
      source: "serp",
    });

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("keeps the competitors the page named, and gives discovery only the room they leave", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { publishDiscoveryPlan } = await import("@/lib/discovery/plan");
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "YAROOMS" });
    await db().insert(schema.projectCompetitors).values([
      { projectId: project.id, name: "Robin", source: "page", state: "active" },
      { projectId: project.id, name: "Envoy", source: "page", state: "active" },
      { projectId: project.id, name: "Found last week", source: "serp", state: "active" },
    ]);

    await publishDiscoveryPlan(project.id, {
      subreddits: [],
      keywords: [],
      competitors: [
        { name: "Robin", evidence: 5, domain: null },
        { name: "skedda.com", evidence: 3, domain: "skedda.com" },
        { name: "deskbird.com", evidence: 2, domain: "deskbird.com" },
      ],
      competitorLimit: 3,
    });

    const competitors = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(eq(schema.projectCompetitors.projectId, project.id));
    expect(competitors.map((row) => row.name).sort()).toEqual(["Envoy", "Robin", "skedda.com"]);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("records one thread once per query and files the model's verdict on all of them", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { applyRelevances, loadEvidence, writeObservations } = await import(
      "@/lib/discovery/store"
    );
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "HotelsAllow" });

    const seen = {
      postId: "abc123",
      canonicalUrl: "https://www.reddit.com/r/hotels/comments/abc123/",
      subreddit: "hotels",
      family: "hotels-let-18",
      destination: null,
      position: 1,
      title: "Hotels that let 18 year olds check in",
      snippet: "I turn 19 next month.",
    };
    await writeObservations(project.id, [
      { ...seen, query: "broad" },
      { ...seen, query: "vegas" },
    ]);
    await writeObservations(project.id, [{ ...seen, query: "broad" }]);
    await applyRelevances(project.id, [
      { id: seen.postId, relevance: "relevant", destination: "Las Vegas", entities: [] },
    ]);

    const rows = await loadEvidence(project.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.relevance === "relevant")).toBe(true);
    expect(rows.every((row) => row.destination === "Las Vegas")).toBe(true);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});
