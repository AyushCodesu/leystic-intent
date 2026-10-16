import { cache } from "react";
import { aliasedTable, and, asc, count, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  leadEvaluations,
  leads,
  painThemes,
  projects,
  redditAuthors,
  redditComments,
  redditPosts,
  searchRunPosts,
  subreddits,
  usageLedger,
} from "@/db/schema";
import { listMutes, redditLeadNotMuted } from "./mutes";
import { forgetProjectFeed } from "./projectFeedCache";
import { FEED_FLOOR_SQL, mentions, redditWordsWhere } from "./leadFilters";
import { atBounds, feedFilter } from "./feed";
import { LEAD_AUTHOR, LEAD_AUTHOR_JOIN, LEAD_BODY, LEAD_URL, NEED_AT, leadsBase } from "./leadSql";
import { STAGES } from "./scan/questions";
import { daysAgo } from "./time";

import type {
  FeedFacets,
  FeedFilter,
  FeedPage,
  FeedWindow,
  LeadCost,
  LeadFace,
  ReviewItem,
} from "./feed";

const postAuthors = aliasedTable(redditAuthors, "post_authors");

const feedColumns = {
  id: leads.id,
  score: leads.score,
  quality: leads.quality,
  fit: leads.fit,
  intent: leads.intent,
  engagement: leads.engagement,
  stage: leads.stage,
  reason: leads.reason,
  matchedPhrase: leads.matchedPhrase,
  status: leads.status,
  kind: leads.kind,
  outcome: leads.outcome,
  outcomeRecordedAt: leads.outcomeRecordedAt,
  outcomeNotes: leads.outcomeNotes,
  postId: leads.postId,
  title: redditPosts.title,
  subreddit: redditPosts.subreddit,
  postAuthor: redditPosts.author,
  postAuthorAvatar: postAuthors.avatarUrl,
  url: redditPosts.url,
  numComments: redditPosts.numComments,
  postScore: redditPosts.score,
  imageUrl: redditPosts.imageUrl,
  createdAt: redditPosts.createdAt,
  body: redditPosts.body,
  subredditIconUrl: subreddits.iconUrl,
  promoPolicy: subreddits.promoPolicy,
  rulesText: subreddits.rulesText,
  commentId: leads.commentId,
  commentPermalink: redditComments.permalink,
  bodyObservedAt: redditPosts.bodyObservedAt,
  commentsObservedAt: redditPosts.commentsObservedAt,
  commentBody: redditComments.body,
  commentAuthor: redditComments.author,
  commentScore: redditComments.score,
  commentCreatedAt: redditComments.createdAt,
  authorAvatar: redditAuthors.avatarUrl,
  authorKarma: redditAuthors.karma,
  authorCreatedAt: redditAuthors.accountCreatedAt,
  subredditWeeklyActive: subreddits.subscribers,
};

/** A whole lead, with its community and the two faces on it: the lead's author and the thread's. */
function feedQuery() {
  return leadsBase(feedColumns)
    .leftJoin(subreddits, eq(subreddits.name, sql`lower(${redditPosts.subreddit})`))
    .leftJoin(redditAuthors, LEAD_AUTHOR_JOIN)
    .leftJoin(postAuthors, eq(postAuthors.username, sql`lower(${redditPosts.author})`));
}

/** One lead as every read of the feed hands it over. */
export type FeedLead = Awaited<ReturnType<typeof feedQuery>>[number];

/**
 * The window rule the whole Leads page reads, feed and header sentence alike:
 * a row belongs to a window by the need date, not by when we looked at it.
 * Postgres wants the bound date as text when the column is a plain expression.
 * The `all` window is no bound at all, so the backfill's older finds are shown.
 */
export function newerThan(days: FeedWindow) {
  if (days === "all") {
    return undefined;
  }
  return sql`${NEED_AT} >= ${daysAgo(days).toISOString()}::timestamptz`;
}

/**
 * One slice of that window - a month, a day, an hour - clicked in the people
 * strip. Read on the same need date the window is, so a column of faces and
 * the list under it hold exactly the same leads.
 */
