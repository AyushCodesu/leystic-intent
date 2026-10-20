import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { competitorMentions } from "@/db/schema/competitors";
import {
  projectCompetitors,
  redditAuthors,
  redditComments,
  redditPosts,
  subreddits,
} from "@/db/schema";
import { LEAD_AUTHOR, LEAD_AUTHOR_JOIN, LEAD_URL, NEED_AT } from "@/lib/leadSql";
import { RETRIEVED_STATES } from "@/lib/scan/planStates";
import { DAY_MS, daysAgo } from "@/lib/time";
import { SENTIMENTS, type ReasonCategory, type Sentiment, type SwitchingEvidence } from "./classify";
import { isSourceAuthorized, type SourceOperationRequest } from "@/lib/sourcePolicy";

const COMPETITOR_READ_OP: SourceOperationRequest = {
  sourceId: "reddit",
  purpose: "competitor_intelligence",
  scope: "social_content_read",
};

/** The window the competitor screen shows, matching the feed window. */
export const MENTION_WINDOW_DAYS = 30;

export type MentionView = {
  id: string;
  competitor: string;
  /** Null for a mention found in a thread the project reads, which nobody judged. */
  sentiment: Sentiment | null;
  summary: string | null;
  /** The sentence that named the competitor, for a mention found in a thread. */
  quote: string | null;
  reasonCategory: ReasonCategory | null;
  switchingEvidence: SwitchingEvidence | null;
  explanation: string | null;
  foundAt: Date;
  postId: string;
  title: string;
  /** The reply's own link when a reply named the competitor, else the post's. */
  url: string;
  subreddit: string;
  subredditIconUrl: string | null;
  /** Who named the competitor: the reply's author, or the post's. */
  author: string | null;
  avatarUrl: string | null;
  createdAt: Date;
};

/** A competitor as the screen draws it: a name, and the site its logo comes from. */
export type CompetitorRow = { name: string; domain: string | null };

/** A watched competitor, with the evidence discovery has counted for it. */
export type WatchedCompetitor = CompetitorRow & { evidence: number };

/** The states a watched competitor is in, the same ones a scan retrieves. */
const WATCHED_STATES = [...RETRIEVED_STATES];

/**
 * The competitors this project watches: the active and pinned ones. One a
 * person excluded on the Product page is not one of theirs, so no screen names
 * or counts it and discovery's labeller is not told about it. Read here for
 * every surface, so they cannot disagree.
 */
export async function watchedCompetitors(projectId: string): Promise<WatchedCompetitor[]> {
  return await db()
    .select({
      name: projectCompetitors.name,
      domain: projectCompetitors.domain,
      evidence: projectCompetitors.evidence,
    })
    .from(projectCompetitors)
    .where(
      and(
        eq(projectCompetitors.projectId, projectId),
        inArray(projectCompetitors.state, WATCHED_STATES),
      ),
    );
}

/**
 * A mention's own competitor row, joined only while the project still watches
 * it. A mention found before its competitor was excluded stays stored, but no
 * list, bar or count shows it, so the screen agrees with watchedCompetitors.
 */
const WATCHED_MENTION = and(
  eq(projectCompetitors.projectId, competitorMentions.projectId),
  eq(projectCompetitors.name, competitorMentions.competitor),
  inArray(projectCompetitors.state, WATCHED_STATES),
);

/**
 * The site each competitor sells from, keyed by name. A name discovery never
 * found a site for still answers, with null, so the chip can fall back to the
 * name itself being a domain.
 */
export function domainsByName(rows: CompetitorRow[]): Record<string, string | null> {
  return Object.fromEntries(rows.map((row) => [row.name, row.domain]));
}

/**
 * How many mentions of a watched competitor are in the window. The rail's pill
 * wants the number and nothing else, and asking the database to count is a
 * great deal less work than reading every mention with its thread, its author
 * and its icon on every page of the app.
 */
export async function countMentions(
  projectId: string,
  days = MENTION_WINDOW_DAYS,
): Promise<number> {
  if (!isSourceAuthorized(COMPETITOR_READ_OP)) {
    return 0;
  }
  const rows = await db()
    .select({ total: count() })
    .from(competitorMentions)
    .innerJoin(projectCompetitors, WATCHED_MENTION)
    .innerJoin(redditPosts, eq(redditPosts.id, competitorMentions.postId))
    .where(
      and(
        eq(competitorMentions.projectId, projectId),
        gte(redditPosts.createdAt, daysAgo(days)),
      ),
    );
  return rows[0]?.total ?? 0;
}

/**
 * Every mention of a watched competitor inside the window, newest first. A
 * mention sits on a thread or one reply in it the way a lead does, so it reads
 * the lead's fragments: the one who named the competitor is the reply's author
 * when a reply did, and a reply is as old as itself.
 */
