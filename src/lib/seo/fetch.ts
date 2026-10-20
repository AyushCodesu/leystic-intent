import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { serpResults } from "@/db/schema";
import {
  fetchShared,
  normalizeQuery,
  variantOf,
  type FetchContext,
  type SharedResult,
} from "@/lib/reddit/fetch";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import { redditResults, type GoogleResult } from "./links";

export type StoredResult = typeof serpResults.$inferSelect;

/** Every Google search this app makes asks for United States results. */
const GEO = "us";

/**
 * The response time Google is asked for. AnyAPI serves the cheapest source
 * whose median is under this and the best it has when none is, so this buys
 * speed where there is some to buy and never refuses a search. A new project
 * waits on these searches before it has a plan: measured 2026-09-17, the
 * cheapest source took 7 to 9 seconds a search.
 */
const GOOGLE_LATENCY_MS = 1000;

/** And asks for them in English, which is also Google's own default. */
const LANGUAGE = "en";

/**
 * What we actually send Google, wherever the question comes from: the words a
 * buyer would type, with "reddit" after them. It is what a person searching
 * for a thread actually types, and Google answers it with mostly Reddit, so
 * every caller asks the one question and they share one paid run between them.
 *
 * Measured 2026-09-14 over five phrasings: `site:reddit.com/r/` returns 9 or
 * 10 threads of 10 results against this form's 6 or 7 of 9, so the operator is
 * the denser form per call. It is not the better one. The two forms answer
 * from different slices - this one found 12 threads the operator missed across
 * those five - and everything discovery buys is labelled for relevance before
 * it can reach a plan, so a thread that does not belong costs a label and
 * nothing else.
 */
export function googleQuery(keyword: string): string {
  return `${keyword.trim()} reddit`;
}

/**
 * Keeps the Reddit threads among a page of results, each under its canonical
 * URL. Non-Reddit results are dropped before they are stored, so the whole app
 * only ever holds the links it can open through reddit.post.
 */
async function storeSerp(data: unknown, runId: string): Promise<StoredResult[]> {
  const results = ((data as { results?: GoogleResult[] } | null)?.results ?? []) as GoogleResult[];
  const threads = redditResults(results);
  if (threads.length === 0) {
    return [];
  }
  return db()
    .insert(serpResults)
    .values(
      threads.map(({ result, thread }) => ({
        id: randomUUID(),
        searchRunId: runId,
        position: result.position,
        url: thread.canonicalUrl,
        title: result.title ?? null,
        snippet: result.snippet ?? null,
      })),
    )
    .returning();
}

function loadSerp(runId: string): Promise<StoredResult[]> {
  return db()
    .select()
    .from(serpResults)
    .where(eq(serpResults.searchRunId, runId))
    .orderBy(asc(serpResults.position));
}

/**
 * The one Google search this app makes, wherever it is asked from. Every call
 * asks for the same market, United States results in English, so two callers
 * asking the same question the same way share one run and pay once.
 *
 * It is asked two ways. The scan's feed asks what is new: it passes the
 * timeframe Google restricts its answer to, so its runs are their own and
 * never serve a caller asking about all time, nor are served by one. Discovery
 * and the SEO refresh ask what Google ranks at all, and a new project waits on
 * their answer, so they prefer a fast source.
 *
 * Each way keeps the run key it has always been stored under, so the runs
 * already held go on serving: the feed's key names its market in the variant
 * and the other's never has. A stored URL may still be the link Google gave,
 * which is how the SEO refresh once stored them, so a reader parses it with
 * `redditThread` rather than trusting it to be canonical.
 */
export async function googleSearch(
  ctx: FetchContext,
  query: string,
  options: { timeframe?: string; preferLatency?: boolean } = {},
): Promise<SharedResult<StoredResult[]>> {
  const { timeframe, preferLatency } = options;
  return fetchShared<StoredResult[]>({
    ctx,
    kind: "serp",
    sku: "google.search",
    normalizedQuery: normalizeQuery(query),
    timeframe,
    variant: timeframe ? variantOf({ gl: GEO, hl: LANGUAGE }) : "",
    operation: ACQUISITION_OPERATIONS.seo_google_search,
    run: async () => {
      const res = await ctx.funded.client.google.search({
        query,
        gl: GEO,
        hl: LANGUAGE,
        ...(timeframe ? { timeframe } : {}),
        ...(preferLatency ? { preferLatencyUnderMs: GOOGLE_LATENCY_MS } : {}),
      });
      return { data: res.output.found ? res.output.data : null, costUsd: res.costUsd };
    },
    store: storeSerp,
    load: loadSerp,
  });
}
