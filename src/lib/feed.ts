/** Feed vocabulary shared by the server queries and the client filter pills. */

import type { FeedLead } from "@/lib/leads";

/**
 * `replied` is the owner saying they answered the thread, and it covers the
 * whole thread, the leads found in it later included (lib/handled.ts).
 * `resolved` is written by the scan, not by the user: the person said in the
 * thread that their need is met, so the lead leaves the feed without pretending
 * the user judged it.
 */
export type LeadStatus = "new" | "replied" | "hidden" | "not_fit" | "resolved";

/**
 * User-confirmed sales outcomes tracked on a lead.
 */
export const LEAD_OUTCOMES = [
  "replied",
  "meeting_booked",
  "opportunity",
  "customer",
  "not_fit",
] as const;

export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<LeadOutcome, string> = {
  replied: "Replied",
  meeting_booked: "Meeting booked",
  opportunity: "Opportunity",
  customer: "Customer",
  not_fit: "Not a fit",
};

/**
 * The date pills over the feed. Days, plus `all`: the first scan reaches back
 * a year, so the recent window that opens the feed is not everything there is.
 */
export const FEED_WINDOWS = [1, 7, 30, "all"] as const;

export type FeedWindow = (typeof FEED_WINDOWS)[number];

export type FeedFilter = {
  status: LeadStatus;
  days: FeedWindow;
  /**
   * One slice of the clock, clicked out of the people strip: a month as
   * `2026-09`, a day as `2026-09-14`, an hour as `2026-09-14T15`. It narrows
   * the window rather than replacing it, so the pills still say which window
   * the slice was picked from and clearing it puts you back there.
   */
  at?: string;
  subreddit?: string;
  stage?: string;
  /** One Insights theme's id, narrowing the feed to the leads that theme holds. */
  theme?: string;
};

export type FeedFacets = { subreddits: string[]; stages: string[] };

/** The filters the leads page reads out of its own URL. */
export type FeedParams = {
  project?: string;
  status?: string;
  days?: string;
  at?: string;
  subreddit?: string;
  stage?: string;
  theme?: string;
  lead?: string;
};

const STATUSES: LeadStatus[] = ["new", "replied", "hidden", "not_fit", "resolved"];

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

/**
 * How wide one slice of the clock is. The strip draws a window in whichever of
 * these a column of it means, and clicking that column filters the feed to it.
 */
export type Grain = "month" | "day" | "hour";

const SHAPE: Record<Grain, RegExp> = {
  month: /^\d{4}-\d{2}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
  hour: /^\d{4}-\d{2}-\d{2}T\d{2}$/,
};

/** The slice a moment falls in, at one grain, the way the URL writes it. */
export function atKey(at: Date, grain: Grain): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  if (grain === "month") {
    return day.slice(0, 7);
  }
  return grain === "day" ? day : `${day}T${pad(at.getHours())}`;
}

/** Which of the three a key is, by its shape, or nothing when it is none of them. */
export function grainOf(at: string): Grain | null {
  return (Object.keys(SHAPE) as Grain[]).find((grain) => SHAPE[grain].test(at)) ?? null;
}

/** When one slice starts and when the next one does, in local time. */
export function atBounds(at: string): { start: Date; end: Date } {
  const [date, hour] = at.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const grain = grainOf(at);
  if (grain === "month") {
    return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
  }
  if (grain === "day") {
    return { start: new Date(year, month - 1, day), end: new Date(year, month - 1, day + 1) };
  }
  const start = new Date(year, month - 1, day, Number(hour));
  return { start, end: new Date(year, month - 1, day, Number(hour) + 1) };
}

