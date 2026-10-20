import { aliasedTable, and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  discoveryEvidence,
  leadEvaluations,
  redditAuthors,
  redditPosts,
  seoOpportunities,
  subreddits,
} from "@/db/schema";
import type { Relevance } from "@/lib/discovery/label";
import {
  ensureSourcePolicyFresh,
  isSourceAuthorized,
  type SourceOperationRequest,
} from "@/lib/sourcePolicy";

const SEO_READ_OP: SourceOperationRequest = {
  operationId: "seo_post",
  sourceId: "reddit",
  purpose: "seo_opportunity_discovery",
  scope: "social_content_read",
};
import type { RankingThread } from "./thread";

/**
 * What a refresh writes as its progress when the project has no problem
 * phrasings. The refresh writes it and the page reads it, so the sentence lives
 * here once rather than as the same string in two files.
 */
export const NO_PHRASINGS_PROGRESS = "No problem phrasings to look up yet";

/**
 * The order a ranking thread is worth replying in. Discovery already judges
 * every thread it buys against this product, and since both sides ask Google
 * the one question, the threads Google ranks for a phrasing are the threads
 * discovery labelled. A thread nobody has judged sits above one judged to hold
 * nobody asking, because an unread thread is not a rejected one.
 */
export const VERDICT_ORDER: Relevance[] = ["relevant", "plausible", "unlabeled", "irrelevant"];

/** The same order as a SQL CASE, so the database sorts on what this file says. */
function verdictRank() {
  const arms = VERDICT_ORDER.map(
    (verdict, index) => sql`when ${verdict} then ${index + 1}`,
  );
  return sql<number>`min(case ${discoveryEvidence.relevance} ${sql.join(arms, sql` `)} else ${VERDICT_ORDER.length} end)`;
}

/** What this project has already judged each thread to be, best verdict kept. */
function verdicts(projectId: string) {
  return db()
    .select({ postId: discoveryEvidence.postId, rank: verdictRank().as("rank") })
    .from(discoveryEvidence)
    .where(eq(discoveryEvidence.projectId, projectId))
    .groupBy(discoveryEvidence.postId)
    .as("verdicts");
}

export type SeoRow = Awaited<ReturnType<typeof listOpportunities>>[number];

/**
 * What the tab hides, which is the only thing a filter does here. `closed` is
 * the one that hides anything by default, because a thread nobody can reply in
 * is not an opportunity; set it to "yes" to see them anyway.
 *
 * Nothing here says what order to read the rows in. Three of the four orders
 * the tab offers fold a score the database does not hold, so ordering happens
 * once, over the rows in hand, in `views.ts`.
 */
export type SeoFilter = {
  keyword?: string;
  subreddit?: string;
  competitor?: string;
  closed?: string;
};

/**
 * True when Reddit archived the thread or a moderator locked it: either one
 * closes it to new replies. An unknown flag is not a closed thread, so a null
 * on both sides reads as open, which is what the list has always shown.
 */
const closedThread = sql<boolean>`(coalesce(${redditPosts.isArchived}, false) or coalesce(${redditPosts.isLocked}, false))`;

/** The verdict one rank stands for, or null when nothing has judged the thread. */
export function verdictOf(rank: number | null): Relevance | null {
  const verdict = rank === null ? null : VERDICT_ORDER[rank - 1];
  return verdict && verdict !== "unlabeled" ? verdict : null;
}

export type SeoFacets = { keywords: string[]; subreddits: string[] };

/**
 * The Google search one phrasing was asked, written the way `googleQuery`
 * writes it. Expressed in SQL rather than imported so the snippet join can be
 * made against the phrasing on the row; `fetch.ts` opens a funded client on
 * import, and the read of a page has no business doing that.
 */
const googleQueryOf = sql`btrim(${seoOpportunities.keyword}) || ' reddit'`;

