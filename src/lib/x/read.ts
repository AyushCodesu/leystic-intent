import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { handledThreads, jobs, projects, xAuthors, xEvaluations, xLanes, xLeads, xPosts, xProjects, xRuns } from "@/db/schema";
import { xShownWhere, xWordsWhere } from "@/lib/leadFilters";
import { atBounds, grainOf, type LeadFace } from "@/lib/feed";
import { nextQueuedJob } from "@/jobs/enqueue";
import { HOUR_MS, daysAgo, utcDayStart } from "@/lib/time";
import {
  CLOSE_CALL_FIT,
  CLOSE_CALL_INTENT,
  FEED_WINDOW_DAYS,
  FILTERED_LIST_LIMIT,
  FILTERED_WORTH_SCORE,
  FIRST_LOOK_HOURS,
  PENDING_STAGES,
} from "./constants";
import { notMuted, xLeadNotMuted } from "@/lib/mutes";
import { canonicalUrl, ownWords } from "./map";
import { xQuiet, type XQuiet } from "./quiet";
import { reachScore, replyWindowOpen } from "./reach";
import type { XVia } from "./store";
import { rankXOpportunities } from "./priority";

/** What the X tab reads. Nothing here joins a Reddit table. The project's own filters (lib/leadFilters.ts) hold here as on Reddit. */

/**
 * The windows the X tab offers, in the Leads tab's own words. The first look
 * fills the month; an X lead is freshest in hours, so the list still puts the
 * newest first and marks the rest older.
 */
export const X_WINDOWS = [1, 7, 30] as const;
export type XWindow = (typeof X_WINDOWS)[number];
/** Replied is the user's own mark: they answered it on X, so it leaves New without being called a miss. */
export const X_STATUSES = ["new", "replied", "hidden", "not_fit"] as const;
export type XStatusFilter = (typeof X_STATUSES)[number];

export type XFeedFilter = { days: XWindow; status: XStatusFilter; at?: string };

/** What the pane shows beside a post: who wrote it, what it drew, and which search found it. */
type XCardCommon = {
  entryId: string;
  tweetId: string;
  url: string;
  text: string;
  /** The line a row and the pane are headed by: the ask itself, or the post's opening. */
  headline: string;
  authorUsername: string;
  authorName: string | null;
  authorImage: string | null;
  authorFollowers: number | null;
  /** X's check mark: a paid Premium subscription today, shown as a fact, never a ranking signal (it did not separate good posts, 2026-09-28). */
  authorVerified: boolean | null;
  /** The place the author's profile names, as they wrote it. */
  authorLocation: string | null;
  authorBio: string | null;
  authorCreatedAt: Date | null;
  postedAt: Date;
  /** When X gave the counts below: they are that moment's, not now's. */
  fetchedAt: Date;
  likeCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  isReply: boolean;
  replyingTo: string[];
  /** The phrase of the search that found it, as the post wrote it. */
  foundBy: string | null;
  /** The reply in its thread that led lurk to it, when its own words did not match the search. */
  via: (XVia & { url: string }) | null;
  reason: string | null;
  fit: number | null;
  intent: number | null;
  /** Freshness and room, 0-4, as the judge scored it; null when it was never judged. */
  engagement: number | null;
};

export type XLeadCard = XCardCommon & {
  id: string;
  /** ask: someone asking for what the product does; reply: a post worth answering where nobody is shopping. */
  kind: "ask" | "reply";
  /** For a reply, what kind of place it is (reply.ts REPLY_MOMENTS); null for an ask. */
  moment: string | null;
  /** How much a reply now would be seen, 0-100 (reach.ts): replies are listed by it. */
  reach: number;
  /** Whether the post is still inside the reply window. */
  fresh: boolean;
  foundAt: Date;
  score: number;
  quote: string | null;
  status: string;
  /** The conversation it sits in, or the post itself: one author's lead per conversation (write.ts writeLead). */
  conversationId: string;
};

export type XHeldCard = XCardCommon & {
  evaluationId: string;
  reasonCode: string | null;
};

/**
 * How a post came to be left out: `judged`, read by the judge and turned away;
 * `screened`, set aside by the free screen's rules before the judge read it;
 * `unfinished`, passed the judge's first read but aged out before lurk could
 * finish checking it (run.ts expireStale).
 */
export type XFilteredKind = "judged" | "screened" | "unfinished";

/**
 * Where a left-out post sits in the list: `worth`, unfinished, a close call or
 * judged out while still scoring high; `judged`, the rest the judge read;
 * `rule`, set aside by the free screen and never scored.
 */
export type XFilteredBand = "worth" | "judged" | "rule";

export type XFilteredCard = XCardCommon & {
  evaluationId: string;
  kind: XFilteredKind;
  band: XFilteredBand;
  /** The judge's 0-100 score (gates.ts foldScore); for a screened post, the read rescore.ts gave it after; null for one never read. */
  score: number | null;
  /** The judge's reason code, or the screen rule that dropped it. */
  code: string | null;
  /** Judged out, but its fit and intent would still rank it as a lead (constants.ts). */
  closeCall: boolean;
  /** The judge sent it to the reply check too, and the model said it was not worth a reply. */
  replyChecked: boolean;
};

export type XFiltered = {
  items: XFilteredCard[];
  /** Everything left out in the window, of which `items` is the first FILTERED_LIST_LIMIT. */
  judged: number;
  screened: number;
  unfinished: number;
  closeCalls: number;
  /** Everything in the worth-a-look band: unfinished, close calls and high-scoring judged-out posts. */
  worth: number;
  /** Posts from the window lurk is still reading, in no group yet. */
  pending: number;
};

