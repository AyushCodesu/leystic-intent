import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * Which competitors a project watches, read once in competitors/read.ts, and
 * the two places that read most depends on: the Competitors screen and the
 * weekly discovery refresh. One a person excluded on the Product page stays
 * stored, but no screen shows it and the labeller is not told about it; one
 * they typed in or pinned is theirs either way. Against a real database, with
 * AnyAPI, Google and the labeller faked.
 */

const googleSearch = vi.fn();
const labelThreads = vi.fn();

vi.mock("@/lib/seo/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/fetch")>()),
  googleSearch,
}));
vi.mock("@/lib/discovery/label", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discovery/label")>()),
  labelThreads,
}));
vi.mock("@/lib/anyapi", () => ({
  clientForUser: async () => ({
    client: {},
    funding: "house" as const,
    call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
  }),
  walletConnection: async () => null,
  tierNameFor: async () => "free" as const,
}));
vi.mock("@/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/enqueue")>()),
  enqueueJob: vi.fn(),
}));

describeDb("the competitors a project watches", () => {
  let uninstallAuth: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    uninstallAuth = (await installTestAuthorizedSource("reddit")).cleanup;
  });

  afterAll(async () => {
    if (uninstallAuth) {
      await uninstallAuth();
    }
  });
  beforeEach(() => {
    googleSearch.mockReset();
    labelThreads.mockReset();
  });

  /**
   * A project with one competitor in each standing: found by discovery and
   * active, pinned, typed in by a person, and excluded.
   */
  async function fixture() {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, {
      solution: "A form builder with conditional logic.",
      problemPhrasings: ["forms that branch", "conditional survey logic"],
    });
    const competitors = await db()
      .insert(schema.projectCompetitors)
      .values([
        { name: "Typeform", domain: "typeform.com", source: "serp", state: "active", evidence: 4 },
        { name: "Jotform", source: "serp", state: "pinned", evidence: 2 },
        { name: "Tally", source: "user", state: "active" },
        { name: "Wufoo", domain: "wufoo.com", source: "serp", state: "excluded", evidence: 3 },
      ].map((row) => ({ projectId: project.id, ...row })))
      .returning();
    const cleanup = async () => {
      const { eq } = await import("drizzle-orm");
      await db().delete(schema.users).where(eq(schema.users.id, user.id));
    };
    return { db, schema, project, competitors, cleanup };
  }

  it("lists and counts only the watched competitors' mentions on the Competitors screen", async () => {
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { countMentions, listMentions, mentionSeries, topCompetitors } = await import(
      "@/lib/competitors/read"
    );
    const { db, schema, project, cleanup } = await fixture();
    const run = randomUUID().slice(0, 6);
    const names = ["Typeform", "Jotform", "Tally", "Wufoo"];
    const posts = await upsertPosts(
      names.map((name, index) => ({
        id: `${run}${index}`,
        subreddit: "forms",
        author: "asker",
        title: `Thoughts on ${name}?`,
        permalink: `/r/forms/comments/${run}${index}/x/`,
        createdUtc: Math.floor(Date.now() / 1000) - index * 3600,
      })),
    );
    await db()
      .insert(schema.competitorMentions)
      .values(
        names.map((competitor, index) => ({
          projectId: project.id,
          competitor,
          postId: posts[index].id,
          sentiment: "neutral",
        })),
      );

    const mentions = await listMentions(project.id);

    expect(mentions.map((mention) => mention.competitor).sort()).toEqual([
      "Jotform",
      "Tally",
      "Typeform",
    ]);
    expect(await countMentions(project.id)).toBe(3);
    // What the screen draws from them: the excluded one is in no bar and no
    // ranking, rather than standing there without its logo.
    expect(topCompetitors(mentions).map((row) => row.competitor).sort()).toEqual([
      "Jotform",
      "Tally",
      "Typeform",
    ]);
    expect(mentionSeries(mentions, []).map((row) => row.competitor)).not.toContain("Wufoo");
    await cleanup();
  });

  it("tells the weekly refresh's labeller about every watched competitor, and leaves an excluded one alone", async () => {
    const { runDiscoveryRefresh } = await import("@/lib/discovery/refresh");
    const { writeObservations } = await import("@/lib/discovery/store");
    const { db, schema, project, competitors, cleanup } = await fixture();
    const { eq } = await import("drizzle-orm");
    const run = randomUUID().slice(0, 6);
    const held = `${run}held`;
    const fresh = `${run}new`;
    // One thread the project already holds evidence on, from an earlier round.
    await writeObservations(project.id, [
      {
        postId: held,
        canonicalUrl: `https://www.reddit.com/r/forms/comments/${held}/`,
        subreddit: "forms",
        query: "form builder reddit",
        family: "form builder",
        destination: null,
        position: 1,
        title: "Which form builder?",
        snippet: null,
      },
    ]);
    // Every new question Google is asked finds the held thread and one new one.
    googleSearch.mockResolvedValue({
      value: [held, fresh].map((id, index) => ({
        url: `https://www.reddit.com/r/forms/comments/${id}/x/`,
        position: index + 1,
        title: `Thread ${id}`,
        snippet: "Forms that branch on an answer",
      })),
      reused: false,
      costUsd: 0.005,
    });
    labelThreads.mockImplementation(async (input: { candidates: { id: string }[] }) =>
      input.candidates.map((candidate) => ({
        id: candidate.id,
        relevance: "relevant",
        destination: null,
        entities: [],
      })),
    );

    const outcome = await runDiscoveryRefresh(project.id, randomUUID());

    expect(labelThreads).toHaveBeenCalledTimes(1);
    const [input] = labelThreads.mock.calls[0];
    expect([...input.product.competitors].sort()).toEqual(["Jotform", "Tally", "Typeform"]);
    expect(input.candidates.map((candidate: { id: string }) => candidate.id)).toEqual([fresh]);
    expect(outcome).toMatchObject({ queries: 2, threads: 1 });
    expect(outcome.costUsd).toBeCloseTo(0.01);

    const after = await db()
      .select()
      .from(schema.projectCompetitors)
      .where(eq(schema.projectCompetitors.projectId, project.id));
    const excluded = competitors.find((row) => row.name === "Wufoo");
    expect(after.find((row) => row.name === "Wufoo")).toEqual(excluded);
    expect(
      after
        .filter((row) => row.state !== "excluded")
        .map((row) => row.name)
        .sort(),
    ).toEqual(["Jotform", "Tally", "Typeform"]);
    await cleanup();
  });
});