/**
 * What Google showed under this link for this phrasing. Discovery files one
 * evidence row per post per query and the table is unique on the three, so
 * matching the phrasing's own query joins at most one row: the snippet a
 * searcher actually read before clicking, not one from some other phrasing.
 */
const shown = aliasedTable(discoveryEvidence, "shown");

/** The account that posted, for the face and the two facts about it. */
const poster = aliasedTable(redditAuthors, "poster");

const columns = {
  id: seoOpportunities.id,
  keyword: seoOpportunities.keyword,
  position: seoOpportunities.position,
  competitorPresent: seoOpportunities.competitorPresent,
  refreshedAt: seoOpportunities.refreshedAt,
  postId: redditPosts.id,
  title: redditPosts.title,
  url: redditPosts.url,
  body: redditPosts.body,
  snippet: shown.snippet,
  subreddit: redditPosts.subreddit,
  subredditIconUrl: subreddits.iconUrl,
  subredditSubscribers: subreddits.subscribers,
  promoPolicy: subreddits.promoPolicy,
  rulesText: subreddits.rulesText,
  author: redditPosts.author,
  authorAvatarUrl: poster.avatarUrl,
  authorKarma: poster.karma,
  authorCreatedAt: poster.accountCreatedAt,
  score: redditPosts.score,
  numComments: redditPosts.numComments,
  createdAt: redditPosts.createdAt,
  closed: closedThread,
  /** Which of the two closed it, so a card can say why rather than only that. */
  isArchived: redditPosts.isArchived,
  isLocked: redditPosts.isLocked,
  /** This project's own judgement of the person posting, or null if none. */
  fit: leadEvaluations.fit,
  intent: leadEvaluations.intent,
};

/** The verdict this project holds on the post itself, never on a comment. */
function judgementOf(projectId: string) {
  return and(
    eq(leadEvaluations.projectId, projectId),
    eq(leadEvaluations.postId, seoOpportunities.postId),
    isNull(leadEvaluations.commentId),
  );
}

/**
 * The rule that hides a thread rather than ordering it: a closed one, unless
 * the reader asked to see them. Shared by the list and the facets, so a pill
 * never offers a phrasing whose threads the list will not show.
 */
function openOnly(filter: SeoFilter) {
  return filter.closed === "yes" ? [] : [eq(closedThread, false)];
}

/** Everything the pills narrow the list by. */
function conditions(filter: SeoFilter) {
  return [
    filter.keyword ? eq(seoOpportunities.keyword, filter.keyword) : undefined,
    filter.subreddit ? eq(sql`lower(${redditPosts.subreddit})`, filter.subreddit) : undefined,
    filter.competitor === "yes" ? eq(seoOpportunities.competitorPresent, true) : undefined,
    filter.competitor === "no" ? eq(seoOpportunities.competitorPresent, false) : undefined,
    ...openOnly(filter),
  ];
}

/**
 * Every ranking thread this project holds, keyword by keyword, the ones worth
 * replying in first and Google's own rank breaking the tie. It sorts rather
 * than hides: a thread with nobody asking in it still ranks, and one reply in
 * it still works, which is what this tab is for.
 *
 * This is the base order every view starts from and the tiebreak underneath
 * whichever order the reader asked for, never the last word on it.
 */
