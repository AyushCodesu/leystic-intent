import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The reuse path touches four tables, so it is proven against a real database
 * with only the AnyAPI client faked. It skips when DATABASE_URL is absent.
 */
describeDb("fetchShared against a database", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  it("calls AnyAPI once and reuses the run for the second caller", async () => {
    const { db } = await import("@/db");
    const { redditPosts, searchRuns, usageLedger, users } = await import("@/db/schema");
    const { fetchSearch } = await import("@/lib/reddit/skus");
    const { and, eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Test project" });

    const query = `reuse test ${randomUUID()}`;
    let calls = 0;
    const post = {
      id: `t3_${randomUUID().slice(0, 8)}`,
      title: "Anyone using a form builder that does not charge per response",
      author: "someone",
      score: 12,
      numComments: 4,
      permalink: "/r/SaaS/comments/abc123/anyone_using_a_form_builder/",
      url: "https://example.com",
      createdUtc: Math.floor(Date.now() / 1000),
      subreddit: "SaaS",
    };
    const funded = {
      funding: "house" as const,
      call: async <T>(fn: () => Promise<T>) => ({
        result: await fn(),
        requestId: "test-request-id",
      }),
      client: {
        reddit: {
          search: async () => {
            calls += 1;
            return {
              output: { found: true as const, data: { posts: [post], nextCursor: null } },
              costUsd: 0.0012,
            };
          },
        },
      },
    };
    const ctx = {
      projectId: project.id,
      funded: funded as unknown as Parameters<typeof fetchSearch>[0]["funded"],
      maxAgeMs: 60 * 60 * 1000,
    };

    const first = await fetchSearch(ctx, query, { timeframe: "day" });
    const second = await fetchSearch(ctx, query, { timeframe: "day" });

    expect(calls).toBe(1);
    expect(first.reused).toBe(false);
    expect(first.costUsd).toBe(0.0012);
    expect(second.reused).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(second.value.posts.map((row) => row.title)).toEqual([post.title]);

    const ledger = await db()
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.projectId, project.id));
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((row) => row.reused)).toHaveLength(1);

    await db().delete(users).where(eq(users.id, user.id));
    await db()
      .delete(searchRuns)
      .where(and(eq(searchRuns.kind, "keyword"), eq(searchRuns.normalizedQuery, query)));
    await db().delete(redditPosts).where(eq(redditPosts.id, post.id.replace("t3_", "")));
  });
});

/** Puts an environment variable back, absent included, so config() still parses. */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * The house cap is the only thing standing between a runaway scan and the
 * operator's AnyAPI bill, so it is proven to stop a paid house call and to
 * leave a user spending their own wallet alone.
 */
describeDb("the house data cap", () => {
  async function fixture(funding: "house" | `wallet:${string}`, calls: { count: number }) {
    const { db } = await import("@/db");
    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Cap test" });
    const funded = {
      funding,
      call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
      client: {
        reddit: {
          search: async () => {
            calls.count += 1;
            return {
              output: { found: true as const, data: { posts: [], nextCursor: null } },
              costUsd: 0.0012,
            };
          },
        },
      },
    };
    return { db, user, project, funded };
  }

  it("refuses a paid house fetch over the cap and lets a wallet fetch through", async () => {
    const { HouseDataCapReachedError } = await import("@/lib/usage");
    const { fetchSearch } = await import("@/lib/reddit/skus");
    const { searchRuns, usageLedger, users } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const calls = { count: 0 };
    const previous = process.env.HOUSE_DATA_CAP_USD_PER_DAY;
    process.env.HOUSE_DATA_CAP_USD_PER_DAY = "0";

    const house = await fixture("house", calls);
    const query = `cap test ${randomUUID()}`;
    const ctx = {
      projectId: house.project.id,
      funded: house.funded as unknown as Parameters<typeof fetchSearch>[0]["funded"],
      maxAgeMs: 60 * 60 * 1000,
    };
    await expect(fetchSearch(ctx, query, { timeframe: "day" })).rejects.toBeInstanceOf(
      HouseDataCapReachedError,
    );
    expect(calls.count).toBe(0);
    expect(
      await house
        .db()
        .select()
        .from(searchRuns)
        .where(and(eq(searchRuns.kind, "keyword"), eq(searchRuns.normalizedQuery, query))),
    ).toHaveLength(0);
    expect(
      await house.db().select().from(usageLedger).where(eq(usageLedger.projectId, house.project.id)),
    ).toHaveLength(0);

    const wallet = await fixture(`wallet:${house.user.id}`, calls);
    const walletQuery = `cap test ${randomUUID()}`;
    const walletCtx = {
      projectId: wallet.project.id,
      funded: wallet.funded as unknown as Parameters<typeof fetchSearch>[0]["funded"],
      maxAgeMs: 60 * 60 * 1000,
    };
    const result = await fetchSearch(walletCtx, walletQuery, { timeframe: "day" });
    expect(result.reused).toBe(false);
    expect(calls.count).toBe(1);

    restore("HOUSE_DATA_CAP_USD_PER_DAY", previous);
    await house.db().delete(users).where(eq(users.id, house.user.id));
    await wallet.db().delete(users).where(eq(users.id, wallet.user.id));
    await wallet
      .db()
      .delete(searchRuns)
      .where(and(eq(searchRuns.kind, "keyword"), eq(searchRuns.normalizedQuery, walletQuery)));
  });
});

