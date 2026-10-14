/**
 * The X module's fixed numbers. The windows and limits come from what X search
 * was measured to do on 2026-09-26/27 (.context/x-module): a page holds at most
 * 20 posts whatever limit is sent, an empty page is billed, posts older than a
 * week are rarely reached and rarely worth reaching, and a lead's rate holds
 * for about 48 hours and then drops.
 */

/** Bumped whenever a question, a gate or the judge's state changes. Never Reddit's SCORER_VERSION. */
export const X_SCORER_VERSION = "x-2026-09-28.3";
/** Bumped whenever the lane templates change, so every project recompiles its lanes. */
export const X_LANES_VERSION = "x-lanes-2026-10-12.2";
/** Bumped whenever the reply check's prompt or its decision changes. */
export const X_REPLY_VERSION = "x-reply-2026-09-28.1";
/**
 * A reply candidate still unchecked this long after it was found is too late
 * to answer. A post the first look found weeks old is still checked: it is
 * shown as older, below fresh ones.
 */
export const REPLY_STALE_HOURS = 48;
/** Bumped whenever the seed-word prompt changes, so every project asks the model again. */
export const X_SEEDS_VERSION = "x-seeds-2026-10-14.1";
/**
 * The language every project's X lanes search and its screen keeps, as X's
 * lang codes. It is part of what the lanes and the seed words were made from
 * (lanes.ts lanesInputHash, seeds.ts seedsPrompt), so changing it recompiles
 * every lane and asks the model for every project's words again.
 */
export const X_LANG = "en";

/**
 * How long a post stays worth replying to. The founder's own replies on posts
 * over 5k views got a median of about 230 views when posted within 5 hours of
 * the post and under 140 after 7 (.context/x-plugs, 26 replies): the tab marks
 * a reply-worthy post fresh inside this window and ranks it first.
 */
export const REPLY_WINDOW_HOURS = 5;

/**
 * When X counts as quiet for a product: a finished scan read X, and not one
 * ask or reply-worthy post turned up in the last QUIET_LOOKBACK_DAYS. The
 * first scan reads a month (FIRST_LOOK_HOURS), so an empty first look already
 * says it. Freelancers, fitness studios and medical tourism found nothing in
 * 134 posts over a week on 2026-09-27: their buyers do not talk about the job
 * on X, and a quiet product is checked weekly, not daily.
 */
export const QUIET_LOOKBACK_DAYS = 14;
export const QUIET_RECHECK_DAYS = 7;
/** How soon after X was turned on for a project its first searching run counts as the first look that read a month. */
export const FIRST_LOOK_GRACE_DAYS = 2;
/** The stages a post waits in for the judge, a lookup or the reply check. */
export const PENDING_STAGES = ["pending_parent", "pending_llm", "pending_context", "pending_reply"];

/**
 * How far back a lane's first check reaches: thirty days, so the tab opens on
 * the last month of X rather than on an empty day. X search reaches that far
 * (a Cal.com rival lane on 2026-09-28 went back to Aug 30 in three pages),
 * though it keeps replies only for about the last week. Every check after
 * starts where the last one ended.
 */
export const FIRST_LOOK_HOURS = 30 * 24;
/** Pages one lane may read on its first look: 20 posts a page, and a month of the Cal.com lane was 54 posts. */
export const FIRST_LOOK_PAGES = 10;
/**
 * What a project's first check may buy on top of the day's allowance, so the
 * month it reads is judged the day it is opened, not over the week after it.
 * At most about $0.09 a project, once.
 */