export async function listOpportunities(projectId: string, filter: SeoFilter) {
  await ensureSourcePolicyFresh();
  if (!isSourceAuthorized(SEO_READ_OP)) {
    return [];
  }
  const judged = verdicts(projectId);
  return db()
    .select({ ...columns, verdictRank: judged.rank })
    .from(seoOpportunities)
    .innerJoin(redditPosts, eq(redditPosts.id, seoOpportunities.postId))
    .leftJoin(subreddits, eq(subreddits.name, sql`lower(${redditPosts.subreddit})`))
    .leftJoin(poster, eq(poster.username, sql`lower(${redditPosts.author})`))
    .leftJoin(
      shown,
      and(
        eq(shown.projectId, projectId),
        eq(shown.postId, seoOpportunities.postId),
        eq(shown.query, googleQueryOf),
      ),
    )
    .leftJoin(judged, eq(judged.postId, seoOpportunities.postId))
    .leftJoin(leadEvaluations, judgementOf(projectId))
    .where(and(eq(seoOpportunities.projectId, projectId), ...conditions(filter)))
    .orderBy(
      asc(seoOpportunities.keyword),
      // A closed thread sorts after every open one, whichever order is asked
      // for, because no reply is possible in it.
      asc(closedThread),
      sql`coalesce(${judged.rank}, ${VERDICT_ORDER.indexOf("unlabeled") + 1})`,
      asc(seoOpportunities.position),
    );
}

/**
 * How many ranking threads this project holds. The rail's pill shows the
 * number, so it asks for the number rather than for every thread, its verdict
 * and its community on every page of the app.
 */
export async function countOpportunities(projectId: string): Promise<number> {
  await ensureSourcePolicyFresh();
  if (!isSourceAuthorized(SEO_READ_OP)) {
    return 0;
  }
  const rows = await db()
    .select({ total: count() })
    .from(seoOpportunities)
    // The same join the list makes, because a thread whose post has aged out
    // of our thirty days keeps its row with a null post and the list does not
    // show it. A count that included it would promise a thread that is gone,
    // and the same goes for a closed one, which the tab opens without.
    .innerJoin(redditPosts, eq(redditPosts.id, seoOpportunities.postId))
    .where(and(eq(seoOpportunities.projectId, projectId), ...openOnly({})));
  return rows[0]?.total ?? 0;
}

/**
 * The keywords and communities the filter pills can actually offer. It applies
 * the same rule the list does, so a phrasing whose only threads are closed is
 * not offered as a filter that would show nothing.
 */
export async function seoFacets(projectId: string, filter: SeoFilter = {}): Promise<SeoFacets> {
  await ensureSourcePolicyFresh();
  if (!isSourceAuthorized(SEO_READ_OP)) {
    return { keywords: [], subreddits: [] };
  }
  const rows = await db()
    .select({ keyword: seoOpportunities.keyword, subreddit: redditPosts.subreddit })
    .from(seoOpportunities)
    .innerJoin(redditPosts, eq(redditPosts.id, seoOpportunities.postId))
    .where(and(eq(seoOpportunities.projectId, projectId), ...openOnly(filter)));
  return {
    keywords: [...new Set(rows.map((row) => row.keyword))].sort(),
    subreddits: [...new Set(rows.map((row) => row.subreddit))].sort(),
  };
}

/**
 * One row as every view of the tab consumes it. The mapping lives beside the
 * columns it maps rather than in the page, so a view can be added without
 * copying a list of thirty field names to read the same rows.
 */
export function toThread(row: SeoRow): RankingThread {
  return {
    id: row.id,
    postId: row.postId,
    position: row.position,
    competitorPresent: row.competitorPresent,
    verdict: verdictOf(row.verdictRank),
    title: row.title,
    url: row.url,
    body: row.body,
    keyword: row.keyword,
    snippet: row.snippet,
    subreddit: row.subreddit,
    subredditIconUrl: row.subredditIconUrl,
    subredditSubscribers: row.subredditSubscribers,
    promoPolicy: row.promoPolicy,
    rulesText: row.rulesText,
    author: row.author,
    authorAvatarUrl: row.authorAvatarUrl,
    authorKarma: row.authorKarma,
    authorCreatedAt: row.authorCreatedAt,
    score: row.score,
    numComments: row.numComments,
    createdAt: row.createdAt,
    closed: row.closed,
    isArchived: row.isArchived,
    isLocked: row.isLocked,
    fit: row.fit,
    intent: row.intent,
    refreshedAt: row.refreshedAt,
  };
}
