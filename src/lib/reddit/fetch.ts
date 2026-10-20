import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { searchRuns, usageLedger } from "@/db/schema";
import type { FundedClient, Funding } from "@/lib/anyapi";
import { assertHouseDataUnderCap } from "@/lib/usage";
import {
  assertSourceAuthorized,
  sourceForSku,
  type SourceOperationRequest,
  type SourceUsagePurpose,
  type SourceUsageScope,
} from "@/lib/sourcePolicy";
import { paced } from "./pace";
/** One search_runs row per kind of thing we fetch, on Reddit or on Google. */
export type FetchKind =
  | "keyword"
  | "subreddit_posts"
  | "post"
  | "comments"
  | "subreddit"
  | "profile"
  | "serp"
  // X leads (src/lib/x/skus.ts). Their own kinds, never "keyword" or "profile":
  // sourceYield joins costs on kind without the sku.
  | "x_search"
  | "x_tweet"
  | "x_profile";

export type FetchContext = { projectId: string; funded: FundedClient; maxAgeMs: number };

type StoredRun = typeof searchRuns.$inferSelect;

type SharedFetch<T> = {
  ctx: FetchContext;
  kind: FetchKind;
  sku: string;
  normalizedQuery: string;
  sort?: string | null;
  timeframe?: string | null;
  /** Every other effective parameter, canonicalized; see `searchRuns.variant`. */
  variant?: string;
  maxAgeMs?: number;
  purpose?: SourceUsagePurpose;
  scope?: SourceUsageScope;
  run: () => Promise<{ data: unknown; costUsd: number; nextCursor?: string | null }>;
  store: (data: unknown, runId: string) => Promise<T>;
  load: (runId: string) => Promise<T>;
};

export function operationForFetch(input: {
  sku: string;
  kind: FetchKind;
  purpose?: SourceUsagePurpose;
  scope?: SourceUsageScope;
}): SourceOperationRequest {
  const sourceId = sourceForSku(input.sku);
  let defaultPurpose: SourceUsagePurpose;
  let defaultScope: SourceUsageScope;

  if (sourceId === "reddit") {
    defaultPurpose = "commercial_lead_generation";
    if (input.kind === "keyword" || input.kind === "subreddit_posts" || input.kind === "subreddit") {
      defaultScope = "search_discovery";
    } else if (input.kind === "comments") {
      defaultScope = "comments_read";
    } else {
      defaultScope = "social_content_read";
    }
  } else if (sourceId === "x") {
    defaultPurpose = "social_intent_monitoring";
    if (input.kind === "x_search") {
      defaultScope = "search_discovery";
    } else {
      defaultScope = "social_content_read";
    }
  } else if (sourceId === "google_scraped_serp") {
    defaultPurpose = "seo_opportunity_discovery";
    defaultScope = "search_discovery";
  } else {
    defaultPurpose = "commercial_lead_generation";
    defaultScope = "search_discovery";
  }

  return {
    sourceId,
    purpose: input.purpose ?? defaultPurpose,
    scope: input.scope ?? defaultScope,
  };
}

export type SharedResult<T> = { value: T; reused: boolean; costUsd: number };

type RunKey = {
  kind: FetchKind;
  sku: string;
  normalizedQuery: string;
  sort: string | null;
  timeframe: string | null;
  variant: string;
};

/**
 * The stored run that answers exactly this call. The SKU and the variant are
 * part of the key because two endpoints, or two pages of one walk, give
 * different answers to the same query and must never serve each other. A run
 * still storing its results is not an answer yet and is never returned.
 */