/**
 * One Google fetcher serves the feed, discovery and the SEO refresh. What it
 * stores is a thread's canonical URL, and what it reuses includes the runs the
 * SEO refresh stored before that, under the same key with the link Google gave.
 */
describeDb("google.search's stored runs", () => {
  it("stores canonical thread URLs, and still serves a run stored with Google's own link", async () => {
    const { db } = await import("@/db");
    const { searchRuns, serpResults, users } = await import("@/db/schema");
    const { googleSearch } = await import("@/lib/seo/fetch");
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Google test" });
    const query = `google test ${randomUUID()} reddit`;
    const asked: Record<string, unknown>[] = [];
    const funded = {
      funding: `wallet:${user.id}` as const,
      call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
      client: {
        google: {
          search: async (input: Record<string, unknown>) => {
            asked.push(input);
            return {
              output: {
                found: true as const,
                data: {
                  results: [
                    { link: "https://example.com/a", position: 1, title: "Not Reddit" },
                    {
                      link: "https://old.reddit.com/r/SaaS/comments/abc123/form_builders/?share=1",
                      position: 2,
                      title: "Form builders?",
                      snippet: "Which one",
                    },
                  ],
                },
              },
              costUsd: 0.0005,
            };
          },
        },
      },
    };
    const ctx = {
      projectId: project.id,
      funded: funded as unknown as Parameters<typeof googleSearch>[0]["funded"],
      maxAgeMs: 60 * 60 * 1000,
    };

    // A run the SEO refresh stored before the two fetchers were one.
    const oldRun = randomUUID();
    const rawLink = "https://www.reddit.com/r/SaaS/comments/old123/a_title/";
    await db().insert(searchRuns).values({
      id: oldRun,
      kind: "serp",
      sku: "google.search",
      normalizedQuery: query,
      completedAt: new Date(),
      fundedBy: "house",
    });
    await db()
      .insert(serpResults)
      .values({ id: randomUUID(), searchRunId: oldRun, position: 1, url: rawLink });

    const ranked = await googleSearch(ctx, query, { preferLatency: true });
    expect(ranked.reused).toBe(true);
    expect(ranked.value.map((row) => row.url)).toEqual([rawLink]);
    expect(asked).toHaveLength(0);

    const feed = await googleSearch(ctx, query, { timeframe: "7d" });
    expect(feed.reused).toBe(false);
    expect(asked).toHaveLength(1);
    expect(feed.value.map((row) => [row.position, row.url, row.title])).toEqual([
      [2, "https://www.reddit.com/r/SaaS/comments/abc123/", "Form builders?"],
    ]);
    const again = await googleSearch(ctx, query, { timeframe: "7d" });
    expect(again.reused).toBe(true);
    expect(again.value.map((row) => row.url)).toEqual([
      "https://www.reddit.com/r/SaaS/comments/abc123/",
    ]);

    await db().delete(users).where(eq(users.id, user.id));
    await db().delete(searchRuns).where(eq(searchRuns.normalizedQuery, query));
  });
});