export async function listMentions(
  projectId: string,
  days = MENTION_WINDOW_DAYS,
): Promise<MentionView[]> {
  if (!isSourceAuthorized(COMPETITOR_READ_OP)) {
    return [];
  }
  const rows = await db()
    .select({
      id: competitorMentions.id,
      competitor: competitorMentions.competitor,
      sentiment: competitorMentions.sentiment,
      summary: competitorMentions.summary,
      quote: competitorMentions.quote,
      reasonCategory: competitorMentions.reasonCategory,
      switchingEvidence: competitorMentions.switchingEvidence,
      explanation: competitorMentions.explanation,
      foundAt: competitorMentions.foundAt,
      postId: competitorMentions.postId,
      title: redditPosts.title,
      url: LEAD_URL,
      subreddit: redditPosts.subreddit,
      subredditIconUrl: subreddits.iconUrl,
      author: LEAD_AUTHOR,
      avatarUrl: redditAuthors.avatarUrl,
      createdAt: NEED_AT,
    })
    .from(competitorMentions)
    .innerJoin(projectCompetitors, WATCHED_MENTION)
    .innerJoin(redditPosts, eq(redditPosts.id, competitorMentions.postId))
    .leftJoin(redditComments, eq(redditComments.id, competitorMentions.commentId))
    .leftJoin(subreddits, eq(subreddits.name, sql`lower(${redditPosts.subreddit})`))
    .leftJoin(redditAuthors, LEAD_AUTHOR_JOIN)
    .where(
      and(
        eq(competitorMentions.projectId, projectId),
        gte(redditPosts.createdAt, daysAgo(days)),
      ),
    )
    .orderBy(desc(NEED_AT));
  return rows.map((row) => ({
    ...row,
    sentiment: (row.sentiment as Sentiment | null) ?? null,
    reasonCategory: (row.reasonCategory as ReasonCategory | null) ?? null,
    switchingEvidence: (row.switchingEvidence as SwitchingEvidence | null) ?? null,
    explanation: row.explanation ?? null,
    createdAt: new Date(row.createdAt),
  }));
}

/**
 * The competitors named anywhere in one thread this project holds a lead in,
 * each once, in the order the project lists them. The detail pane's line.
 */
export async function competitorsNamedIn(projectId: string, postId: string): Promise<string[]> {
  if (!isSourceAuthorized(COMPETITOR_READ_OP)) {
    return [];
  }
  const rows = await db()
    .selectDistinct({ competitor: competitorMentions.competitor })
    .from(competitorMentions)
    .where(
      and(eq(competitorMentions.projectId, projectId), eq(competitorMentions.postId, postId)),
    );
  const named = new Set(rows.map((row) => row.competitor));
  const watched = await watchedCompetitors(projectId);
  return watched.map((row) => row.name).filter((name) => named.has(name));
}

export type MentionSeries = { competitor: string; days: number[]; total: number };

/**
 * One bar per day per competitor, newest day first, so a row of bars reads left
 * to right as today and then backwards. The bars are filled oldest first, the
 * way a window is counted, and turned around once at the end.
 */
export function mentionSeries(
  mentions: Pick<MentionView, "competitor" | "createdAt">[],
  competitors: string[],
  days = MENTION_WINDOW_DAYS,
  now = new Date(),
): MentionSeries[] {
  const start = daysAgo(days, now).getTime();
  const buckets = new Map<string, number[]>();
  const names = [...new Set([...competitors, ...mentions.map((one) => one.competitor)])];
  for (const name of names) {
    buckets.set(name, new Array(days).fill(0));
  }
  for (const mention of mentions) {
    const index = Math.floor((mention.createdAt.getTime() - start) / DAY_MS);
    const row = buckets.get(mention.competitor);
    if (row && index >= 0 && index < days) {
      row[index] += 1;
    }
  }
  return names.map((competitor) => {
    const row = buckets.get(competitor) as number[];
    const total = row.reduce((sum, one) => sum + one, 0);
    // Filled oldest first, because that is what the index off `start` means;
    // handed back newest first, because that is the end a reader starts at.
    return { competitor, days: row.reverse(), total };
  });
}

/**
 * How many competitors a stacked bar can tell apart. The palette holds eight
 * colours, and their fixed order is what keeps two touching segments separable
 * under colour blindness; a ninth would have to repeat one of them.
 */
export const SERIES_SLOTS = 8;

/** What the rest are called, once a project watches more names than that. */
export const OTHER_COMPETITORS = "Everyone else";