export const FIRST_LOOK_EXTRA = { pages: 30, parents: 40, judged: 200, profiles: 20, replyChecks: 20 } as const;
/** The widest window a recurring scan asks for; an empty page grows its window up to this. */
export const MAX_WINDOW_HOURS = 72;
/** How far each window reaches back over the last one, for posts the index was slow to show. */
export const OVERLAP_HOURS = 1;
/** A candidate still waiting this long after it was first seen is dropped before any purchase. */
export const PENDING_EXPIRE_HOURS = 72;
/** Leads older than this sort below fresh ones and carry an "older" badge. */
export const STALE_BADGE_HOURS = 48;
/** The tab's widest window, which the first look fills. */
export const FEED_WINDOW_DAYS = 30;
/**
 * A post the judge turned away is a close call when its fit and intent would
 * still rank it as a lead: fit (own_need × same_kind) and intent both at 2 or
 * more. The gate that turned it away may sit outside fit (a seller, a bot, a
 * need already met) or be half of it (wrong_job, no_active_need), where the
 * answer was near its line. On the 2026-09-28 first looks of four products,
 * 11 of 182 judged-out posts were close calls, among them a plain ask the
 * judge took for a bot ("what's the best loom alternative?") and two people
 * griping about the rival they use; read by hand, none of the other 171 was
 * an ask (.context/x-filtered).
 */
export const CLOSE_CALL_FIT = 2;
export const CLOSE_CALL_INTENT = 2;
/** The filtered-out posts the tab lists, close calls first; its count covers them all. */
export const FILTERED_LIST_LIMIT = 100;
/**
 * A judged-out post scoring at least this (gates.ts foldScore) joins the close
 * calls under "Worth a look". On the 2026-09-28 first looks of 14 products, 57
 * of 350 judged-out posts scored 30 or more, and the three a labeller called an
 * ask or worth a reply all did (.context/x-users/filtered-rank.py). Only four
 * of the 949 were labelled, so this is a sort, never a verdict.
 */
export const FILTERED_WORTH_SCORE = 30;

/** Native page size of the cheap twitter.search lanes; asking for more changes nothing. */
export const PAGE_SIZE = 20;
/** 0 of 496 posts over this many characters was a lead in AnyAPI's scanner. */
export const MAX_TEXT_CHARS = 4000;
/** What the judge sees: the bio's first 300 characters, each parent's first 600, two parents at most. */
export const BIO_CHARS = 300;
export const PARENT_CHARS = 600;
export const PARENT_LIMIT = 2;
/** The post text the judge reads, as Reddit's judge does. */
export const BODY_CHARS = 1500;

/**
 * Packing limits. Coined rival names may share one OR group (Eve measured it);
 * the query cap is a conservative guess until Stage-0 probe P10 measures it.
 */
export const MAX_RIVALS_PER_LANE = 6;
export const MAX_LANE_BODY_CHARS = 380;
export const MAX_QUERY_CHARS = 450;

/**
 * The llm_usage purposes X writes, which the X LLM sub-cap sums. Scoring what
 * the free screen set aside (rescore.ts) is x_rescore, apart from the judge's
 * x_score, so it never spends the day's judged allowance.
 */
export const X_PURPOSES = ["x_seeds", "x_score", "x_final", "x_reply", "x_rescore"] as const;
export type XPurpose = (typeof X_PURPOSES)[number];
/** The twitter.* SKUs X buys. */
export const X_SKUS = ["twitter.search", "twitter.tweet", "twitter.profile"] as const;

/** How many times an unanswered post is asked again before it waits for the next run. */
export const MAX_LLM_ATTEMPTS = 3;
/**
 * A scan stops booking its successor once nobody has opened the tab for this
 * long and no alert channel carries X asks: a day past a quiet product's weekly
 * check, so one open a week keeps that check alive.
 */
export const OPENED_WITHIN_DAYS = QUIET_RECHECK_DAYS + 1;
/** A lane that had this many posts judged and never produced an ask, a reply or a held post is paused. */
export const NO_YIELD_JUDGED = 60;
/** On a daily tier, a lane empty this many runs in a row is paused and hands its slot on. */
export const EMPTY_DAYS_TO_PAUSE = 3;
/** A lane paused for coming back empty is tried again after this many days. */
export const EMPTY_RETRY_DAYS = 7;