function viaOf(context: unknown): XCardCommon["via"] {
  const via = (context as { via?: Partial<XVia> } | null)?.via;
  return via && typeof via.tweetId === "string" && typeof via.author === "string"
    ? {
        tweetId: via.tweetId,
        author: via.author,
        phrase: typeof via.phrase === "string" ? via.phrase : null,
        url: canonicalUrl(via.author, via.tweetId),
      }
    : null;
}

function replyingToOf(context: unknown): string[] {
  const list = (context as { replyingTo?: unknown } | null)?.replyingTo;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/** A post's headline: the sentence the verdict rests on, or its own first line. */
export function headlineOf(text: string, isReply: boolean, quote: string | null): string {
  if (quote) {
    return quote;
  }
  const words = ownWords({ text, isReply }).replace(/https?:\/\/\S+/gu, "").trim();
  const first = words.split(/(?<=[.!?])\s|\n/u)[0]?.trim() || words;
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/** The slice filter, or the window's start when no slice is picked. */
function whenWhere(filter: XFeedFilter) {
  if (filter.at && grainOf(filter.at)) {
    const { start, end } = atBounds(filter.at);
    return and(gte(xPosts.createdAt, start), lt(xPosts.createdAt, end));
  }
  return gte(xPosts.createdAt, daysAgo(filter.days));
}

const authorJoin = sql`lower(${xPosts.authorUsername}) = ${xAuthors.username}`;

function common(
  entryId: string,
  post: typeof xPosts.$inferSelect,
  author: typeof xAuthors.$inferSelect | null,
  context: unknown,
  foundBy: string | null,
  quote: string | null,
): XCardCommon {
  return {
    entryId,
    tweetId: post.id,
    url: canonicalUrl(post.authorUsername, post.id),
    text: post.text,
    // A post that is only an image or a link has no words to head it.
    headline:
      headlineOf(post.text, post.isReply, quote) ||
      ((post.mediaCount ?? 0) > 0 ? `An image @${post.authorUsername} posted, with no words` : `A link @${post.authorUsername} posted, with no words`),
    authorUsername: post.authorUsername,
    authorName: post.authorName ?? author?.name ?? null,
    authorImage: post.authorImage,
    authorFollowers: author?.followers ?? post.authorFollowers,
    authorVerified: author?.verified ?? post.authorVerified,
    authorLocation: author?.location?.trim() || null,
    authorBio: author?.bio ?? null,
    authorCreatedAt: author?.accountCreatedAt ?? null,
    postedAt: post.createdAt,
    fetchedAt: post.fetchedAt,
    likeCount: post.likeCount,
    replyCount: post.replyCount,
    viewCount: post.viewCount,
    isReply: post.isReply,
    replyingTo: replyingToOf(context),
    foundBy,
    via: viaOf(context),
    reason: null,
    fit: null,
    intent: null,
    engagement: null,
  };
}

/**
 * The project's leads in the filter: asks newest first, replies by how much a
 * reply now would be seen (reach and what is left of the reply window), since
 * a reply-worthy post is worth most while people are still reading it. Hidden
 * and not-a-fit leads are their own statuses.
 */
function leadRows() {
  return db()
    .select({ lead: xLeads, post: xPosts, author: xAuthors, context: xEvaluations.context, foundBy: xEvaluations.matchedPhrase })
    .from(xLeads)
    .innerJoin(xPosts, eq(xPosts.id, xLeads.tweetId))
    .innerJoin(projects, eq(projects.id, xLeads.projectId))
    .leftJoin(xAuthors, authorJoin)
    .leftJoin(xEvaluations, and(eq(xEvaluations.projectId, xLeads.projectId), eq(xEvaluations.tweetId, xLeads.tweetId)));
}

type LeadRow = Awaited<ReturnType<typeof leadRows>>[number];

function leadCard({ lead, post, author, context, foundBy }: LeadRow, now: Date): XLeadCard {
  return {
    ...common(`lead-${lead.id}`, post, author, context, foundBy, lead.matchedPhrase),
    id: lead.id,
    kind: lead.kind === "reply" ? "reply" : "ask",
    moment: lead.kind === "reply" ? lead.moment : null,
    reach: reachScore(post, now),
    fresh: replyWindowOpen(post.createdAt, now),
    foundAt: lead.foundAt,
    score: lead.score,
    fit: lead.fit,
    intent: lead.intent,
    engagement: lead.engagement,
    reason: lead.reason,
    quote: lead.matchedPhrase,
    status: lead.status,
    conversationId: lead.conversationId ?? lead.tweetId,
  };
}

export async function listXLeads(
  projectId: string,
  filter: XFeedFilter = { days: FEED_WINDOW_DAYS, status: "new" },
  now = new Date(),
  /** Null for every one in the filter: History counts and dates them all before its own cap. */
  limit: number | null = 200,
): Promise<XLeadCard[]> {
  const query = leadRows()
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.status, filter.status), isNull(xPosts.unavailableAt), whenWhere(filter), xShownWhere(), xLeadNotMuted()))
    .orderBy(desc(xPosts.createdAt), desc(xLeads.score));
  const rows = limit === null ? await query : await query.limit(limit);
  const cards = rows.map((row) => leadCard(row, now));
  const asks = cards.filter((card) => card.kind === "ask");
  const replies = cards.filter((card) => card.kind === "reply").sort((a, b) => b.reach - a.reach || b.score - a.score);
  return [...asks, ...replies];
}

