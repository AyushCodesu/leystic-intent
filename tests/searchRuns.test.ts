import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { variantOf } from "@/lib/reddit/fetch";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

describe("variant string", () => {
  it("is the same string however the caller ordered the parameters", () => {
    expect(variantOf({ cursor: "p2", limit: 50 })).toBe(variantOf({ limit: 50, cursor: "p2" }));
  });

  it("leaves out what was not asked for, so a default call has an empty variant", () => {
    expect(variantOf({ cursor: undefined, limit: undefined })).toBe("");
    expect(variantOf({ cursor: undefined, limit: 50 })).toBe("limit=50");
  });

  it("separates two pages of the same walk", () => {
    expect(variantOf({ cursor: "p2" })).not.toBe(variantOf({ cursor: "p3" }));
  });
});

/**
 * The run key decides what a caller is handed without paying, so a wrong key
 * silently serves one endpoint's answer to another, or page one to a caller
 * asking for page two. Proven against a real database; skips without one.
 */
describeDb("the stored run key", () => {
  let uninstallAuth: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    uninstallAuth = (await installTestAuthorizedSource("reddit")).cleanup;
  });

  afterAll(async () => {
    if (uninstallAuth) {
      await uninstallAuth();
    }
  });
  it("tells two SKUs and two page variants apart", async () => {
    const { db } = await import("@/db");
    const { searchRuns } = await import("@/db/schema");
    const { findRun } = await import("@/lib/reddit/fetch");
    const { eq } = await import("drizzle-orm");

    const query = `key test ${randomUUID()}`;
    const base = {
      kind: "keyword",
      normalizedQuery: query,
      sort: "relevance",
      timeframe: "week",
      fundedBy: "house",
      completedAt: new Date(),
    };
    const first = randomUUID();
    const other = randomUUID();
    const page2 = randomUUID();
    await db()
      .insert(searchRuns)
      .values([
        { ...base, id: first, sku: "reddit.search", variant: "" },
        { ...base, id: other, sku: "reddit.subreddit_search", variant: "" },
        { ...base, id: page2, sku: "reddit.search", variant: "cursor=p2", nextCursor: "p3" },
      ]);

    const key = {
      kind: "keyword" as const,
      sku: "reddit.search",
      normalizedQuery: query,
      sort: "relevance",
      timeframe: "week",
      variant: "",
    };
    const hour = 60 * 60 * 1000;
    expect((await findRun(key, hour))?.id).toBe(first);
    expect((await findRun({ ...key, sku: "reddit.subreddit_search" }, hour))?.id).toBe(other);
    const second = await findRun({ ...key, variant: "cursor=p2" }, hour);
    expect(second?.id).toBe(page2);
    expect(second?.nextCursor).toBe("p3");
    expect(await findRun({ ...key, variant: "cursor=p9" }, hour)).toBeNull();

    // A run still storing its results is not an answer yet.
    await db().update(searchRuns).set({ completedAt: null }).where(eq(searchRuns.id, first));
    expect(await findRun(key, hour)).toBeNull();

    for (const id of [first, other, page2]) {
      await db().delete(searchRuns).where(eq(searchRuns.id, id));
    }
  });

  it("buys each cursor page once and hands the cursor back on reuse", async () => {
    const { db } = await import("@/db");
    const { redditPosts, searchRuns, users } = await import("@/db/schema");
    const { fetchSearch } = await import("@/lib/reddit/skus");
    const { and, eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Cursor test" });

    const query = `cursor test ${randomUUID()}`;
    const page = (id: string, title: string) => ({
      id,
      title,
      author: "someone",
      score: 1,
      numComments: 0,
      permalink: `/r/SaaS/comments/${id}/thread/`,
      url: "https://example.com",
      createdUtc: Math.floor(Date.now() / 1000),
      subreddit: "SaaS",
    });
    const one = page(randomUUID().slice(0, 8), "First page thread");
    const two = page(randomUUID().slice(0, 8), "Second page thread");
    const asked: (string | undefined)[] = [];
    const funded = {
      funding: "house" as const,
      call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
      client: {
        reddit: {
          search: async (input: { cursor?: string }) => {
            asked.push(input.cursor);
            return input.cursor
              ? {
                  output: { found: true as const, data: { posts: [two], nextCursor: null } },
                  costUsd: 0.0012,
                }
              : {
                  output: { found: true as const, data: { posts: [one], nextCursor: "page2" } },
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

    const first = await fetchSearch(ctx, query, { timeframe: "week" });
    expect(first.value.nextCursor).toBe("page2");
    const second = await fetchSearch(ctx, query, { timeframe: "week", cursor: "page2" });
    expect(second.reused).toBe(false);
    expect(second.value.posts.map((row) => row.title)).toEqual([two.title]);
    expect(second.value.nextCursor).toBeNull();

    const again = await fetchSearch(ctx, query, { timeframe: "week" });
    expect(again.reused).toBe(true);
    expect(again.value.posts.map((row) => row.title)).toEqual([one.title]);
    expect(again.value.nextCursor).toBe("page2");
    expect(asked).toEqual([undefined, "page2"]);

    await db().delete(users).where(eq(users.id, user.id));
    await db()
      .delete(searchRuns)
      .where(and(eq(searchRuns.kind, "keyword"), eq(searchRuns.normalizedQuery, query)));
    for (const row of [one, two]) {
      await db().delete(redditPosts).where(eq(redditPosts.id, row.id));
    }
  });
});
