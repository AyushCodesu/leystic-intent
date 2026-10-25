import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import type { StoredPost } from "@/lib/reddit/store";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The competitor scan and the SEO refresh open their posts together rather
 * than one after another. What they write must still come out in the order
 * they handed the posts in, not the order Reddit answered, and one post Reddit
 * will not hand back must cost only that post. Against a real database, with
 * AnyAPI, Reddit and the models faked.
 */

const fetchSearch = vi.fn();
const fetchPost = vi.fn();
const fetchPostComments = vi.fn();
const googleSearch = vi.fn();
const classifyMentions = vi.fn();
const labelThreads = vi.fn();
const judgePosts = vi.fn();

vi.mock("@/lib/reddit/skus", () => ({ fetchSearch, fetchPost, fetchPostComments }));
vi.mock("@/lib/seo/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/fetch")>()),
  googleSearch,
}));
vi.mock("@/lib/competitors/classify", () => ({ classifyMentions }));
vi.mock("@/lib/discovery/label", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discovery/label")>()),
  labelThreads,
}));
vi.mock("@/lib/scan/judging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scan/judging")>()),
  judgePosts,
}));
// A connected wallet, so the thread policy reads SEO replies.
vi.mock("@/lib/anyapi", () => ({
  clientForUser: async () => ({
    client: {},
    funding: "house" as const,
    call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
  }),
  walletConnection: async () => ({ id: "wallet" }),
  tierNameFor: async () => "connected" as const,
}));
vi.mock("@/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/enqueue")>()),
  enqueueJob: vi.fn(),
}));

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("posts a job opens together", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("all");
    cleanupAuth = auth.cleanup;
    for (const mock of [
      fetchSearch,
      fetchPost,
      fetchPostComments,
      googleSearch,
      classifyMentions,
      labelThreads,
      judgePosts,
    ]) {
      mock.mockReset();
    }
    labelThreads.mockResolvedValue([]);
    judgePosts.mockResolvedValue([]);
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  async function fixture(phrasings: string[] = []) {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, { problemPhrasings: phrasings });
    await db()
      .insert(schema.projectCompetitors)
      .values({ projectId: project.id, name: "Typeform", state: "active" });
    const cleanup = async () => {
      const { eq } = await import("drizzle-orm");
      await db().delete(schema.users).where(eq(schema.users.id, user.id));
    };
    return { db, schema, project, cleanup };
  }

  it("judges a competitor's posts newest first, not as they open, a failed one on the search's text", async () => {
    const { runCompetitorScan } = await import("@/lib/competitors/scan");
    const { project, cleanup } = await fixture();
    const run = randomUUID().slice(0, 6);
    const searched = [3, 2, 1].map(
      (hoursAgo, index) =>
        ({
          id: `${run}${index}`,
          title: `Typeform post ${index}`,
          subreddit: "SaaS",
          body: `search text ${index}`,
          url: `https://www.reddit.com/r/SaaS/comments/${run}${index}/x/`,
          createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
        }) as StoredPost,
    );
    fetchSearch.mockResolvedValue({
      value: { posts: searched, nextCursor: null },
      reused: false,
      costUsd: 0.01,
    });
    // The search hands the oldest post first. The newest answers last, and the
    // middle one not at all.
    fetchPost.mockImplementation(async (_ctx: unknown, url: string) => {
      const post = searched.find((one) => one.url === url) as StoredPost;
      if (post === searched[1]) {
        throw new Error("Reddit said no");
      }
      await settle(post === searched[2] ? 30 : 0);
      return { value: [{ ...post, body: `full text of ${post.id}` }], reused: false, costUsd: 0.001 };
    });
    classifyMentions.mockResolvedValue(new Map());

    const outcome = await runCompetitorScan(project.id, randomUUID());

    expect(fetchPost).toHaveBeenCalledTimes(3);
    const [, competitor, items] = classifyMentions.mock.calls[0];
    expect(competitor).toBe("Typeform");
    expect(items.map((item: { body: string }) => item.body)).toEqual([
      `full text of ${searched[2].id}`,
      "search text 1",
      `full text of ${searched[0].id}`,
    ]);
    expect(outcome.read).toBe(3);
    expect(outcome.costUsd).toBeCloseTo(0.012);
    await cleanup();
  });

  it("writes a phrasing's rows in Google's positions, and keeps a thread whose replies failed", async () => {
    const { runSeoRefresh } = await import("@/lib/seo/refresh");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { db, schema, project, cleanup } = await fixture(["best form builder"]);
    const { eq } = await import("drizzle-orm");
    const run = randomUUID().slice(0, 6);
    // Ranked first, never read, and its replies fail to arrive; ranked second,
    // and Reddit will not hand the post back; ranked third, read at its
    // current count, so its replies come from the store.
    const [first, second, unread] = await upsertPosts(
      ["a", "b", "c"].map((name) => ({
        id: `${run}${name}`,
        subreddit: "SaaS",
        author: "asker",
        title: `Which form builder ${name}`,
        permalink: `/r/SaaS/comments/${run}${name}/x/`,
        createdUtc: Math.floor(Date.now() / 1000),
        numComments: 5,
      })),
    );
    const [third] = await db()
      .update(schema.redditPosts)
      .set({ commentsObservedAt: new Date(), commentsReadCount: 5 })
      .where(eq(schema.redditPosts.id, unread.id))
      .returning();
    await db()
      .insert(schema.redditComments)
      .values([
        { id: `${run}k1`, postId: first.id, body: "Typeform did this for us", createdAt: new Date() },
        { id: `${run}k3`, postId: third.id, body: "Paper forms", createdAt: new Date() },
      ]);
    const ranked = [first, second, third];
    googleSearch.mockResolvedValue({
      value: ranked.map((post, index) => ({
        url: `https://old.reddit.com/r/SaaS/comments/${post.id}/x/?share=1`,
        position: index + 1,
        title: post.title,
        snippet: null,
      })),
      reused: false,
      costUsd: 0.005,
    });
    fetchPost.mockImplementation(async (_ctx: unknown, url: string) => {
      const post = ranked.find((one) => url.includes(`/${one.id}/`)) as StoredPost;
      if (post === second) {
        throw new Error("Reddit said no");
      }
      await settle(post === first ? 30 : 0);
      return { value: [post], reused: false, costUsd: 0.001 };
    });
    fetchPostComments.mockRejectedValue(new Error("Replies timed out"));

    const outcome = await runSeoRefresh(project.id, randomUUID());

    // The same key discovery asks Google under, no timeframe and the latency
    // preference, so a refresh reuses the runs discovery already bought.
    expect(googleSearch).toHaveBeenCalledTimes(1);
    expect(googleSearch).toHaveBeenCalledWith(expect.anything(), "best form builder reddit", {
      preferLatency: true,
    });
    expect(fetchPostComments.mock.calls.map((call) => call[1])).toEqual([first.id]);
    const rows = await db()
      .select()
      .from(schema.seoOpportunities)
      .where(eq(schema.seoOpportunities.projectId, project.id));
    expect(
      rows
        .map((row) => [row.postId, row.position, row.competitorPresent])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [first.id, 1, true],
      [third.id, 3, false],
    ]);
    const evidence = await db()
      .select()
      .from(schema.discoveryEvidence)
      .where(eq(schema.discoveryEvidence.projectId, project.id));
    expect(evidence.map((row) => row.canonicalUrl).sort()).toEqual(
      [first, third].map((post) => `https://www.reddit.com/r/SaaS/comments/${post.id}/`).sort(),
    );
    expect(outcome).toMatchObject({ phrasings: 1, threads: 2 });
    expect(outcome.costUsd).toBeCloseTo(0.007);
    await cleanup();
  });
});