/** What one reads as in a sentence: "August", "August 24", "2pm on August 24". */
export function atLabel(at: string): string {
  const { start } = atBounds(at);
  const grain = grainOf(at);
  if (grain === "month") {
    return start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  const day = start.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  if (grain === "day") {
    return day;
  }
  const hour = start.toLocaleTimeString(undefined, { hour: "numeric" }).toLowerCase().replace(/\s+/g, "");
  return `${hour} on ${day}`;
}

/** The same, with the preposition the grain takes, for a sentence about it. */
export function atSentence(at: string): string {
  const grain = grainOf(at);
  return `${grain === "month" ? "in" : grain === "day" ? "on" : "at"} ${atLabel(at)}`;
}

/**
 * The slice a URL names, or nothing. It has to round-trip through a real date:
 * `2026-02-31` parses in JavaScript, as the third of March, and a day the feed
 * agreed to filter on but the strip never draws is a filter you cannot clear
 * by clicking the same column again.
 */
function oneSlice(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const grain = grainOf(value);
  if (!grain) {
    return undefined;
  }
  return atKey(atBounds(value).start, grain) === value ? value : undefined;
}

/**
 * The filter those pills mean, read the same way by the page and by the action
 * that fetches the next page of it. A value that is not one of ours is the
 * default, so nothing a client sends can widen what a query asks for.
 */
export function feedFilter(params: FeedParams): FeedFilter {
  return {
    status: STATUSES.find((one) => one === params.status) ?? "new",
    days: FEED_WINDOWS.find((one) => String(one) === params.days) ?? 30,
    at: oneSlice(params.at),
    subreddit: params.subreddit || undefined,
    stage: params.stage || undefined,
    theme: params.theme || undefined,
  };
}

/**
 * How many leads one read of the feed brings back.
 *
 * The list column is one screen tall and its rows measure 66px, so a screen
 * holds thirteen of them at 900px and twenty-one on a 1440px display. A page of
 * twenty-four fills the tallest of those with a row to spare, which is what
 * makes the next page something you scroll for rather than something the page
 * fetches the moment it opens. Before this, a project with a year of backfill
 * behind it read and drew every lead it had before anything appeared at all.
 */
export const FEED_PAGE_SIZE = 24;

/** One slice of the feed, in the feed's own order. */
export type FeedPage = { limit: number; offset: number };

/** One line in the list column, which is all it takes to draw a row. */
export type FeedRow = {
  /** The entry id the URL carries, not the lead's own id. */
  id: string;
  /** The thread the row sits in, so a thread's rows can be drawn as one. */
  postId: string | null;
  title: string;
  /** A comment lead's own words, cut to a line. Null when the lead is the post. */
  excerpt: string | null;
  author: string | null;
  avatarUrl: string | null;
  subreddit: string;
  subredditIconUrl: string | null;
  createdAt: Date;
  fit: number | null;
  intent: number | null;
};

/** One lead as the detail pane shows it: the post or comment, and how it judged. */
export type CardLead = {
  id: string;
  /** The thread the lead sits in, its own post or the post its comment answers. */
  postId: string | null;
  /** The lead model's verdict, which the owner's ranking weights fold with the rest. */
  quality: number | null;
  fit: number | null;
  intent: number | null;
  engagement: number | null;
  kind: string;
  /** Where the user put it: new, replied, hidden, not_fit, or resolved by the scan. */
  status: string;
  outcome?: string | null;
  outcomeRecordedAt?: Date | null;
  outcomeNotes?: string | null;
  reason: string | null;
  matchedPhrase: string | null;
  title: string;
  url: string;
  subreddit: string;
  subredditIconUrl: string | null;
  subredditWeeklyActive: number | null;
  promoPolicy: string | null;
  rulesText: string | null;
  numComments: number | null;
  points: number | null;
  createdAt: Date;
  body: string;
  author: string | null;
  avatarUrl: string | null;
  authorKarma: number | null;
  authorCreatedAt: Date | null;
  isComment: boolean;
  postAuthor: string | null;
  postAuthorAvatar: string | null;
};

/**
 * A lead as the feed reads it, as the card the pane draws. A comment lead is
 * its comment throughout: its author, its age, its body and its permalink,
 * with the thread only underneath.
 */
export function toCard(lead: FeedLead): CardLead {
  const isComment = lead.commentId !== null;
  return {
    id: lead.id,
    postId: lead.postId,
    quality: lead.quality,
    fit: lead.fit,
    intent: lead.intent,
    engagement: lead.engagement,
    kind: lead.kind,
    status: lead.status,
    outcome: (lead as Record<string, unknown>).outcome as string | null | undefined,
    outcomeRecordedAt: (lead as Record<string, unknown>).outcomeRecordedAt as Date | null | undefined,
    outcomeNotes: (lead as Record<string, unknown>).outcomeNotes as string | null | undefined,
    reason: lead.reason,
    matchedPhrase: lead.matchedPhrase,
    title: lead.title,
    url: (isComment ? lead.commentPermalink : lead.url) ?? lead.url,
    subreddit: lead.subreddit,
    subredditIconUrl: lead.subredditIconUrl,
    subredditWeeklyActive: lead.subredditWeeklyActive,
    promoPolicy: lead.promoPolicy,
    rulesText: lead.rulesText,
    numComments: lead.numComments,
    points: isComment ? lead.commentScore : lead.postScore,
    createdAt: (isComment ? lead.commentCreatedAt : lead.createdAt) ?? lead.createdAt,
    body: (isComment ? lead.commentBody : lead.body) ?? "",
    author: isComment ? lead.commentAuthor : lead.postAuthor,
    avatarUrl: lead.authorAvatar,
    authorKarma: lead.authorKarma,
    authorCreatedAt: lead.authorCreatedAt,
    isComment,
    postAuthor: lead.postAuthor,
    postAuthorAvatar: lead.postAuthorAvatar,
  };
}

/** As much of a comment as a row could ever show before it is cut off. */
const EXCERPT_LENGTH = 160;

/**
 * What a comment lead's row is headed by: the comment's own words on one line.
 * Headed by the thread's title, three comments in one thread were three rows
 * nobody could tell apart from each other or from the post.
 */
function rowExcerpt(lead: Pick<CardLead, "isComment" | "body">): string | null {
  if (!lead.isComment) {
    return null;
  }
  const line = lead.body.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, EXCERPT_LENGTH) : null;
}