/** One row of a stacked bar: a competitor, its days, and the colour it keeps. */
export type MentionRow = MentionSeries & {
  /**
   * Its place in the palette, 1-based, taken from where the project lists the
   * competitor rather than from how often it was named. Null is the folded row.
   */
  slot: number | null;
};

/** The stacked bar as it is drawn: its rows, and the day that sets the scale. */
export type MentionStack = { rows: MentionRow[]; peak: number };

/**
 * The series a stacked bar can draw. Three things happen here, and all three
 * are about the bar staying readable rather than about the data:
 *
 * - Competitors past the eighth the project lists are added together into one
 *   row, because there is no ninth colour that stays apart from the other
 *   eight for a reader who cannot tell red from green.
 * - A competitor nobody named in the window is dropped. It adds no height to
 *   any bar, and a legend of names with nothing behind them is just the list
 *   of competitors, which is the card above this one.
 * - Dropping it moves nobody else's colour. The slot comes from the project's
 *   own order, so a quiet week never repaints the chart under you.
 */
export function stackMentions(series: MentionSeries[]): MentionStack {
  const rows: MentionRow[] = series
    .slice(0, SERIES_SLOTS)
    .map((row, index) => ({ ...row, slot: index + 1 }));
  const rest = series.slice(SERIES_SLOTS);
  if (rest.length > 0) {
    rows.push({
      competitor: OTHER_COMPETITORS,
      days: rest[0].days.map((_, index) => rest.reduce((sum, row) => sum + row.days[index], 0)),
      total: rest.reduce((sum, row) => sum + row.total, 0),
      slot: null,
    });
  }
  const drawn = rows.filter((row) => row.total > 0);
  const totals = (drawn[0]?.days ?? []).map((_, index) =>
    drawn.reduce((sum, row) => sum + row.days[index], 0),
  );
  // Never zero: the scale divides by it, and a card with no mentions in it
  // still has to draw thirty empty days rather than thirty NaNs.
  return { rows: drawn, peak: Math.max(1, ...totals) };
}

export type CompetitorCount = {
  competitor: string;
  total: number;
  sentiments: Record<Sentiment, number>;
};

/**
 * How often each competitor was mentioned, split by sentiment, loudest first.
 * A mention found in a thread has no sentiment and counts in the total only.
 * Competitors tied on total keep the order they were first mentioned in.
 */
export function topCompetitors(
  mentions: Pick<MentionView, "competitor" | "sentiment">[],
): CompetitorCount[] {
  const counts = new Map<string, CompetitorCount>();
  for (const mention of mentions) {
    let row = counts.get(mention.competitor);
    if (!row) {
      const sentiments = Object.fromEntries(
        SENTIMENTS.map((name) => [name, 0]),
      ) as Record<Sentiment, number>;
      row = { competitor: mention.competitor, total: 0, sentiments };
      counts.set(mention.competitor, row);
    }
    row.total += 1;
    if (mention.sentiment !== null) {
      row.sentiments[mention.sentiment] += 1;
    }
  }
  return [...counts.values()].sort((a, b) => b.total - a.total);
}

export type ReasonGroup = {
  competitor: string;
  reasonCategory: ReasonCategory;
  /** Number of independent Reddit threads (posts) supporting this finding */
  distinctThreads: number;
  /** Total mentions count (threads + replies) */
  totalMentions: number;
  /** Whether supported by multiple distinct threads or only a single observation */
  isRecurring: boolean;
  /** Representative explanation grounded in source evidence */
  representativeExplanation: string;
  /** All supporting mentions sorted newest first */
  mentions: MentionView[];
};

export type SwitcherOpportunity = {
  id: string;
  competitor: string;
  signal: "actively_switching" | "evaluating_alternatives";
  reasonCategory: ReasonCategory;
  explanation: string;
  quoteOrSummary: string;
  postId: string;
  title: string;
  url: string;
  subreddit: string;
  subredditIconUrl: string | null;
  author: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  distinctThreads: number;
  allMentionsInThread: MentionView[];
};

/**
 * Groups positive mentions by competitor and praise category, counting independent
 * threads to distinguish recurring praise patterns from single observations.
 */