/**
 * One of the project's leads whatever its status or age, for the pane: a lead
 * just marked replied, hidden or not a fit leaves the list but stays open.
 */
export async function xLeadById(projectId: string, leadId: string, now = new Date()): Promise<XLeadCard | null> {
  const [row] = await leadRows()
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.id, leadId), isNull(xPosts.unavailableAt)))
    .limit(1);
  return row ? leadCard(row, now) : null;
}

/** The pile held for a look: posts the judge could not settle, from the window. */
export async function listXHeld(projectId: string, filter: XFeedFilter = { days: FEED_WINDOW_DAYS, status: "new" }): Promise<XHeldCard[]> {
  const rows = await evaluationRows()
    .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.stage, "review"), isNull(xPosts.unavailableAt), whenWhere(filter)))
    .orderBy(desc(xPosts.createdAt))
    .limit(100);
  return rows.map(heldCard);
}

const closeCallSql = sql<boolean>`(${xEvaluations.stage} = 'rejected' and ${xEvaluations.fit} >= ${CLOSE_CALL_FIT} and ${xEvaluations.intent} >= ${CLOSE_CALL_INTENT})`;
/** Passed the search-level judge (qualify or review), then expired before the complete level. */
const unfinishedSql = sql`(${xEvaluations.stage} = 'expired' and ${xEvaluations.decision} in ('qualify', 'review'))`;
const filteredSql = sql`(${xEvaluations.stage} in ('rejected', 'free_rejected') or ${unfinishedSql})`;
const worthSql = sql<boolean>`(${unfinishedSql} or ${closeCallSql} or (${xEvaluations.stage} = 'rejected' and ${xEvaluations.score} >= ${FILTERED_WORTH_SCORE}))`;

/**
 * The screen's rules, the ones likeliest to have set aside a real person
 * first: "no match" dropped real asks whose words sat sentences apart, while a
 * reply farm, crypto or an ad is almost never one.
 */
const RULE_ORDER = [
  "no_visible_term",
  "stale",
  "too_long",
  "listicle",
  "bare_link",
  "other_language",
  "vendor_hook",
  "vendor_launch",
  "job_or_gig",
  "own_or_rival_account",
  "reply_farm",
  "machine_query",
  "trading_or_crypto",
  "vendor_promo",
];
const ruleRankSql = sql`coalesce(array_position(array[${sql.join(
  RULE_ORDER.map((rule) => sql`${rule}`),
  sql`, `,
)}]::text[], split_part(${xEvaluations.freeReject}, ':', 1)), ${RULE_ORDER.length + 1})`;

/** An evaluation with its post and author, for the Held and Filtered out groups. */
function evaluationRows() {
  return db()
    .select({ evaluation: xEvaluations, post: xPosts, author: xAuthors, closeCall: closeCallSql, worth: worthSql })
    .from(xEvaluations)
    .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
    .leftJoin(xAuthors, authorJoin);
}

type EvaluationRow = Awaited<ReturnType<typeof evaluationRows>>[number];

function heldCard({ evaluation, post, author }: EvaluationRow): XHeldCard {
  return {
    ...common(`held-${evaluation.id}`, post, author, evaluation.context, evaluation.matchedPhrase, evaluation.needQuote),
    evaluationId: evaluation.id,
    reason: evaluation.reason,
    reasonCode: evaluation.reasonCode,
    fit: evaluation.fit,
    intent: evaluation.intent,
    engagement: evaluation.engagement,
  };
}

function filteredCard({ evaluation, post, author, closeCall, worth }: EvaluationRow): XFilteredCard {
  const kind: XFilteredKind =
    evaluation.stage === "free_rejected" ? "screened" : evaluation.stage === "expired" ? "unfinished" : "judged";
  const band: XFilteredBand = kind === "screened" ? "rule" : worth ? "worth" : "judged";
  // Only a check the model answered says no; a candidate settled unchecked
  // (too old, the product's own thread, replies off) keeps a bare code.
  const reply = (evaluation.signals as { reply?: { code?: unknown } } | null)?.reply;
  return {
    ...common(`filtered-${evaluation.id}`, post, author, evaluation.context, evaluation.matchedPhrase, kind === "screened" ? null : evaluation.needQuote),
    evaluationId: evaluation.id,
    kind,
    band,
    score: evaluation.score,
    code: kind === "screened" ? (evaluation.freeReject?.split(":")[0] ?? null) : evaluation.reasonCode,
    closeCall: Boolean(closeCall),
    replyChecked: kind === "judged" && reply?.code === "not_reply_worthy",
    reason: evaluation.reason,
    fit: evaluation.fit,
    intent: evaluation.intent,
    engagement: evaluation.engagement,
  };
}

/**
 * What the scan left out in the window, so the tab can show what it read and
 * the user can check its calls, in three bands: worth a look (unfinished,
 * then close calls, then judged out while still scoring FILTERED_WORTH_SCORE
 * or more), the rest the judge turned away by score, then posts the free
 * screen set aside, the rules likeliest to have caught a real person first,
 * then by the score rescore.ts gave them, then the most viewed. Held posts are their own group; posts
 * still being read are only counted. The screen's rule is kept before any `:`
 * detail.
 */