export async function findRun(key: RunKey, maxAgeMs: number): Promise<StoredRun | null> {
  const rows = await db()
    .select()
    .from(searchRuns)
    .where(
      and(
        eq(searchRuns.kind, key.kind),
        eq(searchRuns.sku, key.sku),
        eq(searchRuns.normalizedQuery, key.normalizedQuery),
        key.sort === null ? isNull(searchRuns.sort) : eq(searchRuns.sort, key.sort),
        key.timeframe === null
          ? isNull(searchRuns.timeframe)
          : eq(searchRuns.timeframe, key.timeframe),
        eq(searchRuns.variant, key.variant),
        isNotNull(searchRuns.completedAt),
        gte(searchRuns.fetchedAt, new Date(Date.now() - maxAgeMs)),
      ),
    )
    .orderBy(desc(searchRuns.fetchedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One usage_ledger line. Exported so a non-shared call can record itself too,
 * which is how a call with no search_runs row still reaches the house cap.
 */
export async function recordUsage(input: {
  projectId: string;
  sku: string;
  costUsd: number;
  requestId: string | null;
  searchRunId: string | null;
  fundedBy: Funding;
  reused: boolean;
}) {
  await db().insert(usageLedger).values({
    projectId: input.projectId,
    sku: input.sku,
    costUsd: input.costUsd.toFixed(6),
    requestId: input.requestId,
    searchRunId: input.searchRunId,
    fundedBy: input.fundedBy,
    reused: input.reused,
  });
}

/**
 * The one place a Reddit fetch happens. A run inside the caller's cadence
 * window is reused and billed at zero; otherwise we call AnyAPI, store the run,
 * and attribute its cost to the project that asked. A thrown SDK error writes
 * no run and no ledger line, so a failed scan never looks like a paid one.
 *
 * Every paid call the house pays for passes the daily house cap first. A user
 * spending their own wallet is exempt: that money is not ours to ration.
 *
 * Every paid Reddit call runs inside the process's shared pace, whichever job
 * makes it; Google has its own vendor and is not paced here.
 */
export async function fetchShared<T>(input: SharedFetch<T>): Promise<SharedResult<T>> {
  const operation = operationForFetch(input);
  assertSourceAuthorized(operation);
  const { ctx, kind, sku, normalizedQuery } = input;
  const sort = input.sort ?? null;
  const timeframe = input.timeframe ?? null;
  const variant = input.variant ?? "";
  const maxAgeMs = input.maxAgeMs ?? ctx.maxAgeMs;
  const key = { kind, sku, normalizedQuery, sort, timeframe, variant };

  const reuse = async (run: { id: string; requestId: string | null }, value: T) => {
    await recordUsage({
      projectId: ctx.projectId,
      sku,
      costUsd: 0,
      requestId: run.requestId,
      searchRunId: run.id,
      fundedBy: ctx.funded.funding,
      reused: true,
    });
    return { value, reused: true, costUsd: 0 };
  };

  const existing = await findRun(key, maxAgeMs);
  if (existing) {
    return reuse(existing, await input.load(existing.id));
  }
  // Two callers that both missed wait on one purchase instead of making two.
  const flightKey = JSON.stringify(key);
  const flying = inFlightRuns.get(flightKey) as Promise<Bought<T>> | undefined;
  if (flying) {
    const bought = await flying;
    return reuse(bought, bought.value);
  }

  const buying = buy(input, key);
  inFlightRuns.set(flightKey, buying);
  try {
    const bought = await buying;
    return { value: bought.value, reused: false, costUsd: bought.costUsd };
  } finally {
    inFlightRuns.delete(flightKey);
  }
}

type Bought<T> = { id: string; requestId: string | null; value: T; costUsd: number };

/** The purchases under way in this process, by the key a reuse would match. */
const inFlightRuns = new Map<string, Promise<Bought<unknown>>>();

/**
 * One paid call, stored. The run row is written first because its results point
 * at it, and only stamped complete once they are all in, which is the moment
 * `findRun` starts handing it out. The money is spent whether or not the store
 * works, so the ledger line is written either way.
 */
async function buy<T>(input: SharedFetch<T>, key: RunKey): Promise<Bought<T>> {
  const { ctx } = input;
  if (ctx.funded.funding === "house") {
    await assertHouseDataUnderCap();
  }
  const { result, requestId } = key.sku.startsWith("reddit.")
    ? await paced(() => ctx.funded.call(input.run))
    : await ctx.funded.call(input.run);
  const runId = randomUUID();
  await db().insert(searchRuns).values({
    id: runId,
    ...key,
    nextCursor: result.nextCursor ?? null,
    costUsd: result.costUsd.toFixed(6),
    requestId,
    fundedBy: ctx.funded.funding,
  });
  try {
    const value = await input.store(result.data, runId);
    await db().update(searchRuns).set({ completedAt: new Date() }).where(eq(searchRuns.id, runId));
    return { id: runId, requestId, value, costUsd: result.costUsd };
  } finally {
    await recordUsage({
      projectId: ctx.projectId,
      sku: key.sku,
      costUsd: result.costUsd,
      requestId,
      searchRunId: runId,
      fundedBy: ctx.funded.funding,
      reused: false,
    });
  }
}

/**
 * The variant string for a call: its parameters in a fixed order, so the same
 * page of the same walk is one key however the caller spelled it.
 */
export function variantOf(parts: Record<string, string | number | null | undefined>): string {
  return Object.keys(parts)
    .sort()
    .filter((key) => parts[key] !== null && parts[key] !== undefined && parts[key] !== "")
    .map((key) => `${key}=${parts[key]}`)
    .join("&");
}

/** Trimmed and lowercased, so two projects asking the same thing share a run. */
export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}