export function onAt(at: string | undefined) {
  if (!at) {
    return undefined;
  }
  const { start, end } = atBounds(at);
  return sql`${NEED_AT} >= ${start.toISOString()}::timestamptz and ${NEED_AT} < ${end.toISOString()}::timestamptz`;
}

/**
 * The project's own minimum score and word lists, applied when the feed is
 * read. Moving either on the Product page changes the next page load, with no
 * rescan and nothing deleted, because the judgement and the user's filters are
 * different facts.
 *
 * A new `context` thread is not shown: the scan stopped routing to that lane on
 * 2026-09-23, and one left from before is hidden rather than deleted. One the
 * user already resolved or hid stays where they put it, never measured
 * against the floor, since its score is the intent of someone who is not the
 * buyer and would always fall short.
 */
const OVER_THRESHOLD = sql`((${leads.kind} = 'buyer' AND ${leads.score} >= ${FEED_FLOOR_SQL} AND ${redditWordsWhere()}) OR (${leads.kind} = 'context' AND ${leads.status} <> 'new'))`;

/**
 * Whether the feed shows a lead on the tab its status puts it on: over that
 * floor and those word lists, and no mute on it. Insights groups and counts by
 * this too, so a theme holds leads its link can open. Needs `reddit_posts`, a
 * left-joined `reddit_comments` and `projects`.
 */
export function shownInFeed() {
  return and(OVER_THRESHOLD, redditLeadNotMuted());
}

/**
 * The lead ids one Insights theme holds. The theme owns the list, so narrowing
 * the feed to a theme is a membership test against that row and not a rescore.
 * The row is found by id: a label is model-written prose that two runs can
 * collide on or reword, and the card links by id.
 */
function leadIdsOfTheme(projectId: string, themeId: string) {
  return sql<string>`(
    select unnest(coalesce(${painThemes.leadIds}, '{}'))
    from ${painThemes}
    where ${painThemes.projectId} = ${projectId} and ${painThemes.id} = ${themeId}
  )`;
}

/** One set of filter pills, as SQL. Read by every query on this page. */
function feedWhere(projectId: string, filter: FeedFilter) {
  return and(
    eq(leads.projectId, projectId),
    eq(leads.status, filter.status),
    shownInFeed(),
    newerThan(filter.days),
    onAt(filter.at),
    filter.subreddit ? eq(sql`lower(${redditPosts.subreddit})`, filter.subreddit) : undefined,
    filter.stage ? eq(leads.stage, filter.stage) : undefined,
    filter.theme ? inArray(leads.id, leadIdsOfTheme(projectId, filter.theme)) : undefined,
  );
}

/** The best score any lead in the same thread holds, under the same pills. */
const THREAD_BEST = sql`max(${leads.score}) over (partition by ${leads.postId})`;

/** The newest need in that thread, which settles two threads on one score. */
const THREAD_NEWEST = sql`max(${NEED_AT}) over (partition by ${leads.postId})`;

/**
 * The feed's order: the best thread first, and a thread's leads together. A
 * post and three of its comments can each be a lead, and ordered by their own
 * scores they were four rows under one title with the post itself last. So a
 * thread sits where its best lead earns it, the post leads it, and its
 * comments follow best first.
 *
 * The id decides nothing a person can see; it is there because two leads can
 * hold the same score and the same minute, and a page boundary that falls
 * between them would otherwise show one of them twice and the other never.
 */
const FEED_ORDER = [
  desc(THREAD_BEST),
  desc(THREAD_NEWEST),
  asc(leads.postId),
  asc(sql`${leads.commentId} is not null`),
  desc(leads.score),
  desc(NEED_AT),
  asc(leads.id),
];

/**
 * The feed, best first, for one set of filter pills. A page is a slice of that
 * order; without one the whole feed is read, which is what the alerts digest
 * and the API want and what the page itself no longer asks for.
 */
export async function listLeads(
  projectId: string,
  filter: FeedFilter,
  page?: FeedPage,
): Promise<FeedLead[]> {
  const query = feedQuery()
    .where(feedWhere(projectId, filter))
    .orderBy(...FEED_ORDER);
  return page ? query.limit(page.limit).offset(page.offset) : query;
}