/**
 * The same lead as one line in the list column, for the first page the server
 * draws and every page fetched after it. It carries what a row draws and not
 * the thread's body: the pane reads that from the server when a row is opened.
 */
export function toRow(lead: FeedLead): FeedRow {
  const card = toCard(lead);
  return {
    id: `lead-${card.id}`,
    postId: card.postId,
    title: card.title,
    excerpt: rowExcerpt(card),
    author: card.author,
    avatarUrl: card.avatarUrl,
    subreddit: card.subreddit,
    subredditIconUrl: card.subredditIconUrl,
    createdAt: card.createdAt,
    fit: card.fit,
    intent: card.intent,
  };
}

/** One face in the people strip: who posted, when, and how it scored. */
export type LeadFace = {
  id: string;
  at: Date;
  score: number;
  author: string | null;
  avatarUrl: string | null;
  subreddit: string;
  /** What hovering the face says, when it is not a Reddit author in a subreddit (an X face). */
  label?: string;
  /** Draw the picture as it is, with no Reddit default in its place (an X face). */
  plainAvatar?: boolean;
};

export type LeadCost = { sku: string; costUsd: number; requestId: string | null };

/** One candidate the scan could not settle, as the leads page shows it. */
export type ReviewItem = {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  author: string | null;
  avatarUrl: string | null;
  authorKarma: number | null;
  authorCreatedAt: Date | null;
  subredditIconUrl: string | null;
  numComments: number | null;
  points: number | null;
  isComment: boolean;
  reason: string;
  reasonCodes: string[];
  fit: number | null;
  intent: number | null;
  needState: string;
  createdAt: Date;
  judgedAt: Date;
};
