import { eq } from "drizzle-orm";
import { db } from "@/db";
import { searchRuns } from "@/db/schema";
import { fetchShared, variantOf, type FetchContext, type SharedResult } from "@/lib/reddit/fetch";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import { assertXHouseDataUnderCap } from "./budget";
import { PAGE_SIZE } from "./constants";
import { assertLane } from "./grammar";
import { cursorOfSearch, lookupUrl, postsOfSearch, toXAuthor, toXPost } from "./map";
import { paced } from "./pace";
import {
  linkXRunPosts,
  markXPostUnavailable,
  upsertXAuthor,
  upsertXPosts,
  xAuthorByUsername,
  xPostsById,
  xPostsOfRun,
  type StoredXAuthor,
  type StoredXPost,
} from "./store";

/**
 * The three twitter.* endpoints X leads buys, all through the shared run store
 * (fetchShared), so the house cap, the ledger and reuse across projects come
 * free. Two things differ from Reddit on purpose:
 *
 * - The run key is the query in its exact case. Reddit's normalizeQuery
 *   lowercases, which would merge "a OR b" with "a or b".
 * - since_time lives in the variant, rounded to the hour by the caller, so a
 *   run is shareable at all: inside the query text every scan's key would be
 *   unique.
 *
 * X's own share of the house budget is checked inside `run`, which fetchShared
 * calls only on a real purchase, after the global cap and before any run row is
 * written, so a refused call leaves nothing behind. It is checked once the call
 * holds its semaphore slot, so calls queued behind a spent budget are refused
 * too, rather than approved before they waited.
 */

export type XSearchPage = { posts: StoredXPost[]; nextCursor: string | null };

/** How long a stored search page may serve another caller: just under an hourly cadence. */
const SEARCH_REUSE_MS = 55 * 60_000;
/** A post or a profile barely changes in a week, and the tab shows a week. */
const LOOKUP_REUSE_MS = 7 * 24 * 60 * 60_000;

async function houseGuard(ctx: FetchContext) {
  if (ctx.funded.funding === "house") {
    await assertXHouseDataUnderCap();
  }
}

/**
 * One page of Latest results for a lane body since a moment. `since` is epoch
 * seconds, floored to the hour by the caller.
 */
export async function searchPage(
  ctx: FetchContext,
  body: string,
  since: number,
  cursor?: string | null,
): Promise<SharedResult<XSearchPage>> {
  const query = `${body} since_time:${since}`;
  // Every lane is checked where it was compiled; this catches a stored body
  // that was not, before it can buy a page of the wrong posts.
  assertLane(query);
  return fetchShared<XSearchPage>({
    ctx,
    kind: "x_search",
    sku: "twitter.search",
    normalizedQuery: body,
    sort: "Latest",
    variant: variantOf({ since, cursor }),
    maxAgeMs: SEARCH_REUSE_MS,
    operation: ACQUISITION_OPERATIONS.x_search,
    run: async () => {
      const res = await paced(async () => {
        await houseGuard(ctx);
        return ctx.funded.client.twitter.search({
          query,
          queryType: "Latest",
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
      });
      const data = res.output.found ? res.output.data : null;
      return { data, costUsd: res.costUsd, nextCursor: cursorOfSearch(data) };
    },
    store: async (data, runId) => {
      const posts = await upsertXPosts(postsOfSearch(data));
      await linkXRunPosts(
        runId,
        posts.map((post) => post.id),
      );
      return { posts, nextCursor: cursorOfSearch(data) };
    },
    load: async (runId) => {
      const [run] = await db()
        .select({ nextCursor: searchRuns.nextCursor })
        .from(searchRuns)
        .where(eq(searchRuns.id, runId));
      return { posts: await xPostsOfRun(runId), nextCursor: run?.nextCursor ?? null };
    },
  });
}

/**
 * One post by id, for walking a reply up to what it answers. Null when X no
 * longer serves it (deleted, protected, withheld), which marks the stored row.
 */
export async function fetchTweet(ctx: FetchContext, id: string): Promise<SharedResult<StoredXPost | null>> {
  return fetchShared<StoredXPost | null>({
    ctx,
    kind: "x_tweet",
    sku: "twitter.tweet",
    normalizedQuery: id,
    maxAgeMs: LOOKUP_REUSE_MS,
    operation: ACQUISITION_OPERATIONS.x_tweet,
    run: async () => {
      const res = await paced(async () => {
        await houseGuard(ctx);
        return ctx.funded.client.twitter.tweet({ url: lookupUrl(id) });
      });
      return { data: res.output.found ? res.output.data : null, costUsd: res.costUsd };
    },
    store: async (data) => {
      const post = toXPost(data);
      if (!post) {
        await markXPostUnavailable(id);
        return null;
      }
      const [stored] = await upsertXPosts([post]);
      return stored ?? null;
    },
    load: async () => (await xPostsById([id])).get(id) ?? null,
  });
}

/** An author's profile, for the bio the complete judgement reads. Null when X has none to give. */
export async function fetchProfile(
  ctx: FetchContext,
  username: string,
): Promise<SharedResult<StoredXAuthor | null>> {
  const handle = username.toLowerCase();
  return fetchShared<StoredXAuthor | null>({
    ctx,
    kind: "x_profile",
    sku: "twitter.profile",
    normalizedQuery: handle,
    maxAgeMs: LOOKUP_REUSE_MS,
    operation: ACQUISITION_OPERATIONS.x_profile,
    run: async () => {
      const res = await paced(async () => {
        await houseGuard(ctx);
        return ctx.funded.client.twitter.profile({ handle });
      });
      return { data: res.output.found ? res.output.data : null, costUsd: res.costUsd };
    },
    store: async (data) => {
      const author = toXAuthor(data, handle);
      return author ? upsertXAuthor(author) : null;
    },
    load: async () => xAuthorByUsername(handle),
  });
}
