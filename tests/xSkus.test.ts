import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * How X's paid calls use the shared run store: the key keeps the query's exact
 * case (Reddit's lowercases, which would merge "a OR b" with "a or b"), the
 * cutoff lives in the variant so a run can be shared at all, and X's own house
 * budget refuses a call before anything is written.
 */

const { search } = vi.hoisted(() => ({ search: vi.fn() }));

function page() {
  return { output: { found: true, data: { items: [], nextCursor: null } }, costUsd: 0.00065, items: 0 };
}

describeDb("X search runs in the shared store", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let orm: typeof import("drizzle-orm");
  let searchPage: typeof import("@/lib/x/skus").searchPage;
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("x");
    cleanupAuth = auth.cleanup;
    process.env.HOUSE_X_DATA_CAP_USD_PER_DAY = "5";
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    orm = await import("drizzle-orm");
    ({ searchPage } = await import("@/lib/x/skus"));
    search.mockReset();
    search.mockResolvedValue(page());
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  async function context() {
    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Skus" });
    return {
      projectId: project.id,
      maxAgeMs: 0,
      funded: {
        client: { twitter: { search } },
        funding: "house" as const,
        call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
      },
    } as unknown as import("@/lib/reddit/fetch").FetchContext;
  }

  it("keys a run on the exact-case body, refuses 'a or b' before any call, and keeps the cutoff out of the key", async () => {
    const ctx = await context();
    const rival = `calendly${randomUUID().replace(/[^a-f]/gu, "").slice(0, 8)}`;
    const upper = `("alternative to ${rival}" OR "${rival} alternative") lang:en -filter:retweets`;
    const cased = upper.replace("alternative to", "Alternative to");
    await searchPage(ctx, upper, 1790000000);
    await searchPage(ctx, cased, 1790000000);
    expect(search).toHaveBeenCalledTimes(2);
    const { XLaneRefusedError } = await import("@/lib/x/grammar");
    await expect(searchPage(ctx, upper.replace(" OR ", " or "), 1790000000)).rejects.toBeInstanceOf(XLaneRefusedError);
    expect(search).toHaveBeenCalledTimes(2);
    const reused = await searchPage(ctx, upper, 1790000000);
    expect(reused.reused).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
    const [run] = await db()
      .select()
      .from(schema.searchRuns)
      .where(orm.and(orm.eq(schema.searchRuns.kind, "x_search"), orm.eq(schema.searchRuns.normalizedQuery, upper)));
    expect(run.variant).toBe("since=1790000000");
    expect(search.mock.calls[0][0].query).toBe(`${upper} since_time:1790000000`);
  });

  it("refuses a house call once X's share of the day is spent, before any run is written", async () => {
    const ctx = await context();
    process.env.HOUSE_X_DATA_CAP_USD_PER_DAY = "0";
    const { XHouseDataCapError } = await import("@/lib/x/budget");
    await expect(searchPage(ctx, `("alternative to doodle${randomUUID().slice(0, 8)}") lang:en -filter:retweets`, 1790000000)).rejects.toBeInstanceOf(
      XHouseDataCapError,
    );
    expect(search).not.toHaveBeenCalled();
    const ledger = await db().select().from(schema.usageLedger).where(orm.eq(schema.usageLedger.projectId, ctx.projectId));
    expect(ledger).toHaveLength(0);
  });
});