/** How many leads those pills hold, which is what the list column counts. */
export async function countLeads(projectId: string, filter: FeedFilter): Promise<number> {
  const rows = await leadsBase({ total: count() }).where(feedWhere(projectId, filter));
  return rows[0]?.total ?? 0;
}

/**
 * The leads a link to each Insights theme opens the feed on. The link sets no
 * pill but the theme, so the feed opens on the theme's new leads written in
 * the last 30 days, or in all time when none of them is that recent, as Feed
 * does with a window nobody chose. A card counts and puts faces to these, so
 * the number on it is the number of rows its link shows.
 */
export async function themeLinkLeads(
  projectId: string,
  themes: { id: string; leadIds: string[] }[],
): Promise<Map<string, string[]>> {
  const ids = themes.flatMap((theme) => theme.leadIds);
  const opened = feedFilter({});
  const rows =
    ids.length === 0
      ? []
      : await db()
          .select({ id: leads.id, recent: sql<boolean>`${newerThan(opened.days) ?? sql`true`}` })
          .from(leads)
          .innerJoin(redditPosts, eq(redditPosts.id, leads.postId))
          .leftJoin(redditComments, eq(redditComments.id, leads.commentId))
          .innerJoin(projects, eq(projects.id, leads.projectId))
          .where(and(feedWhere(projectId, { ...opened, days: "all" }), inArray(leads.id, ids)));
  const shown = new Set(rows.map((row) => row.id));
  const recent = new Set(rows.filter((row) => row.recent).map((row) => row.id));
  return new Map(
    themes.map((theme) => {
      const inWindow = theme.leadIds.filter((id) => recent.has(id));
      return [theme.id, inWindow.length > 0 ? inWindow : theme.leadIds.filter((id) => shown.has(id))];
    }),
  );
}

/**
 * Every person the window holds, for the strip of faces over the feed. The
 * strip is a calendar of who asked and when, so it stays whole while the list
 * under it is read a page at a time; this reads the six columns a face needs
 * and none of the prose a row does.
 */
export async function listLeadFaces(projectId: string, filter: FeedFilter): Promise<LeadFace[]> {
  return leadsBase({
    id: sql<string>`'lead-' || ${leads.id}`,
    at: sql`${NEED_AT}`.mapWith(redditPosts.createdAt),
    score: leads.score,
    author: LEAD_AUTHOR,
    avatarUrl: redditAuthors.avatarUrl,
    subreddit: redditPosts.subreddit,
  })
    .leftJoin(redditAuthors, LEAD_AUTHOR_JOIN)
    .where(feedWhere(projectId, filter))
    .orderBy(...FEED_ORDER);
}

/**
 * One lead by its own id, whatever page of the feed it sits on. Clicking the
 * fortieth row asks the server for a thread the first page never held, and the
 * pane has to open on it rather than falling back to the best lead.
 */
export async function findLead(projectId: string, leadId: string): Promise<FeedLead | undefined> {
  const rows = await feedQuery().where(
    and(eq(leads.projectId, projectId), eq(leads.id, leadId)),
  );
  return rows[0];
}

/**
 * The candidates the scan held back because the evidence did not settle them.
 * They are not leads and never enter the feed count, but they are the seven or
 * so items per scan that a person can settle in a glance. A thread that is
 * already a lead for this project is never listed twice: a later rerun holding
 * it does not undo the earlier call.
 */