export async function listXFiltered(projectId: string, filter: XFeedFilter = { days: FEED_WINDOW_DAYS, status: "new" }): Promise<XFiltered> {
  const inWindow = and(eq(xEvaluations.projectId, projectId), isNull(xPosts.unavailableAt), whenWhere(filter));
  const [counts] = await db()
    .select({
      judged: sql<number>`count(*) filter (where ${xEvaluations.stage} = 'rejected')::int`,
      screened: sql<number>`count(*) filter (where ${xEvaluations.stage} = 'free_rejected')::int`,
      unfinished: sql<number>`count(*) filter (where ${unfinishedSql})::int`,
      closeCalls: sql<number>`count(*) filter (where ${closeCallSql})::int`,
      worth: sql<number>`count(*) filter (where ${worthSql})::int`,
      pending: sql<number>`count(*) filter (where ${inArray(xEvaluations.stage, PENDING_STAGES)})::int`,
    })
    .from(xEvaluations)
    .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
    .where(and(inWindow, or(filteredSql, inArray(xEvaluations.stage, PENDING_STAGES))));
  const rows = await evaluationRows()
    .where(and(inWindow, filteredSql))
    .orderBy(
      asc(sql`case when ${worthSql} then 0 when ${xEvaluations.stage} = 'rejected' then 1 else 2 end`),
      desc(sql`coalesce(${unfinishedSql}, false)`),
      desc(closeCallSql),
      // A screened post's score was read without the author's bio, and the
      // high ones were mostly vendors the rule rightly caught (a rival's
      // founder replying "compare here", a form builder's own pitches), so
      // within the rule band the rule still leads and the score only orders
      // posts under the same rule.
      asc(sql`case when ${xEvaluations.stage} = 'free_rejected' then ${ruleRankSql} else 0 end`),
      sql`${xEvaluations.score} desc nulls last`,
      sql`${xEvaluations.fit} desc nulls last`,
      sql`${xEvaluations.intent} desc nulls last`,
      sql`${xPosts.viewCount} desc nulls last`,
      desc(xPosts.createdAt),
    )
    .limit(FILTERED_LIST_LIMIT);
  return {
    items: rows.map(filteredCard),
    judged: counts?.judged ?? 0,
    screened: counts?.screened ?? 0,
    unfinished: counts?.unfinished ?? 0,
    closeCalls: counts?.closeCalls ?? 0,
    worth: counts?.worth ?? 0,
    pending: counts?.pending ?? 0,
  };
}

export type XEvaluationEntry =
  | { kind: "held"; item: XHeldCard }
  | { kind: "filtered"; item: XFilteredCard }
  | { kind: "lead"; lead: XLeadCard };

export type XOpportunity = { entry: XEvaluationEntry; priority: number | null; checks: string[]; notes?: string[] };
/**
 * `items` is the top of the ranked stream, leads first. `faces` covers the
 * whole window, not only the cards the cap kept: in New every ask, as the
 * scan's own line counts them, and in History every card.
 */
export type XOpportunityFeed = {
  items: XOpportunity[];
  total: number;
  posts: number;
  /** New only: asks and posts worth a reply among `total`, which come first in `items`. */
  leads?: number;
  replies?: number;
  faces: LeadFace[];
};

/** The most cards New lists; the strip and the count still cover the whole ranked window. */
const OPPORTUNITY_LIST_LIMIT = 200;

export function xOpportunityCard(entry: XEvaluationEntry): XLeadCard | XHeldCard | XFilteredCard {
  return entry.kind === "lead" ? entry.lead : entry.item;
}

/** Stages a held card stands for: unsettled, or a judged post that lost its author's conversation to a sibling (write.ts writeLead). */
const HELD_STAGES = ["review", "pending_context", "pending_reply", "merged"];

function opportunityFace(id: string, at: Date, priority: number | null, author: string, avatarUrl: string | null): LeadFace {
  return { id, at, score: Math.round(100 * (priority ?? 0)), author, avatarUrl, subreddit: "", label: `@${author} on X`, plainAvatar: true };
}

/**
 * A post New can rank from its stored evidence alone, with no lead row: the
 * one rule New and Replied history share. Requires xLeads joined on the post.
 */
function evidenceWhere(includeReplies: boolean, actedOn = true) {
  return and(
    isNull(xLeads.id),
    or(
      inArray(xEvaluations.stage, ["review", "rejected", "free_rejected"]),
      unfinishedSql,
      and(inArray(xEvaluations.stage, ["pending_context", "pending_reply"]), isNotNull(xEvaluations.signals)),
      // The legacy score picked which of an author's posts in a conversation
      // became the lead; the loser's evidence still competes here.
      and(eq(xEvaluations.stage, "merged"), includeReplies ? undefined : sql`${xEvaluations.reasonCode} is distinct from 'worth_reply'`),
    ),
    // The author's lead in this conversation was hidden, called a miss or
    // answered: none of their other posts in it come back through evidence.
    // History instead drops a post only for a lead it actually lists.
    !actedOn ? undefined : sql`not exists (select 1 from ${xLeads} s where s.project_id = ${xEvaluations.projectId}
      and lower(s.author_username) = lower(${xPosts.authorUsername}) and s.conversation_id = coalesce(${xPosts.conversationId}, ${xPosts.id})
      and s.status <> 'new')`,
  );
}

/** One author in one conversation, as writeLead keeps a single lead for. */
function threadOf(author: string, conversation: string): string {
  return `${author.toLowerCase()} ${conversation}`;
}

/** A Replied mark on the post's conversation or on the post itself: New hides by it, Replied history lists by it. */
const handledSql = sql`(select 1 from ${handledThreads} h where h.project_id = ${xEvaluations.projectId}
  and h.platform = 'x' and (h.thread_id = ${xPosts.conversationId} or h.thread_id = ${xPosts.id}))`;