export function groupLoveReasons(mentions: MentionView[]): ReasonGroup[] {
  const positive = mentions.filter(
    (m) => m.sentiment === "positive" || m.switchingEvidence === "positive_recommendation",
  );

  const groups = new Map<string, MentionView[]>();
  for (const m of positive) {
    const reason = m.reasonCategory ?? "recommendation_value_delivered";
    const key = `${m.competitor}::${reason}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const result: ReasonGroup[] = [];
  for (const [key, groupMentions] of groups) {
    const [competitor, reasonCategory] = key.split("::") as [string, ReasonCategory];
    const distinctThreads = new Set(groupMentions.map((m) => m.postId)).size;
    const sortedMentions = [...groupMentions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const representativeExplanation =
      sortedMentions.find((m) => m.explanation && m.explanation.length > 5)?.explanation ??
      sortedMentions.find((m) => m.summary && m.summary.length > 5)?.summary ??
      sortedMentions.find((m) => m.quote && m.quote.length > 5)?.quote ??
      "User satisfaction with the product";

    result.push({
      competitor,
      reasonCategory,
      distinctThreads,
      totalMentions: groupMentions.length,
      isRecurring: distinctThreads >= 2,
      representativeExplanation,
      mentions: sortedMentions,
    });
  }

  return result.sort((a, b) => {
    if (b.distinctThreads !== a.distinctThreads) {
      return b.distinctThreads - a.distinctThreads;
    }
    return b.totalMentions - a.totalMentions;
  });
}

/**
 * Groups complaints by competitor and limitation category, counting independent
 * threads. Labels single observations as examples and never implies that an
 * unverified complaint proves lost customers.
 */
export function groupDislikeReasons(mentions: MentionView[]): ReasonGroup[] {
  const negative = mentions.filter(
    (m) =>
      m.sentiment === "negative" ||
      m.switchingEvidence === "dissatisfied_no_switch" ||
      m.switchingEvidence === "actively_switching" ||
      m.switchingEvidence === "evaluating_alternatives",
  );

  const groups = new Map<string, MentionView[]>();
  for (const m of negative) {
    const reason = m.reasonCategory ?? "other";
    const key = `${m.competitor}::${reason}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const result: ReasonGroup[] = [];
  for (const [key, groupMentions] of groups) {
    const [competitor, reasonCategory] = key.split("::") as [string, ReasonCategory];
    const distinctThreads = new Set(groupMentions.map((m) => m.postId)).size;
    const sortedMentions = [...groupMentions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const representativeExplanation =
      sortedMentions.find((m) => m.explanation && m.explanation.length > 5)?.explanation ??
      sortedMentions.find((m) => m.summary && m.summary.length > 5)?.summary ??
      sortedMentions.find((m) => m.quote && m.quote.length > 5)?.quote ??
      "Reported limitation or complaint with the product";

    result.push({
      competitor,
      reasonCategory,
      distinctThreads,
      totalMentions: groupMentions.length,
      isRecurring: distinctThreads >= 2,
      representativeExplanation,
      mentions: sortedMentions,
    });
  }

  return result.sort((a, b) => {
    if (b.distinctThreads !== a.distinctThreads) {
      return b.distinctThreads - a.distinctThreads;
    }
    return b.totalMentions - a.totalMentions;
  });
}

/**
 * Extracts conversations where users show explicit evidence of switching or evaluating
 * alternatives. Negative comments without switching evidence are excluded.
 * Independent threads are unified so multiple replies do not inflate opportunities.
 */
export function listPotentialSwitchers(mentions: MentionView[]): SwitcherOpportunity[] {
  const candidates = mentions.filter(
    (m) =>
      m.switchingEvidence === "actively_switching" ||
      m.switchingEvidence === "evaluating_alternatives",
  );

  const byThread = new Map<string, MentionView[]>();
  for (const m of candidates) {
    const key = `${m.competitor}::${m.postId}`;
    const list = byThread.get(key) ?? [];
    list.push(m);
    byThread.set(key, list);
  }

  const result: SwitcherOpportunity[] = [];
  for (const threadMentions of byThread.values()) {
    const sorted = [...threadMentions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const activeMention = sorted.find((m) => m.switchingEvidence === "actively_switching");
    const primary = activeMention ?? sorted[0];

    const signal: "actively_switching" | "evaluating_alternatives" =
      primary.switchingEvidence === "actively_switching"
        ? "actively_switching"
        : "evaluating_alternatives";

    const reasonCategory = primary.reasonCategory ?? "other";
    const quoteOrSummary = primary.quote || primary.summary || primary.title;
    const explanation = primary.explanation || primary.summary || "Considering alternatives";

    result.push({
      id: primary.id,
      competitor: primary.competitor,
      signal,
      reasonCategory,
      explanation,
      quoteOrSummary,
      postId: primary.postId,
      title: primary.title,
      url: primary.url,
      subreddit: primary.subreddit,
      subredditIconUrl: primary.subredditIconUrl,
      author: primary.author,
      avatarUrl: primary.avatarUrl,
      createdAt: primary.createdAt,
      distinctThreads: 1,
      allMentionsInThread: sorted,
    });
  }

  return result.sort((a, b) => {
    if (a.signal !== b.signal) {
      return a.signal === "actively_switching" ? -1 : 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}