export async function listReviewItems(
  projectId: string,
  days: FeedWindow,
  at?: string,
): Promise<ReviewItem[]> {
  const rows = await db()
    .select({
      id: leadEvaluations.id,
      title: redditPosts.title,
      subreddit: redditPosts.subreddit,
      url: LEAD_URL,
      author: LEAD_AUTHOR,
      avatarUrl: redditAuthors.avatarUrl,
      authorKarma: redditAuthors.karma,
      authorCreatedAt: redditAuthors.accountCreatedAt,
      subredditIconUrl: subreddits.iconUrl,
      numComments: redditPosts.numComments,
      points: sql<number | null>`coalesce(${redditComments.score}, ${redditPosts.score})`,
      isComment: sql<boolean>`${leadEvaluations.commentId} is not null`,
      reason: leadEvaluations.reason,
      reasonCodes: leadEvaluations.reasonCodes,
      fit: leadEvaluations.fit,
      intent: leadEvaluations.intent,
      needState: leadEvaluations.needState,
      createdAt: sql`${NEED_AT}`.mapWith(redditPosts.createdAt),
      judgedAt: leadEvaluations.judgedAt,
    })
    .from(leadEvaluations)
    .innerJoin(redditPosts, eq(redditPosts.id, leadEvaluations.postId))
    .leftJoin(redditComments, eq(redditComments.id, leadEvaluations.commentId))
    .leftJoin(subreddits, eq(subreddits.name, sql`lower(${redditPosts.subreddit})`))
    .leftJoin(redditAuthors, LEAD_AUTHOR_JOIN)
    .where(
      and(
        eq(leadEvaluations.projectId, projectId),
        eq(leadEvaluations.decision, "review"),
        newerThan(days),
        onAt(at),
        notExists(
          db()
            .select({ one: sql`1` })
            .from(leads)
            .where(
              and(
                eq(leads.projectId, leadEvaluations.projectId),
                eq(leads.postId, leadEvaluations.postId),
                sql`${leads.commentId} is not distinct from ${leadEvaluations.commentId}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(leadEvaluations.judgedAt));
  return rows;
}

/** Where a stage sits in the buying journey; one the judge no longer names goes last. */
function stageRank(stage: string): number {
  const rank = (STAGES as readonly string[]).indexOf(stage);
  return rank === -1 ? STAGES.length : rank;
}

/**
 * The subreddits and stages this project actually has leads in. Each pair is
 * read once rather than once per lead; a subreddit can still come back with
 * several stages, so each list is made unique again. Subreddits are in name
 * order and stages in journey order, so neither list moves when a lead lands.
 */
export async function feedFacets(projectId: string): Promise<FeedFacets> {
  const rows = await db()
    .selectDistinct({ subreddit: redditPosts.subreddit, stage: leads.stage })
    .from(leads)
    .innerJoin(redditPosts, eq(redditPosts.id, leads.postId))
    .where(eq(leads.projectId, projectId));
  return {
    subreddits: [...new Set(rows.map((row) => row.subreddit))].sort(),
    stages: [...new Set(rows.map((row) => row.stage).filter((stage): stage is string => !!stage))].sort(
      (a, b) => stageRank(a) - stageRank(b),
    ),
  };
}

/** A lead the word lists keep out, with the rule that does it. */
export type HiddenLead = {
  id: string;
  title: string;
  url: string;
  score: number;
  /** Why: "mentions “hiring”", "in muted r/forhire", or "mentions none of the required words". */
  because: string;
};

/** How many hidden leads the Filters page names; past this it only counts them. */
const HIDDEN_SHOWN = 8;

/**
 * Of the month's new buyer leads over the minimum score, how many the words
 * and mutes keep out, and the best of them by name with what does it, so an
 * owner can see a list catching a real buyer before trusting it: a muted word
 * a buyer mentions in passing hides them as surely as an unrelated thread.
 */
export async function wordsHidden(
  projectId: string,
): Promise<{ hidden: number; total: number; leads: HiddenLead[] }> {
  const month = and(
    eq(leads.projectId, projectId),
    eq(leads.status, "new"),
    eq(leads.kind, "buyer"),
    sql`${leads.score} >= ${FEED_FLOOR_SQL}`,
    newerThan(30),
  );
  const kept = sql`(${redditWordsWhere()} and ${redditLeadNotMuted()})`;
  const [counts, rows, mutes] = await Promise.all([
    leadsBase({
      total: count(),
      kept: sql<number>`count(*) filter (where ${kept})`.mapWith(Number),
    }).where(month),
    leadsBase({
      id: leads.id,
      title: redditPosts.title,
      body: LEAD_BODY,
      url: redditPosts.url,
      score: leads.score,
      subreddit: redditPosts.subreddit,
    })
      .where(and(month, sql`not ${kept}`))
      .orderBy(desc(leads.score), desc(leads.foundAt))
      .limit(HIDDEN_SHOWN),
    listMutes(projectId),
  ]);
  const total = counts[0]?.total ?? 0;
  return {
    hidden: total - (counts[0]?.kept ?? 0),
    total,
    leads: rows.map((row) => {
      const text = `${row.title} ${row.body ?? ""}`;
      const word = mutes.find((mute) => mute.kind === "keyword" && mentions(text, mute.value));
      const community = mutes.find((mute) => mute.kind === "subreddit" && mute.value === row.subreddit.toLowerCase());
      return {
        id: row.id,
        title: row.title,
        url: row.url,
        score: row.score,
        because: word
          ? `mentions “${word.value}”`
          : community
            ? `in muted r/${community.value}`
            : "mentions none of the required words",
      };
    }),
  };
}

/**
 * New leads the feed would show, whatever their age, for the rail's badge.
 * Read once per server render (see currentLocalUser): the first sweep's line
 * over the feed counts the same thing.
 */
export const newLeadCount = cache(async (projectId: string): Promise<number> => {
  const rows = await leadsBase({ total: count() }).where(
    and(eq(leads.projectId, projectId), eq(leads.status, "new"), OVER_THRESHOLD, redditLeadNotMuted()),
  );
  return rows[0]?.total ?? 0;
});

/**
 * What this project paid to have each post in front of it: the first ledger
 * line against a run that produced the post, preferring the paid fetch over the
 * reuse that followed it.
 */
export async function leadCosts(
  projectId: string,
  postIds: string[],
): Promise<Map<string, LeadCost>> {
  if (postIds.length === 0) {
    return new Map();
  }
  const rows = await db()
    .select({
      postId: searchRunPosts.postId,
      sku: usageLedger.sku,
      costUsd: usageLedger.costUsd,
      requestId: usageLedger.requestId,
      reused: usageLedger.reused,
      at: usageLedger.at,
    })
    .from(usageLedger)
    .innerJoin(searchRunPosts, eq(searchRunPosts.searchRunId, usageLedger.searchRunId))
    .where(and(eq(usageLedger.projectId, projectId), inArray(searchRunPosts.postId, postIds)))
    .orderBy(asc(usageLedger.reused), asc(usageLedger.at));
  const byPost = new Map<string, LeadCost>();
  for (const row of rows) {
    if (!byPost.has(row.postId)) {
      byPost.set(row.postId, {
        sku: row.sku,
        costUsd: Number(row.costUsd),
        requestId: row.requestId,
      });
    }
  }
  return byPost;
}

/** Whether this project holds a lead in the named community. */
export async function leadInSubreddit(projectId: string, subreddit: string): Promise<boolean> {
  const rows = await db()
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(redditPosts, eq(redditPosts.id, leads.postId))
    .where(
      and(
        eq(leads.projectId, projectId),
        eq(sql`lower(${redditPosts.subreddit})`, subreddit.trim().toLowerCase()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Moves a lead out of the feed, recording why when the user says it is a miss. */
export async function setLeadStatus(
  projectId: string,
  leadId: string,
  status: FeedFilter["status"],
  notFitReason: string | null,
): Promise<void> {
  await db()
    .update(leads)
    .set({ status, notFitReason })
    .where(and(eq(leads.id, leadId), eq(leads.projectId, projectId)));
  forgetProjectFeed(projectId);
}

/**
 * Records a user-confirmed business outcome for a lead:
 * 'replied' | 'meeting_booked' | 'opportunity' | 'customer' | 'not_fit'.
 */
export async function recordLeadOutcome(
  projectId: string,
  leadId: string,
  outcome: string,
  outcomeNotes: string | null = null,
): Promise<void> {
  await db()
    .update(leads)
    .set({
      outcome,
      outcomeRecordedAt: new Date(),
      outcomeNotes,
    })
    .where(and(eq(leads.id, leadId), eq(leads.projectId, projectId)));
  forgetProjectFeed(projectId);
}