/**
 * Posts with no lead row whose conversation the owner marked replied, for
 * Replied history, newest first: a card New ranked from evidence and Replied
 * took away is found and taken back here. Nothing is qualified or written.
 * Each comes with its author and conversation, so History can leave out one
 * whose author's lead there it already lists.
 */
async function listXRepliedEvidence(projectId: string, filter: XFeedFilter, includeReplies: boolean): Promise<{ entry: XEvaluationEntry; thread: string }[]> {
  const rows = await db()
    .select({ evaluation: xEvaluations, post: xPosts, author: xAuthors, closeCall: closeCallSql, worth: worthSql })
    .from(xEvaluations)
    .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
    .innerJoin(projects, eq(projects.id, xEvaluations.projectId))
    .leftJoin(xAuthors, authorJoin)
    .leftJoin(xLeads, and(eq(xLeads.projectId, xEvaluations.projectId), eq(xLeads.tweetId, xEvaluations.tweetId)))
    .where(and(
      eq(xEvaluations.projectId, projectId), isNull(xPosts.unavailableAt), whenWhere(filter), xWordsWhere(),
      notMuted(sql`${xEvaluations.projectId}`, sql`${xPosts.text}`, null),
      evidenceWhere(includeReplies, false), sql`exists ${handledSql}`,
    ))
    .orderBy(desc(xPosts.createdAt));
  return rows.map((row) => ({
    entry: HELD_STAGES.includes(row.evaluation.stage) ? { kind: "held", item: heldCard(row) } : { kind: "filtered", item: filteredCard(row) },
    thread: threadOf(row.post.authorUsername, row.post.conversationId ?? row.post.id),
  }));
}

/**
 * A display-only stream of stored evidence, not the alert/qualification reader.
 * Rank the entire time window before deduplication and the display cap; applying
 * the old group caps first would still bury an older strong screened request.
 * Ranking reads only the columns it needs; the cards the cap keeps are then
 * read whole. No judge, lookup, stage write or change to the operational quiet
 * rules here.
 */
export async function listXOpportunities(
  projectId: string,
  filter: XFeedFilter = { days: FEED_WINDOW_DAYS, status: "new" },
  now = new Date(),
  includeReplies = true,
): Promise<XOpportunityFeed> {
  if (filter.status !== "new") {
    const [all, evidence] = await Promise.all([
      listXLeads(projectId, filter, now, null),
      // Replied is the one mark a post with no lead row can carry (handled_threads).
      filter.status === "replied" ? listXRepliedEvidence(projectId, filter, includeReplies) : [],
    ]);
    const leads = all.filter((lead) => includeReplies || lead.kind !== "reply");
    // History retains every marked post. A post with no lead row gives way only
    // to its author's lead in that conversation that this list shows.
    const listed = new Set(leads.map((lead) => threadOf(lead.authorUsername, lead.conversationId)));
    const entries: XEvaluationEntry[] = [
      ...leads.map((lead): XEvaluationEntry => ({ kind: "lead", lead })),
      ...evidence.filter((one) => !listed.has(one.thread)).map((one) => one.entry),
    ];
    // Count and date every one; list the first OPPORTUNITY_LIST_LIMIT.
    return {
      items: entries.slice(0, OPPORTUNITY_LIST_LIMIT).map((entry) => ({ entry, priority: null, checks: [] })),
      total: entries.length,
      posts: entries.length,
      faces: entries.map((entry) => {
        const card = xOpportunityCard(entry);
        return opportunityFace(card.entryId, card.postedAt, null, card.authorUsername, card.authorImage);
      }),
    };
  }
  // One snapshot for both reads: a lead hidden or evidence rejudged between
  // them would otherwise show a card that no longer qualifies, or new details
  // under the old priority.
  return db().transaction(async (tx) => {
    const pool = await tx
      .select({
        evaluationId: xEvaluations.id, stage: xEvaluations.stage, level: xEvaluations.level, signals: xEvaluations.signals,
        reasonCode: xEvaluations.reasonCode, engagement: xEvaluations.engagement,
        tweetId: xPosts.id, author: xPosts.authorUsername, authorImage: xPosts.authorImage, postedAt: xPosts.createdAt, leadId: xLeads.id, leadKind: xLeads.kind,
      })
      .from(xEvaluations)
      .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
      .innerJoin(projects, eq(projects.id, xEvaluations.projectId))
      .leftJoin(xLeads, and(eq(xLeads.projectId, xEvaluations.projectId), eq(xLeads.tweetId, xEvaluations.tweetId)))
      .where(and(
        eq(xEvaluations.projectId, projectId), isNull(xPosts.unavailableAt), whenWhere(filter), xWordsWhere(),
        notMuted(sql`${xEvaluations.projectId}`, sql`${xPosts.text}`, null),
        or(
          and(eq(xLeads.status, "new"), xShownWhere(), includeReplies ? undefined : eq(xLeads.kind, "ask")),
          evidenceWhere(includeReplies),
        ),
        // Answered conversations must not reappear through unqualified sibling posts.
        sql`not exists ${handledSql}`,
      ));
    const inputs = pool.map((row) => ({
      ...row, key: row.tweetId, entryId: row.leadId ? `lead-${row.leadId}` : `${HELD_STAGES.includes(row.stage) ? "held" : "filtered"}-${row.evaluationId}`,
      replyVerdictCode: row.reasonCode,
    }));
    // Leads come first, asks then posts worth a reply, each in evidence order.
    // An author with a lead keeps it: their other posts do not take its card.
    const leads = rankXOpportunities(inputs.filter((one) => one.leadId !== null));
    const asks = leads.filter((one) => one.leadKind === "ask");
    const leadAuthors = new Set(leads.map((one) => one.author.trim().toLowerCase()));
    const ranked = [
      ...asks,
      ...leads.filter((one) => one.leadKind !== "ask"),
      ...rankXOpportunities(inputs.filter((one) => one.leadId === null && !leadAuthors.has(one.author.trim().toLowerCase()))),
    ];
    const top = ranked.slice(0, OPPORTUNITY_LIST_LIMIT);
    const rows = top.length === 0 ? [] : await tx
      .select({ evaluation: xEvaluations, post: xPosts, author: xAuthors, lead: xLeads, closeCall: closeCallSql, worth: worthSql })
      .from(xEvaluations)
      .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
      .leftJoin(xAuthors, authorJoin)
      .leftJoin(xLeads, and(eq(xLeads.projectId, xEvaluations.projectId), eq(xLeads.tweetId, xEvaluations.tweetId)))
      .where(and(eq(xEvaluations.projectId, projectId), inArray(xEvaluations.id, top.map((one) => one.evaluationId))));
    const entries = new Map(rows.map((row): [string, XEvaluationEntry] => {
      const { evaluation, post, author, lead } = row;
      return [evaluation.id, lead
        ? { kind: "lead", lead: leadCard({ lead, post, author, context: evaluation.context, foundBy: evaluation.matchedPhrase }, now) }
        : HELD_STAGES.includes(evaluation.stage)
          ? { kind: "held", item: heldCard(row) }
          : { kind: "filtered", item: filteredCard(row) }];
    }));
    // Same snapshot, so every ranked row is here; the guard only keeps the types honest.
    const items = top.flatMap(({ evaluationId, priority, checks, notes }) => {
      const entry = entries.get(evaluationId);
      return entry ? [{ entry, priority, checks, notes }] : [];
    });
    return {
      items,
      total: ranked.length,
      posts: pool.length,
      leads: asks.length,
      replies: leads.length - asks.length,
      // The strip shows who is asking, as the rail and the scan's own line count them.
      faces: asks.map((one) => opportunityFace(one.entryId, one.postedAt, one.priority, one.author, one.authorImage)),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * A held or filtered-out post by its evaluation, whatever the window or the
 * list's cap, for the pane: the post the URL names stays open when a scan
 * pushes it off the list or the window changes. One that has since become a
 * lead opens as that lead.
 */
export async function xEvaluationEntry(projectId: string, evaluationId: string, now = new Date()): Promise<XEvaluationEntry | null> {
  const [row] = await evaluationRows()
    .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.id, evaluationId), isNull(xPosts.unavailableAt)))
    .limit(1);
  if (!row) {
    return null;
  }
  const { stage } = row.evaluation;
  if (stage === "review" || stage === "merged" || (["pending_context", "pending_reply"].includes(stage) && row.evaluation.signals !== null)) {
    return { kind: "held", item: heldCard(row) };
  }
  if (stage === "rejected" || stage === "free_rejected" || (stage === "expired" && ["qualify", "review"].includes(row.evaluation.decision ?? ""))) {
    return { kind: "filtered", item: filteredCard(row) };
  }
  const [lead] = await leadRows()
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.tweetId, row.evaluation.tweetId), isNull(xPosts.unavailableAt)))
    .limit(1);
  return lead ? { kind: "lead", lead: leadCard(lead, now) } : null;
}

