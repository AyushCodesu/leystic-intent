/**
 * SQL ordering expressions for outcome-informed lead prioritization.
 * Ensures deterministic server-side sorting before pagination without modifying underlying scores.
 */

import { asc, desc, sql, type SQL } from "drizzle-orm";
import { leads, redditPosts } from "@/db/schema";
import { NEED_AT } from "@/lib/leadSql";
import type { OutcomeLearningSnapshot } from "./types";

/** The best score any lead in the same thread holds, under the same pills. */
const THREAD_BEST = sql`max(${leads.score}) over (partition by ${leads.postId})`;

/** The newest need in that thread, which settles two threads on one score. */
const THREAD_NEWEST = sql`max(${NEED_AT}) over (partition by ${leads.postId})`;

/** Default feed ordering: best score thread first, original stable tie-breakers. */
export const DEFAULT_FEED_ORDER = [
  desc(THREAD_BEST),
  desc(THREAD_NEWEST),
  asc(leads.postId),
  asc(sql`${leads.commentId} is not null`),
  desc(leads.score),
  desc(NEED_AT),
  asc(leads.id),
];

/**
 * Builds the SQL expression determining a lead's learned tier (1 = promising, 2 = neutral, 3 = mismatch).
 */
export function buildLearnedTierSql(snapshot: OutcomeLearningSnapshot): SQL<number> {
  if (!snapshot.enoughEvidenceToPrioritize) {
    return sql<number>`2`;
  }

  const promisingPatterns = snapshot.patterns.filter((p) => p.status === "promising");
  const mismatchPatterns = snapshot.patterns.filter((p) => p.status === "repeated_mismatch");

  const promisingCommunities = promisingPatterns
    .filter((p) => p.dimension === "community")
    .map((p) => p.value.toLowerCase());
  const promisingStages = promisingPatterns
    .filter((p) => p.dimension === "stage")
    .map((p) => p.value);
  const promisingKinds = promisingPatterns
    .filter((p) => p.dimension === "kind")
    .map((p) => p.value);

  const mismatchCommunities = mismatchPatterns
    .filter((p) => p.dimension === "community")
    .map((p) => p.value.toLowerCase());
  const mismatchStages = mismatchPatterns
    .filter((p) => p.dimension === "stage")
    .map((p) => p.value);
  const mismatchKinds = mismatchPatterns
    .filter((p) => p.dimension === "kind")
    .map((p) => p.value);

  const promisingClauses: SQL[] = [];
  if (promisingCommunities.length > 0) {
    promisingClauses.push(sql`lower(${redditPosts.subreddit}) in ${promisingCommunities}`);
  }
  if (promisingStages.length > 0) {
    promisingClauses.push(sql`${leads.stage} in ${promisingStages}`);
  }
  if (promisingKinds.length > 0) {
    promisingClauses.push(sql`${leads.kind} in ${promisingKinds}`);
  }

  const mismatchClauses: SQL[] = [];
  if (mismatchCommunities.length > 0) {
    mismatchClauses.push(sql`lower(${redditPosts.subreddit}) in ${mismatchCommunities}`);
  }
  if (mismatchStages.length > 0) {
    mismatchClauses.push(sql`${leads.stage} in ${mismatchStages}`);
  }
  if (mismatchKinds.length > 0) {
    mismatchClauses.push(sql`${leads.kind} in ${mismatchKinds}`);
  }

  if (promisingClauses.length === 0 && mismatchClauses.length === 0) {
    return sql<number>`2`;
  }

  const hasPromising =
    promisingClauses.length > 0 ? sql`(${sql.join(promisingClauses, sql` or `)})` : sql`false`;
  const hasMismatch =
    mismatchClauses.length > 0 ? sql`(${sql.join(mismatchClauses, sql` or `)})` : sql`false`;

  return sql<number>`(CASE
    WHEN ${hasPromising} AND NOT ${hasMismatch} THEN 1
    WHEN ${hasMismatch} AND NOT ${hasPromising} THEN 3
    ELSE 2
  END)`;
}

/**
 * Returns SQL order items applying learned prioritization when evidence threshold is met.
 * Preserves original scores and stable tie-breakers as secondary order.
 */
export function buildLearnedFeedOrder(snapshot: OutcomeLearningSnapshot) {
  if (!snapshot.enoughEvidenceToPrioritize) {
    return DEFAULT_FEED_ORDER;
  }

  const tierSql = buildLearnedTierSql(snapshot);
  const threadTierSql = sql<number>`min(${tierSql}) over (partition by ${leads.postId})`;

  return [
    asc(threadTierSql),
    desc(THREAD_BEST),
    desc(THREAD_NEWEST),
    asc(leads.postId),
    asc(sql`${leads.commentId} is not null`),
    asc(tierSql),
    desc(leads.score),
    desc(NEED_AT),
    asc(leads.id),
  ];
}