/**
 * Whether an evaluated post is marked replied, for the pane's Replied button:
 * a mark on its conversation or on the post itself, the same two New hides it by.
 */
export async function xEvaluationReplied(projectId: string, evaluationId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: handledThreads.id })
    .from(xEvaluations)
    .innerJoin(xPosts, eq(xPosts.id, xEvaluations.tweetId))
    .innerJoin(handledThreads, and(eq(handledThreads.projectId, xEvaluations.projectId), eq(handledThreads.platform, "x"),
      or(eq(handledThreads.threadId, xPosts.conversationId), eq(handledThreads.threadId, xPosts.id))))
    .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.id, evaluationId)))
    .limit(1);
  return Boolean(row);
}

/** One post in a thread as X draws it: who, when, the words, and the counts under it. */
export type XThreadPost = {
  tweetId: string;
  url: string;
  /** The author's own words: a reply without the handles X puts ahead of it. */
  text: string;
  authorUsername: string;
  authorName: string | null;
  authorImage: string | null;
  authorVerified: boolean;
  postedAt: Date;
  likeCount: number | null;
  replyCount: number | null;
  retweetCount: number | null;
  viewCount: number | null;
  /** The handles it answers, as X heads a reply with "Replying to". */
  replyingTo: string[];
};

/**
 * A post with what lurk has stored of the thread around it: the posts above
 * it, oldest first, and the reply that led lurk to it. Buys nothing; `gap`
 * says the thread goes further up than lurk walked.
 */
export type XThread = { above: XThreadPost[]; gap: boolean; post: XThreadPost; below: XThreadPost | null };

/** How far up a thread the pane reads stored posts. The scan walks fewer, so this is a ceiling. */
const THREAD_HOPS = 8;

function threadPost(post: typeof xPosts.$inferSelect, parent: typeof xPosts.$inferSelect | null): XThreadPost {
  const mentions = post.isReply ? (post.text.match(/^(?:@\w{1,15}\s+)+/u)?.[0].match(/@\w{1,15}/gu) ?? []) : [];
  return {
    tweetId: post.id,
    url: canonicalUrl(post.authorUsername, post.id),
    text: ownWords(post),
    authorUsername: post.authorUsername,
    authorName: post.authorName,
    authorImage: post.authorImage,
    authorVerified: post.authorVerified ?? false,
    postedAt: post.createdAt,
    likeCount: post.likeCount,
    replyCount: post.replyCount,
    retweetCount: post.retweetCount,
    viewCount: post.viewCount,
    replyingTo: post.isReply ? (mentions.length > 0 ? mentions.map((m) => m.slice(1)) : parent ? [parent.authorUsername] : []) : [],
  };
}

async function storedPost(id: string): Promise<typeof xPosts.$inferSelect | null> {
  const [row] = await db().select().from(xPosts).where(eq(xPosts.id, id)).limit(1);
  return row ?? null;
}

/** The thread around one post, from stored posts only. */
export async function xThreadOf(tweetId: string, viaId: string | null = null): Promise<XThread | null> {
  const post = await storedPost(tweetId);
  if (!post) {
    return null;
  }
  const chain: (typeof xPosts.$inferSelect)[] = [];
  let next = post.inReplyToId;
  let gap = false;
  for (let hop = 0; next; hop += 1) {
    const parent = hop < THREAD_HOPS ? await storedPost(next) : null;
    if (!parent || parent.unavailableAt) {
      gap = true;
      break;
    }
    chain.unshift(parent);
    next = parent.inReplyToId;
  }
  const via = viaId ? await storedPost(viaId) : null;
  return {
    above: chain.map((one, index) => threadPost(one, chain[index - 1] ?? null)),
    gap,
    post: threadPost(post, chain.at(-1) ?? null),
    below: via && !via.unavailableAt ? threadPost(via, post) : null,
  };
}

/** Everyone the project has an X ask from in the list's filter, as the people strip draws them. */
export async function listXFaces(projectId: string, filter: XFeedFilter): Promise<LeadFace[]> {
  const rows = await db()
    .select({ id: xLeads.id, at: xPosts.createdAt, score: xLeads.score, author: xPosts.authorUsername, avatarUrl: xPosts.authorImage })
    .from(xLeads)
    .innerJoin(xPosts, eq(xPosts.id, xLeads.tweetId))
    .innerJoin(projects, eq(projects.id, xLeads.projectId))
    .where(
      and(
        eq(xLeads.projectId, projectId),
        // The strip shows who is asking, as the rail counts them; replies are their own list.
        eq(xLeads.kind, "ask"),
        eq(xLeads.status, filter.status),
        isNull(xPosts.unavailableAt),
        whenWhere(filter),
        xShownWhere(),
        xLeadNotMuted(),
      ),
    )
    .orderBy(desc(xLeads.score))
    .limit(300);
  return rows.map((row) => ({
    ...row,
    subreddit: "",
    label: `@${row.author} on X`,
    plainAvatar: true,
  }));
}

/**
 * New asks in the window, for the rail's count. Replies are left out: on X an
 * ask is about one post in a hundred judged, so replies would be most of the
 * badge and it would stop meaning someone is asking.
 */
export async function newXLeadCount(projectId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(xLeads)
    .innerJoin(xPosts, eq(xPosts.id, xLeads.tweetId))
    .innerJoin(projects, eq(projects.id, xLeads.projectId))
    .where(
      and(
        eq(xLeads.projectId, projectId),
        eq(xLeads.kind, "ask"),
        eq(xLeads.status, "new"),
        isNull(xPosts.unavailableAt),
        gte(xPosts.createdAt, daysAgo(FEED_WINDOW_DAYS)),
        xShownWhere(),
        xLeadNotMuted(),
      ),
    );
  return row?.count ?? 0;
}

export type XLaneView = {
  id: string;
  body: string;
  family: string;
  label: string | null;
  seeds: string[];
  state: string;
  pauseReason: string | null;
  posts: number;
  screenedOut: number;
  judged: number;
  leads: number;
  replies: number;
  reviews: number;
  newPosts: number;
  /** Runs whose last page was full and still inside the window: more was there than it read. */
  fullPages: number;
  lastRunAt: Date | null;
  nextDueAt: Date | null;
  createdAt: Date;
};

/** What lurk searches on X for this project, with what each search found, in rank order. */
export async function listXLanes(projectId: string): Promise<XLaneView[]> {
  const rows = await db()
    .select()
    .from(xLanes)
    .where(and(eq(xLanes.projectId, projectId), inArray(xLanes.state, ["active", "paused", "refused"])))
    .orderBy(xLanes.rank, xLanes.createdAt);
  return rows.map((lane) => ({
    id: lane.id,
    body: lane.body,
    family: lane.family,
    label: lane.label,
    seeds: lane.seeds,
    state: lane.state,
    pauseReason: lane.pauseReason,
    posts: lane.posts,
    screenedOut: lane.screenedOut,
    judged: lane.judged,
    leads: lane.leads,
    replies: lane.replies,
    reviews: lane.reviews,
    newPosts: lane.newPosts,
    fullPages: lane.fullPages,
    lastRunAt: lane.lastRunAt,
    nextDueAt: lane.nextDueAt,
    createdAt: lane.createdAt,
  }));
}

export type XStatus = {
  opened: boolean;
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  running: { kind: string; progress: string | null } | null;
  lastRun: typeof xRuns.$inferSelect | null;
  /** The last X job's error, when it failed and is waiting to try again. */
  lastFailure: string | null;
  /** Whether X has been quiet for this product long enough to say so (quiet.ts). */
  quiet: XQuiet;
};

export async function xStatus(projectId: string): Promise<XStatus> {
  const now = new Date();
  const [[state], [lastRun], [running], [lastFinished], next] = await Promise.all([
    db().select().from(xProjects).where(eq(xProjects.projectId, projectId)),
    db()
      .select()
      .from(xRuns)
      .where(and(eq(xRuns.projectId, projectId), sql`${xRuns.finishedAt} is not null`))
      .orderBy(desc(xRuns.startedAt))
      .limit(1),
    db()
      .select({ kind: jobs.kind, progress: jobs.progress })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.kind, "x_scan"),
          isNull(jobs.finishedAt),
          sql`${jobs.startedAt} is not null`,
        ),
      )
      .limit(1),
    db()
      .select({ error: jobs.error })
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.kind, "x_scan"), sql`${jobs.finishedAt} is not null`))
      .orderBy(desc(jobs.finishedAt))
      .limit(1),
    nextQueuedJob("x_scan", projectId),
  ]);
  // The project's row already says when X was turned on, which is all the quiet rule reads of it.
  const quiet = await xQuiet(projectId, now, state?.enabledAt ?? null);
  // The first check, due now, is as good as running; a later one booked is just the next check.
  // The next job waiting is the earliest, so it is due exactly when any waiting one is.
  const waitingFirst = !state?.lastScanAt && next !== null && next.runAt.getTime() <= now.getTime();
  return {
    quiet,
    opened: Boolean(state),
    lastScanAt: state?.lastScanAt ?? null,
    nextScanAt: next?.runAt ?? null,
    running: running ?? (waitingFirst ? { kind: "x_scan", progress: null } : null),
    lastRun: lastRun ?? null,
    lastFailure: lastFinished?.error ? lastFinished.error.split("\n")[0].trim() : null,
  };
}

/**
 * Pages one lane would buy a day on an hourly tier with backoff, given how
 * often its posts arrive. After each new post the lane is polled hourly three
 * times, then at 2, 4 and 8 hours, and every 8 hours after, until the next post.
 */
export function pagesPerDayAt(postsPerHour: number): number {
  if (postsPerHour >= 1) {
    return 24;
  }
  if (postsPerHour <= 0) {
    return 3;
  }
  const gap = 1 / postsPerHour;
  let pages = 0;
  let elapsed = 0;
  const steps = [1, 1, 1, 2, 4, 8];
  for (let index = 0; elapsed < gap; index += 1) {
    elapsed += steps[Math.min(index, steps.length - 1)];
    pages += 1;
  }
  return Math.min(24, (pages * 24) / gap);
}

const SEARCH_PAGE_USD = 0.00065;
const LOOKUP_USD = 0.00022;
/** From AnyAPI's scanner: 60% pass the free screen, a third are replies, a fifth reach the bio. */
const PASS_SHARE = 0.6;
const REPLY_SHARE = 0.33;
const PROFILE_SHARE = 0.2;

/**
 * What an hourly wallet would pay a day for this project's X, from its lanes'
 * measured post rates, rounded up to the cent. The upgrade line quotes it, so
 * it is arithmetic on this project's own volume, never a marketing constant.
 * It counts new posts, not re-fetches of an overlapping window. On free a lane
 * reads one page a day, so a busy lane's rate is a floor; the page shows the
 * figure as "about", never as a promise.
 */
export function projectedWalletCostPerDay(
  lanes: Array<Pick<XLaneView, "newPosts" | "createdAt" | "state" | "fullPages">>,
  now = new Date(),
): number {
  let dollars = 0;
  // A wallet searches every active lane.
  for (const lane of lanes.filter((one) => one.state === "active")) {
    // A lane whose pages stopped short of its window read less than the month:
    // count it as a day, which quotes high rather than low.
    const lookBack = lane.fullPages > 0 ? 24 : FIRST_LOOK_HOURS;
    const hours = lookBack + Math.max(0, (now.getTime() - lane.createdAt.getTime()) / HOUR_MS);
    const rate = lane.newPosts / hours;
    const postsPerDay = rate * 24;
    dollars += pagesPerDayAt(rate) * SEARCH_PAGE_USD;
    dollars += postsPerDay * PASS_SHARE * (REPLY_SHARE + PROFILE_SHARE) * LOOKUP_USD;
  }
  return Math.max(0.01, Math.ceil(dollars * 100) / 100);
}

export type XSettingsView = {
  /** False until the X tab is first opened, which is what starts X for a project. */
  started: boolean;
  alerts: boolean;
  lastScanAt: Date | null;
  /** What X runs cost for this project, data and model together, in USD. */
  spentToday: number;
  spentMonth: number;
};

/** What Settings, X shows for one project. */
export async function xSettingsOf(projectId: string, now = new Date()): Promise<XSettingsView> {
  const [state] = await db().select().from(xProjects).where(eq(xProjects.projectId, projectId));
  const today = utcDayStart(now);
  const monthAgo = daysAgo(FEED_WINDOW_DAYS, now);
  const [spend] = await db()
    .select({
      today: sql<string>`coalesce(sum(${xRuns.dataUsd} + ${xRuns.llmUsd}) filter (where ${xRuns.startedAt} >= ${today.toISOString()}), 0)`,
      month: sql<string>`coalesce(sum(${xRuns.dataUsd} + ${xRuns.llmUsd}), 0)`,
    })
    .from(xRuns)
    .where(and(eq(xRuns.projectId, projectId), gte(xRuns.startedAt, monthAgo)));
  return {
    started: Boolean(state),
    alerts: state?.alerts ?? true,
    lastScanAt: state?.lastScanAt ?? null,
    spentToday: Number(spend?.today ?? 0),
    spentMonth: Number(spend?.month ?? 0),
  };
}
