import { AnyAPIError, InsufficientBalanceError } from "@getanyapi/sdk";
import { and, asc, eq, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects, xEvaluations, xLanes, xProjects, xRuns } from "@/db/schema";
import { enqueueOnce, writeProgress } from "@/jobs/enqueue";
import { projectHasAlertChannel } from "@/lib/alerts/channels";
import { clientForUser } from "@/lib/anyapi";
import { config } from "@/lib/config";
import { inFlight } from "@/lib/inFlight";
import { parseScoring } from "@/lib/scoring/weights";
import { LlmCapReachedError } from "@/lib/llm";
import type { ProductFacts } from "@/lib/product";
import type { FetchContext } from "@/lib/reddit/fetch";
import { loadScanProject } from "@/lib/scan/project";
import { smallSweep } from "@/lib/sweepScale";
import { capped, limitsForUser } from "@/lib/tier";
import { xLimitsFor, type XLimits } from "@/lib/tiers";
import { HOUR_MS, utcDayStart } from "@/lib/time";
import { HouseDataCapReachedError } from "@/lib/usage";
import { xCallsSince, xJudgementsSince } from "./budget";
import {
  FEED_WINDOW_DAYS,
  FIRST_LOOK_EXTRA,
  FIRST_LOOK_HOURS,
  FIRST_LOOK_PAGES,
  MAX_LLM_ATTEMPTS,
  MAX_WINDOW_HOURS,
  EMPTY_DAYS_TO_PAUSE,
  EMPTY_RETRY_DAYS,
  NO_YIELD_JUDGED,
  QUIET_RECHECK_DAYS,
  OPENED_WITHIN_DAYS,
  OVERLAP_HOURS,
  PAGE_SIZE,
  PENDING_EXPIRE_HOURS,
  PENDING_STAGES,
  REPLY_STALE_HOURS,
} from "./constants";
import { buyBio, joinedText, ParentWalkError, storedParents, walkParents } from "./context";
import { xEnabledFor } from "./enabled";
import { candidateOf, judgeX, storedRoute } from "./judge";
import { XLaneRefusedError } from "./grammar";
import { compileLanes, lanesInputHash, rivalSeeds, VENUE_FAMILIES, type SeedSlots } from "./lanes";
import { ownWords } from "./map";
import { semaphore } from "./pace";
import { checkReply } from "./reply";
import { emptyCounts, finishXRun, markFirstLead, startXRun, type XRunCounts } from "./report";
import { freeScreen, isListicle, isOwnOrRivalAccount, isVendorHook, matchedLaneTerms, PITCH_REASONS, type ScreenReason } from "./screen";
import { venueScore, type XSignals } from "./gates";
import { searched, xQuiet } from "./quiet";
import { reachScore } from "./reach";
import { scoreScreened } from "./rescore";
import { seedSlotsFor } from "./seeds";
import { searchPage, type XSearchPage } from "./skus";
import { xPostsById, type StoredXPost, type XVia } from "./store";
import { slug } from "./words";
import {
  askFrom,
  claimForBuyerLane,
  claimForThread,
  claimForVenue,
  fillMatchedPhrase,
  insertSighting,
  recordAssessment,
  updateEvaluation,
  withdrawLead,
  writeLead,
  type XEvaluation,
} from "./write";

/**
 * One X scan for one project: search its due lanes, screen what comes back,
 * buy context, judge, and write what is worth showing, one post streaming
 * through at a time so the first lead lands while the rest is still searching.
 * Two kinds are shown: an ask, someone asking for what the product does, and
 * a reply, a post worth answering where nobody is shopping, which a stronger
 * model checks with the author's bio before it is shown. A reply is either
 * someone with the problem (from a rival lane) or a venue (from a build-vs-buy
 * or workflow lane) where the job is shown or argued in front of buyers.
 *
 * X leads is monitoring, with one look back: the first scan, queued when the
 * tab first opens, reads the last thirty days (FIRST_LOOK_HOURS) on a bigger
 * allowance for that day, so the tab opens on what X already holds; every
 * scan after picks up where its lane's last window ended. Nothing here
 * touches a Reddit table.
 * A spent budget, global or X's own, or an empty wallet ends the run as
 * partial: what was bought is kept, what is pending stays pending, and the
 * next scan is still booked. One failed lookup costs its post one attempt,
 * never the run.
 */

type Lane = typeof xLanes.$inferSelect;

type StoredContext = {
  replyingTo: string[];
  selfThread: string[];
  chainIncomplete: boolean;
  text: string;
  bio?: string | null;
  /** For a post found through a reply in its thread: that reply, and the searched words it used. */
  via?: XVia;
};

/** Lanes searched at once; the twitter.* semaphore still bounds the calls. */
const LANE_CONCURRENCY = 4;
/** Posts moving through context and judging at once. */
const POST_CONCURRENCY = 8;
/** A lane that found nothing in two weeks is polled once a day until it does. */
const DEAD_LANE_DAYS = 14;
/** Reply checks in a row the model may leave unanswered before a run stops asking: an outage should cost a few checks, not the day. */
const MAX_UNANSWERED_REPLIES = 2;
/** Reply checks in flight at once. An outage costs at most this many before the run stops asking. */
export const REPLY_CONCURRENCY = 8;

/** A budget counted down in calls. Null is no cap. */
class Pool {
  constructor(private left: number | null) {}
  take(n = 1): boolean {
    if (this.left === null) return true;
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
  give(n = 1) {
    if (this.left !== null && n > 0) this.left += n;
  }
  get spent(): boolean {
    return this.left !== null && this.left <= 0;
  }
  /** What is left, or null for no cap. */
  get remaining(): number | null {
    return this.left;
  }
}

type Pools = { pages: Pool; parents: Pool; judged: Pool; profiles: Pool; replyChecks: Pool };

function remaining(cap: number | null, used: number): number | null {
  return cap === null ? null : Math.max(0, cap - used);
}

/**
 * What this scan may still buy today. Every budget is per day, so a scan
 * retried after a failure carries on with what is left rather than a fresh
 * allowance. The judged and profile pools count answered model calls, not
 * failed ones: an outage must not use up the day.
 */
async function poolsFor(projectId: string, x: XLimits, firstLook: boolean, since: Date): Promise<Pools> {
  const [pages, parents, profiles, judged, replyChecks] = await Promise.all([
    xCallsSince(projectId, "twitter.search", since),
    xCallsSince(projectId, "twitter.tweet", since),
    xJudgementsSince(projectId, "x_final", since),
    xJudgementsSince(projectId, "x_score", since),
    xJudgementsSince(projectId, "x_reply", since),
  ]);
  // The first look reads a month, so its day gets FIRST_LOOK_EXTRA on top.
  const plus = (cap: number | null, extra: number) => (cap === null ? null : cap + (firstLook ? extra : 0));
  return {
    pages: new Pool(remaining(plus(x.pagesPerDay, FIRST_LOOK_EXTRA.pages), pages)),
    parents: new Pool(remaining(plus(x.parentsPerDay, FIRST_LOOK_EXTRA.parents), parents)),
    judged: new Pool(remaining(plus(x.judgedPerDay, FIRST_LOOK_EXTRA.judged), judged)),
    profiles: new Pool(remaining(plus(x.profilesPerDay, FIRST_LOOK_EXTRA.profiles), profiles)),
    replyChecks: new Pool(remaining(plus(x.replyChecksPerDay, FIRST_LOOK_EXTRA.replyChecks), replyChecks)),
  };
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Where a lane's window starts: one hour back over its watermark, never
 * further than `maxHours` (72, a week while X is quiet, since a quiet product
 * is checked weekly and the week between must still be read, and thirty days
 * on a lane's first run). A lane that has not found a post yet has no
 * watermark, so it reaches back FIRST_LOOK_HOURS before it began watching: a
 * new lane reads the last month, and one that has come back empty for days
 * still covers every hour since, up to the cap.
 */
export function windowStart(lane: Pick<Lane, "coveredUntil" | "createdAt">, now: Date, maxHours = MAX_WINDOW_HOURS): Date {
  const nowHour = floorHour(now.getTime());
  const start = lane.coveredUntil
    ? floorHour(lane.coveredUntil.getTime() - OVERLAP_HOURS * HOUR_MS)
    : Math.min(floorHour(lane.createdAt.getTime()), nowHour) - FIRST_LOOK_HOURS * HOUR_MS;
  return new Date(Math.max(start, nowHour - maxHours * HOUR_MS));
}

/**
 * When a lane is next due. A lane that keeps coming back empty backs off, 2, 4,
 * then 8 hours, on tiers that poll more than daily: an empty page costs as much
 * as a full one. One new post resets it.
 */
export function nextDue(lane: Pick<Lane, "posts" | "createdAt">, streak: number, x: XLimits, now: Date): Date {
  let hours = x.cadenceHours;
  if (x.cadenceHours < 24 && streak >= 3) {
    hours = Math.min(2 ** (streak - 2), x.maxBackoffHours);
  }
  if (lane.posts === 0 && now.getTime() - lane.createdAt.getTime() > DEAD_LANE_DAYS * 24 * HOUR_MS) {
    hours = Math.max(hours, 24);
  }
  return new Date(now.getTime() + hours * HOUR_MS);
}

/** Host names that carry many people's products: their label names no one project. */
const SHARED_HOSTS = new Set([
  "github", "gitlab", "bitbucket", "vercel", "netlify", "herokuapp", "pages", "web", "framer", "webflow", "bubbleapps",
  "notion", "gumroad", "carrd", "wixsite", "squarespace", "myshopify", "apple", "google", "chrome", "producthunt",
  "linktr", "substack", "medium", "wordpress", "blogspot", "replit", "glitch", "onrender", "fly", "railway",
]);
/** Subdomain prefixes that name a product's front door, not the product. */
const HOST_PREFIXES = new Set(["www", "app", "apps", "get", "try", "use", "go", "my", "join", "hello", "dashboard"]);
/** Second-level suffixes, so "acme.co.uk" names acme, not co. */
const TWO_LEVEL_SUFFIXES = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/**
 * The name a project's own domain carries, for telling its own posts, threads
 * and words apart: the label before the public suffix ("getanyapi" from
 * app.getanyapi.com), the product's own subdomain on a shared host
 * ("acme" from acme.vercel.app), and nothing for a page on a shared host.
 */
export function domainLabel(url: string | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".").filter(Boolean);
  while (labels.length > 2 && HOST_PREFIXES.has(labels[0])) labels.shift();
  if (labels.length < 2) return labels[0] && !SHARED_HOSTS.has(labels[0]) ? labels[0] : null;
  const twoLevel = labels.length >= 3 && TWO_LEVEL_SUFFIXES.has(labels[labels.length - 2]);
  const registrable = labels[labels.length - (twoLevel ? 3 : 2)];
  if (!SHARED_HOSTS.has(registrable)) return registrable;
  const sub = labels[labels.length - (twoLevel ? 4 : 3)];
  return sub && !SHARED_HOSTS.has(sub) ? sub : null;
}

/**
 * The project's lanes this scan may run: every active lane (a trial-size dev
 * run takes only the lowest-ranked few, `sized`), least recently run first so
 * a short page budget rotates through them rather than starving the last.
 * Every compiled lane is stored, ranked (orderLanes). They are recompiled only
 * when the rivals, the seed words, the project's own names or the templates
 * changed: a recompile gives a paused lane another chance, a refused one stays
 * refused, and every lane the compile no longer makes is retired, whatever its
 * state, so old searches never pile up.
 */
async function syncLanes(input: {
  projectId: string;
  storedHash: string | null;
  seeds: string[];
  slots: SeedSlots | null;
  ownNames: string[];
  x: XLimits;
  now: Date;
}): Promise<Lane[]> {
  const { projectId, seeds, slots, x } = input;
  // A lane paused for coming back empty is tried again once a week: a quiet
  // search on a daily tier should not hold a slot, nor be lost for good.
  const retryEmptyBefore = new Date(input.now.getTime() - EMPTY_RETRY_DAYS * 24 * HOUR_MS);
  const active = async () => {
    const ranked = capped(
      await db()
        .select()
        .from(xLanes)
        .where(
          and(
            eq(xLanes.projectId, projectId),
            or(
              eq(xLanes.state, "active"),
              and(eq(xLanes.state, "paused"), eq(xLanes.pauseReason, "empty"), lt(xLanes.lastRunAt, retryEmptyBefore)),
            ),
          ),
        )
        .orderBy(asc(xLanes.rank), asc(xLanes.createdAt)),
      x.lanes,
    );
    return ranked.sort((a, b) => (a.lastRunAt?.getTime() ?? 0) - (b.lastRunAt?.getTime() ?? 0));
  };
  const hash = lanesInputHash(seeds, slots, input.ownNames);
  if (hash === input.storedHash) {
    return active();
  }
  const compiled = compileLanes({ rivals: seeds, slots, ownNames: input.ownNames });
  const bodies = compiled.map((lane) => lane.body);
  await db().transaction(async (tx) => {
    await tx
      .update(xLanes)
      .set({ state: "retired", pauseReason: null })
      .where(
        and(
          eq(xLanes.projectId, projectId),
          ne(xLanes.state, "retired"),
          bodies.length > 0 ? notInArray(xLanes.body, bodies) : undefined,
        ),
      );
    if (compiled.length > 0) {
      await tx
        .insert(xLanes)
        .values(
          compiled.map((lane, rank) => ({
            projectId,
            family: lane.family,
            seeds: lane.seeds,
            terms: lane.terms,
            label: lane.label,
            rank,
            body: lane.body,
          })),
        )
        .onConflictDoUpdate({
          target: [xLanes.projectId, xLanes.body],
          set: {
            rank: sql`excluded.rank`,
            family: sql`excluded.family`,
            seeds: sql`excluded.seeds`,
            terms: sql`excluded.terms`,
            label: sql`excluded.label`,
            // New inputs give a paused lane another chance; a lane X refused stays refused.
            state: sql`case when ${xLanes.state} = 'refused' then 'refused' else 'active' end`,
            pauseReason: sql`case when ${xLanes.state} = 'refused' then ${xLanes.pauseReason} else null end`,
          },
        });
    }
    await tx.update(xProjects).set({ lanesInputHash: hash }).where(eq(xProjects.projectId, projectId));
  });
  return active();
}

/**
 * Whether this scan is the project's first look, and where today's ordinary
 * allowance starts counting. The first look is every scan until one has read X
 * to the end (quiet.ts `searched`), on the day X was first scanned: one cut
 * short by a cap or a wallet is resumed the same day, and one that keeps
 * failing does not get the bigger allowance day after day. After it, the rest
 * of its day counts from when it ended, so the month it read does not use up
 * the day's hourly checks.
 */
async function firstLookState(projectId: string, runId: string): Promise<{ firstLook: boolean; since: Date }> {
  const today = utcDayStart();
  const [first] = await db()
    .select({ startedAt: xRuns.startedAt, finishedAt: xRuns.finishedAt })
    .from(xRuns)
    .where(and(eq(xRuns.projectId, projectId), searched))
    .orderBy(asc(xRuns.startedAt))
    .limit(1);
  if (first) {
    return { firstLook: false, since: first.startedAt >= today && first.finishedAt ? first.finishedAt : today };
  }
  const [earlier] = await db()
    .select({ id: xRuns.id })
    .from(xRuns)
    .where(and(eq(xRuns.projectId, projectId), ne(xRuns.id, runId), lt(xRuns.startedAt, today)))
    .limit(1);
  return { firstLook: !earlier, since: today };
}

/** A trial-size run for trying the flow over and over in dev: two searches, one page, ten judgements. */
function sized(x: XLimits): XLimits {
  if (!smallSweep()) {
    return x;
  }
  const small = (value: number | null, cap: number) => (value === null ? cap : Math.min(value, cap));
  return {
    ...x,
    lanes: small(x.lanes, 2),
    pagesPerLane: 1,
    judgedPerDay: small(x.judgedPerDay, 10),
    replyChecksPerDay: small(x.replyChecksPerDay, 5),
  };
}

/** Whether any post this lane found still waits for the judge or the reply check. */
async function laneHasWaiting(laneId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: xEvaluations.id })
    .from(xEvaluations)
    .where(and(eq(xEvaluations.laneId, laneId), inArray(xEvaluations.stage, PENDING_STAGES)))
    .limit(1);
  return Boolean(row);
}

/** A reason to stop the whole run and keep what it has: a spent budget, or a wallet with nothing left. */
function isStopError(error: unknown): boolean {
  return (
    error instanceof HouseDataCapReachedError ||
    error instanceof LlmCapReachedError ||
    error instanceof InsufficientBalanceError
  );
}

/** Whether a post answers, or opens by addressing, one of the project's own names: its own thread is never a reply to chase. */
export function ownThread(post: Pick<StoredXPost, "text">, replyingTo: string[], ownNames: string[]): boolean {
  const own = new Set(ownNames.map(slug).filter((name) => name.length >= 3));
  const leading = post.text.match(/^(?:\s*@\w{1,15})+/u)?.[0] ?? "";
  const handles = [
    ...[...leading.matchAll(/@(\w{1,15})/gu)].map((match) => match[1]),
    ...replyingTo.map((line) => line.match(/^@(\w{1,15}):/u)?.[1] ?? ""),
  ];
  return handles.some((handle) => ownHandle(slug(handle), own));
}

/** A brand's usual handle: its name, or its name with a usual affix ("getacme", "acmehq", "acme_app"). */
const HANDLE_AFFIXES = ["get", "try", "use", "join", "hq", "app", "official", "io", "ai", "team"];
function ownHandle(handle: string, own: Set<string>): boolean {
  if (own.has(handle)) return true;
  return HANDLE_AFFIXES.some((affix) => {
    const front = handle.startsWith(affix) ? handle.slice(affix.length) : null;
    const back = handle.endsWith(affix) ? handle.slice(0, -affix.length) : null;
    return (front !== null && own.has(front)) || (back !== null && own.has(back));
  });
}

/**
 * A thread's post, credited to the lane whose reply led to it, in the lane's
 * funnel as well as its verdicts, so "seen · screened out · judged" adds up.
 */
async function bumpLaneFunnel(laneId: string | null, by: { posts: number; newPosts: number; screenedOut: number }) {
  if (!laneId) return;
  await db()
    .update(xLanes)
    .set({
      posts: sql`${xLanes.posts} + ${by.posts}`,
      newPosts: sql`${xLanes.newPosts} + ${by.newPosts}`,
      screenedOut: sql`greatest(0, ${xLanes.screenedOut} + ${by.screenedOut})`,
    })
    .where(eq(xLanes.id, laneId));
}

async function bumpLane(laneId: string | null, column: "judged" | "leads" | "replies" | "reviews") {
  if (!laneId) return;
  const target = xLanes[column];
  await db()
    .update(xLanes)
    .set({ [column]: sql`${target} + 1`, ...(column === "leads" || column === "replies" ? { lastLeadAt: new Date() } : {}) })
    .where(eq(xLanes.id, laneId));
}

/**
 * Candidates nobody can finish any more: waiting longer than PENDING_EXPIRE_HOURS,
 * about a post older than the tab shows, or out of attempts. Expired before
 * anything is bought for them, so they neither cost nor linger.
 */
async function expireStale(projectId: string, now: Date) {
  const pendingCutoff = new Date(now.getTime() - PENDING_EXPIRE_HOURS * HOUR_MS);
  const postCutoff = new Date(now.getTime() - FEED_WINDOW_DAYS * 24 * HOUR_MS);
  await db()
    .update(xEvaluations)
    // A reply candidate never checked goes back to what the buyer gates made
    // of it: a held post returns to Held rather than vanishing.
    .set({
      stage: sql`case when ${xEvaluations.stage} <> 'pending_reply' then 'expired' when ${xEvaluations.decision} = 'review' then 'review' else 'rejected' end`,
    })
    .where(
      and(
        eq(xEvaluations.projectId, projectId),
        inArray(xEvaluations.stage, PENDING_STAGES),
        or(
          lt(xEvaluations.createdAt, pendingCutoff),
          sql`${xEvaluations.llmAttempts} >= ${MAX_LLM_ATTEMPTS}`,
          sql`exists (select 1 from x_posts p where p.id = ${xEvaluations.tweetId} and (p.created_at < ${postCutoff.toISOString()}::timestamptz or p.unavailable_at is not null))`,
        ),
      ),
    );
}

export async function runXScan(projectId: string, jobId: string | null): Promise<void> {
  const now = new Date();
  const [project] = await db()
    .select({ id: projects.id, userId: projects.userId, name: projects.name, url: projects.url, scoring: projects.scoring })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project || !xEnabledFor(project.userId)) {
    return;
  }
  const [state] = await db().select().from(xProjects).where(eq(xProjects.projectId, projectId));
  if (!state) {
    return;
  }
  // A scan nobody reads buys nothing: it runs while the tab was opened this
  // week, or while an alert channel carries the project's X asks (and the
  // owner has not kept X asks out of alerts). Otherwise
  // the next open queues it again.
  const openedRecently =
    state.lastOpenedAt !== null && now.getTime() - state.lastOpenedAt.getTime() <= OPENED_WITHIN_DAYS * 24 * HOUR_MS;
  if (!openedRecently && !(state.alerts && (await projectHasAlertChannel(projectId)))) {
    return;
  }
  const scanProject = await loadScanProject(projectId);
  if (!scanProject) {
    return;
  }
  const tier = await limitsForUser(project.userId);
  const x = sized(xLimitsFor(tier.limits));
  const funded = await clientForUser(project.userId);
  const ctx: FetchContext = { projectId, funded, maxAgeMs: 0 };
  const product: ProductFacts = scanProject.product;
  const ownNames = [project.name, domainLabel(project.url)].filter((name): name is string => Boolean(name));
  const run = await startXRun(projectId, jobId);
  const named = rivalSeeds(scanProject.competitors, ownNames);
  const slots = await seedSlotsFor({
    projectId,
    stored: state.seeds,
    product,
    phrasings: scanProject.phrasings,
    competitors: named,
  });
  // A competitor row that names no product ("this", "contact form") is never searched.
  const notProducts = new Set(
    (slots?.notProducts ?? []).map((name) => slug(name)).filter((name) => name.length > 0),
  );
  const seeds = named.filter((name) => !notProducts.has(slug(name)));
  // The project's first look reads the last month on a bigger allowance; a
  // trial-size dev run keeps its small caps.
  const { firstLook, since: poolsSince } = await firstLookState(projectId, run.id);
  const bigFirstLook = firstLook && !smallSweep();
  const lanes = await syncLanes({
    projectId,
    storedHash: state.lanesInputHash,
    seeds,
    slots,
    ownNames,
    x,
    now,
  });
  // Every lane the project ever had, retired ones too: a post an earlier run
  // left waiting is still read by the rule of the lane that found it.
  const allLanes = await db()
    .select({ id: xLanes.id, family: xLanes.family, label: xLanes.label, terms: xLanes.terms })
    .from(xLanes)
    .where(eq(xLanes.projectId, projectId));
  const familyOf = new Map(allLanes.map((lane) => [lane.id, lane.family]));
  const isVenue = (laneId: string | null) => (laneId ? VENUE_FAMILIES.has(familyOf.get(laneId) ?? "") : false);
  const termsOf = new Map(allLanes.map((lane) => [lane.id, lane.terms]));
  // Which reply check a candidate goes to: a venue lane's always the venue
  // check, a rival lane's the one its answers routed it to (gates.ts replyRoute).
  const venueRoute = (row: XEvaluation) => storedRoute(row.signals, row.level, row.reasonCode, row.decision, isVenue(row.laneId)) === "venue";
  const financeProduct = /financ|trading|crypto|invest|stock/iu.test(product.brief?.kind ?? "");
  // Worth-a-reply needs a product described well enough to tell its case from
  // its topic (vaguely described products were 13 of 13 noise on Reddit), and
  // a model key: without one every candidate would buy a bio and then fail.
  const replies = config().X_REPLIES && Boolean(product.brief) && Boolean(config().OPENROUTER_API_KEY);
  await expireStale(projectId, now);
  // A quiet product is checked weekly, so each check reads the whole week since the last.
  const quietBefore = await xQuiet(projectId, now);
  const maxWindowHours = quietBefore.quiet ? QUIET_RECHECK_DAYS * 24 + OVERLAP_HOURS : MAX_WINDOW_HOURS;

  const counts: XRunCounts = emptyCounts();
  const pools = await poolsFor(projectId, x, bigFirstLook, poolsSince);
  let stopped: string | null = null;
  let partial: string | null = null;
  let failure: unknown = null;
  const progress = async (line: string) => {
    if (jobId) await writeProgress(jobId, line);
  };
  const shownLine = () =>
    `${counts.leads} ${counts.leads === 1 ? "person" : "people"} asking, ${counts.replies} worth a reply, ${counts.reviews} held`;
  const stop = (error: unknown) => {
    stopped ??= error instanceof Error ? error.message : String(error);
    partial = stopped;
  };

  // Posts move through context and judging POST_CONCURRENCY at a time.
  const slot = semaphore(() => POST_CONCURRENCY);

  /** One paid lookup failed for this post: it keeps its stage and loses one attempt. */
  const lookupFailed = async (evaluation: XEvaluation, error: unknown) => {
    if (isStopError(error)) {
      stop(error);
      return;
    }
    if (!(error instanceof AnyAPIError)) {
      throw error;
    }
    partial ??= "Some X lookups failed; they are tried again next run.";
    await updateEvaluation(evaluation.id, { llmAttempts: evaluation.llmAttempts + 1 });
  };

  /**
   * A post the buyer gates turned away that Jev thinks may be worth a reply:
   * buy the author's bio unless it was bought already, then one Muse call
   * decides. Only a yes is shown; a no is a settled reject; no answer keeps the
   * post waiting, one attempt down. Run after every post is judged, best
   * candidates first, so a small daily allowance goes to the likeliest ones.
   */
  /**
   * A reply candidate that will not be shown goes back to what the buyer
   * gates made of it, keeping their reason: a held post returns to Held and
   * counts as held for its lane. Why it was not a reply is kept in
   * signals.reply beside the model's answer.
   */
  const settleCandidate = async (evaluation: XEvaluation, post: StoredXPost, reply: Record<string, unknown>) => {
    const held = evaluation.decision === "review";
    const signals = { ...((evaluation.signals as Record<string, unknown> | null) ?? {}), reply };
    await updateEvaluation(evaluation.id, { stage: held ? "review" : "rejected", signals });
    await withdrawLead(projectId, post.id);
    if (held) {
      counts.reviews += 1;
      await bumpLane(evaluation.laneId, "reviews");
    }
  };

  /**
   * Settled for free before anything is bought: waiting too long since it was
   * found, older than the first look reads, or the product's own thread.
   */
  const unpaidRefusal = (row: XEvaluation, post: StoredXPost, known: StoredContext | null): "reply_stale" | "own_thread" | null => {
    if (now.getTime() - row.createdAt.getTime() > REPLY_STALE_HOURS * HOUR_MS) return "reply_stale";
    if (now.getTime() - post.createdAt.getTime() > FIRST_LOOK_HOURS * HOUR_MS) return "reply_stale";
    if (ownThread(post, known?.replyingTo ?? [], ownNames)) return "own_thread";
    return null;
  };

  /** Returns whether the model answered, so an outage stops the loop after a check or two. */
  const checkWorthReply = async (evaluation: XEvaluation, post: StoredXPost, known: StoredContext | null): Promise<boolean> => {
    if (!pools.replyChecks.take()) return true;
    let context = known;
    // A reply check buys at most one bio, counted against the reply checks
    // alone, so replies never use up the bios the asks need.
    if (context?.bio === undefined) {
      let bio;
      try {
        bio = await buyBio(ctx, post.authorUsername);
      } catch (error) {
        pools.replyChecks.give();
        await lookupFailed(evaluation, error);
        return true;
      }
      counts.profiles += bio.bought ? 1 : 0;
      context = { ...(context ?? { replyingTo: [], selfThread: [], chainIncomplete: false, text: ownWords(post) }), bio: bio.bio };
      await updateEvaluation(evaluation.id, { context });
    }
    // A call made and not answered still spends the check: the allowance caps
    // what Muse and bios cost, answered or not. The post keeps waiting.
    const verdict = await checkReply(projectId, product, candidateOf(post, context, context.bio ?? null, venueRoute(evaluation)));
    if (!verdict) {
      return false;
    }
    counts.replyChecks += 1;
    if (!verdict.worth) {
      await settleCandidate(evaluation, post, { ...verdict.raw, code: "not_reply_worthy" });
      return true;
    }
    const signals = { ...((evaluation.signals as Record<string, unknown> | null) ?? {}), reply: verdict.raw };
    const won = await writeLead(projectId, post, {
      kind: "reply",
      score: evaluation.score ?? 0,
      fit: evaluation.fit,
      intent: evaluation.intent,
      engagement: evaluation.engagement,
      reason: verdict.why,
      quote: verdict.quote,
      moment: verdict.moment,
    });
    await updateEvaluation(evaluation.id, {
      stage: won ? "reply" : "merged",
      reasonCode: "worth_reply",
      reason: verdict.why,
      needQuote: verdict.quote,
      signals,
    });
    if (won) {
      counts.replies += 1;
      await bumpLane(evaluation.laneId, "replies");
      await markFirstLead(run.id);
      await progress(shownLine());
    }
    return true;
  };

  const processPost = async (initial: XEvaluation, post: StoredXPost): Promise<void> => {
    let evaluation = initial;
    if (stopped) return;
    const venue = isVenue(evaluation.laneId);
    let context = (evaluation.context as StoredContext | null) ?? null;
    const via = context?.via;
    try {
      if (evaluation.stage === "pending_parent") {
        // A thread's post found through a reply usually has its chain stored
        // already, by that reply's walk: then reading it costs nothing.
        let walk = via ? await storedParents(post, x.parentHops) : null;
        if (!walk) {
          if (!pools.parents.take(x.parentHops)) return;
          try {
            walk = await walkParents(ctx, post, x.parentHops);
          } catch (error) {
            // Only the hops not bought before the failure go back to the pool.
            pools.parents.give(x.parentHops - (error instanceof ParentWalkError ? error.bought : 0));
            await lookupFailed(evaluation, error instanceof ParentWalkError ? error.cause : error);
            return;
          }
          pools.parents.give(x.parentHops - walk.bought);
          counts.parents += walk.bought;
        }
        const text = joinedText(post, walk.selfThread);
        context = { replyingTo: walk.replyingTo, selfThread: walk.selfThread, chainIncomplete: walk.chainIncomplete, text, ...(via ? { via } : {}) };
        // A post found through a reply is judged, and finds nothing further.
        if (!via) {
          await judgeThread(post, walk.parents, evaluation.laneId, evaluation.matchedPhrase, true);
        }
        // A self-thread joined above the post can reveal a listicle or a hook one post alone hid.
        const rejoined =
          walk.selfThread.length > 0 ? (isListicle(text) ? "listicle" : isVendorHook(text) ? "vendor_hook" : null) : null;
        if (rejoined) {
          await updateEvaluation(evaluation.id, { context, stage: "free_rejected", freeReject: rejoined });
          counts.screenedOut[rejoined] = (counts.screenedOut[rejoined] ?? 0) + 1;
          return;
        }
        await updateEvaluation(evaluation.id, { context, stage: "pending_llm" });
        evaluation = { ...evaluation, context, stage: "pending_llm" };
      }
      if (evaluation.stage === "pending_llm") {
        // A billed but unusable answer is not given back: attempts pace the retries.
        if (!pools.judged.take()) return;
        const assessment = await judgeX(projectId, product, candidateOf(post, context, null, venue), "search", replies);
        if (!assessment) {
          await updateEvaluation(evaluation.id, { llmAttempts: evaluation.llmAttempts + 1 });
          return;
        }
        counts.judged += 1;
        await bumpLane(evaluation.laneId, "judged");
        await recordAssessment(evaluation, assessment);
        if (assessment.stage !== "pending_context" && assessment.stage !== "pending_reply") {
          return;
        }
        evaluation = { ...evaluation, stage: assessment.stage, score: assessment.score, engagement: assessment.engagement };
      }
      if (evaluation.stage === "pending_context") {
        if (!pools.profiles.take()) return;
        let bio;
        try {
          bio = await buyBio(ctx, post.authorUsername);
        } catch (error) {
          pools.profiles.give();
          await lookupFailed(evaluation, error);
          return;
        }
        counts.profiles += bio.bought ? 1 : 0;
        context = { ...(context ?? { replyingTo: [], selfThread: [], chainIncomplete: false, text: ownWords(post) }), bio: bio.bio };
        await updateEvaluation(evaluation.id, { context });
        const assessment = await judgeX(projectId, product, candidateOf(post, context, bio.bio, venue), "complete", replies);
        if (!assessment) {
          await updateEvaluation(evaluation.id, { llmAttempts: evaluation.llmAttempts + 1 });
          return;
        }
        counts.finals += 1;
        if (assessment.stage === "lead") {
          // The lead row goes first: a crash before the verdict is stored leaves
          // the post pending, and the next run writes the same lead again.
          const won = await writeLead(projectId, post, askFrom(assessment, parseScoring(project.scoring)));
          await recordAssessment(evaluation, assessment, won ? "lead" : "merged");
          if (won) {
            counts.leads += 1;
            await bumpLane(evaluation.laneId, "leads");
            await markFirstLead(run.id);
            await progress(shownLine());
          }
        } else {
          await recordAssessment(evaluation, assessment);
          await withdrawLead(projectId, post.id);
          if (assessment.stage === "review") {
            counts.reviews += 1;
            await bumpLane(evaluation.laneId, "reviews");
          }
          if (assessment.stage === "pending_reply") {
            evaluation = { ...evaluation, stage: "pending_reply", context, score: assessment.score, engagement: assessment.engagement };
          }
        }
      }
    } catch (error) {
      if (isStopError(error)) {
        stop(error);
        return;
      }
      throw error;
    }
  };

  // Every post task is tracked and drained before the run returns, so nothing
  // keeps buying after the job has let go of its lease. The first unexpected
  // error is rethrown once everything has settled.
  const work: Promise<void>[] = [];
  const processed = new Set<string>();
  const track = (evaluation: XEvaluation, post: StoredXPost) => {
    processed.add(post.id);
    work.push(
      slot(() => processPost(evaluation, post)).catch((error) => {
        failure ??= error;
        stopped ??= "An X post could not be processed.";
      }),
    );
  };
  // Work is added while work runs (a reply's thread, below), so a drain waits
  // until a pass adds nothing new.
  const drain = async () => {
    for (let size = -1; size !== work.length; ) {
      size = work.length;
      await Promise.all(work);
    }
  };

  /**
   * The posts above a matching reply, by other people, as candidates of their
   * own. On X a reply is often the only part of a thread that uses the
   * searched words, and the person it answers is the one asking: Clipy's first
   * look found "what screen recording do people use now? I had screen studio
   * but license ran out" only under "FocuSee, a great alternative to Screen
   * Studio" (2026-09-28). They were bought as the reply's context already, so
   * only judging them costs. The screen's visible-words rule is skipped, since
   * the reply carried the words, and the window is the tab's, since a thread
   * starts before its replies. A post that is mostly an image, which lurk
   * cannot read, is held for a look rather than judged on a bare link, but only
   * under a reply a person wrote: a vendor's or farm's pitch says nothing about
   * the post it sits under. A thread the product's own account posted in is
   * one it already answered. Rows are written even after a stop, since writing
   * them is free and the next run judges them.
   */
  const threadSince = new Date(now.getTime() - FEED_WINDOW_DAYS * 24 * HOUR_MS);
  const ownHandles = new Set(ownNames.map(slug).filter((name) => name.length >= 3));
  const isOwnAccount = (post: Pick<StoredXPost, "authorUsername">) => ownHandle(slug(post.authorUsername), ownHandles);
  const judgeThread = async (
    reply: StoredXPost,
    parents: StoredXPost[],
    laneId: string | null,
    phrase: string | null,
    holdImages: boolean,
  ) => {
    if ([reply, ...parents].some(isOwnAccount)) return;
    const venue = isVenue(laneId);
    for (const parent of parents) {
      const via: XVia = { tweetId: reply.id, author: reply.authorUsername, phrase };
      const context: StoredContext = { replyingTo: [], selfThread: [], chainIncomplete: false, text: ownWords(parent), via };
      const sighting = {
        projectId,
        tweetId: parent.id,
        laneId,
        // The lane's words, when the post shows them itself: the search may just not have reached it.
        matchedPhrase: laneId ? matchedLaneTerms(parent, termsOf.get(laneId) ?? [], venue) : null,
        context,
      };
      const screen = freeScreen({ post: parent, since: threadSince, ownNames, rivals: seeds, laneTerms: [], financeProduct, venue });
      // The screen's account rules come after its bare-link rule, so an image's author is checked here.
      const account = isOwnOrRivalAccount(parent, ownNames, seeds) || slug(parent.authorUsername) === "grok";
      const image = !screen.pass && screen.reason === "bare_link" && (parent.mediaCount ?? 0) > 0;
      if (image && !account && holdImages && phrase) {
        const held = await insertSighting({ ...sighting, stage: "review", freeReject: null });
        if (!held) continue;
        await updateEvaluation(held.id, {
          decision: "review",
          reasonCode: "image_only",
          reason: `Mostly an image, which lurk can't read. @${reply.authorUsername} replied in its thread using the words lurk searched for (${phrase}), so open it on X to see what they posted.`,
        });
        counts.postsFetched += 1;
        counts.postsNew += 1;
        counts.reviews += 1;
        await bumpLaneFunnel(laneId, { posts: 1, newPosts: 1, screenedOut: 0 });
        await bumpLane(laneId, "reviews");
        continue;
      }
      const refusal = screen.pass ? null : image && account ? "own_or_rival_account" : screen.reason;
      const stage = refusal ? "free_rejected" : parent.isReply ? "pending_parent" : "pending_llm";
      const inserted = await insertSighting({ ...sighting, stage, freeReject: refusal });
      if (!inserted) {
        // A search that returned it without the searched words screened it out; the reply had them.
        const claimed = !refusal && !processed.has(parent.id) ? await claimForThread({ projectId, tweetId: parent.id, stage, context }) : null;
        if (claimed) {
          await bumpLaneFunnel(claimed.laneId, { posts: 0, newPosts: 0, screenedOut: -1 });
          track(claimed, parent);
        }
        continue;
      }
      counts.postsFetched += 1;
      counts.postsNew += 1;
      await bumpLaneFunnel(laneId, { posts: 1, newPosts: 1, screenedOut: refusal ? 1 : 0 });
      if (refusal) {
        counts.screenedOut[refusal] = (counts.screenedOut[refusal] ?? 0) + 1;
        continue;
      }
      track(inserted, parent);
    }
  };

  /**
   * A reply the screen dropped for who wrote it (a rival's account, a vendor's
   * pitch, a farm) that used the searched words: never a lead itself, but it
   * was written under someone's post, and that post is often the ask. Its
   * thread is walked once, when it is first seen; a walk that fails, or that
   * finds the parent lookups spent or held by walks in flight, is not tried
   * again.
   */
  const trackPitchThread = (sighting: XEvaluation, reply: StoredXPost, phrase: string) => {
    work.push(
      slot(async () => {
        if (stopped || !pools.parents.take(x.parentHops)) return;
        let walk;
        try {
          walk = await walkParents(ctx, reply, x.parentHops);
        } catch (error) {
          pools.parents.give(x.parentHops - (error instanceof ParentWalkError ? error.bought : 0));
          const cause = error instanceof ParentWalkError ? error.cause : error;
          if (isStopError(cause)) stop(cause);
          else if (!(cause instanceof AnyAPIError)) throw cause;
          return;
        }
        pools.parents.give(x.parentHops - walk.bought);
        counts.parents += walk.bought;
        const context: StoredContext = {
          replyingTo: walk.replyingTo,
          selfThread: walk.selfThread,
          chainIncomplete: walk.chainIncomplete,
          text: joinedText(reply, walk.selfThread),
        };
        await updateEvaluation(sighting.id, { context });
        await judgeThread(reply, walk.parents, sighting.laneId, phrase, false);
      }).catch((error) => {
        if (isStopError(error)) {
          stop(error);
          return;
        }
        failure ??= error;
        stopped ??= "An X post could not be processed.";
      }),
    );
  };

  // Each post this run has screened, with why the lane that saw it first dropped it.
  const seen = new Map<string, ScreenReason | null>();
  let firstLookPages = FIRST_LOOK_PAGES;

  const searchLane = async (lane: Lane): Promise<void> => {
    if (stopped) return;
    const firstRun = lane.runs === 0;
    const since = windowStart(firstRun ? { coveredUntil: null, createdAt: now } : lane, now, firstRun ? FIRST_LOOK_HOURS : maxWindowHours);
    // A lane's first run on the project's first look may read the month page by page.
    const maxPages = firstRun && bigFirstLook ? firstLookPages : x.pagesPerLane;
    const sinceSec = Math.floor(since.getTime() / 1000);
    const posts: StoredXPost[] = [];
    let pages = 0;
    let empty = 0;
    // A full page still inside the window that this run could not follow: more was there to read.
    let couldNotFollow = false;
    const buyPage = async (cursor: string | null): Promise<XSearchPage | null> => {
      if (!pools.pages.take()) {
        partial ??= "Today's X search budget is used.";
        return null;
      }
      try {
        const result = await searchPage(ctx, lane.body, sinceSec, cursor);
        if (result.reused) pools.pages.give();
        else pages += 1;
        return result.value;
      } catch (error) {
        pools.pages.give();
        throw error;
      }
    };
    const laneFailed = async (error: unknown) => {
      if (isStopError(error)) {
        stop(error);
        return;
      }
      const code = error instanceof AnyAPIError ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const refused = code === "malformed_query" || error instanceof XLaneRefusedError;
      await db()
        .update(xLanes)
        .set({ lastError: message.slice(0, 500), ...(refused ? { state: "refused" } : {}) })
        .where(eq(xLanes.id, lane.id));
    };
    try {
      const first = await buyPage(null);
      if (!first) return;
      posts.push(...first.posts);
      if (first.posts.length === 0) empty += 1;
      // The next page only after a full one still inside the window: after a
      // short one, 346 of 350 second pages AnyAPI bought were empty. A failed
      // page never costs the pages before it.
      const more = (page: XSearchPage) =>
        page.posts.length >= PAGE_SIZE &&
        Boolean(page.nextCursor) &&
        page.posts.reduce((min, post) => Math.min(min, post.createdAt.getTime()), Infinity) > since.getTime();
      let last = first;
      let bought = 1;
      while (more(last) && bought < maxPages) {
        let next: XSearchPage | null;
        try {
          next = await buyPage(last.nextCursor);
        } catch (error) {
          await laneFailed(error);
          break;
        }
        if (!next) break;
        bought += 1;
        posts.push(...next.posts);
        if (next.posts.length === 0) empty += 1;
        last = next;
      }
      couldNotFollow = more(last);
    } catch (error) {
      await laneFailed(error);
      return;
    }

    counts.lanesRun += 1;
    counts.pages += pages;
    counts.emptyPages += empty;
    counts.postsFetched += posts.length;
    let newPosts = 0;
    let screenedOut = 0;
    // A farm posts the same pitch across many conversations; a buyer in a busy
    // thread of their own posts many times in one.
    const conversationsByAuthor = new Map<string, Set<string>>();
    for (const post of posts) {
      const author = post.authorUsername.toLowerCase();
      const seenIn = conversationsByAuthor.get(author) ?? new Set<string>();
      seenIn.add(post.conversationId ?? post.id);
      conversationsByAuthor.set(author, seenIn);
    }
    const venue = VENUE_FAMILIES.has(lane.family);
    for (const post of posts) {
      // A venue lane still reads a post another lane of this run saw: the rival
      // screen's one-sentence rule may have dropped a workflow it would keep.
      // So does a buyer lane one that lane dropped for not showing its words.
      const seenBefore = seen.has(post.id);
      if (seenBefore && !venue && seen.get(post.id) !== "no_visible_term") continue;
      const screen = freeScreen({
        post,
        since,
        ownNames,
        rivals: seeds,
        laneTerms: lane.terms,
        authorPostsOnPage: conversationsByAuthor.get(post.authorUsername.toLowerCase())?.size,
        financeProduct,
        venue,
      });
      if (!seenBefore) seen.set(post.id, screen.pass ? null : screen.reason);
      const stage = screen.pass ? (post.isReply ? "pending_parent" : "pending_llm") : "free_rejected";
      const matchedPhrase = matchedLaneTerms(post, lane.terms, venue);
      const sighting = await insertSighting({
        projectId,
        tweetId: post.id,
        laneId: lane.id,
        matchedPhrase,
        stage,
        freeReject: screen.pass ? null : screen.reason,
      });
      if (!sighting) {
        // A thread's walk may have written it first: the words this search matched still show on its card.
        if (screen.pass && matchedPhrase) await fillMatchedPhrase(projectId, post.id, matchedPhrase);
        // A post a rival or request lane screened out that a venue lane keeps is
        // the venue lane's to judge; one any lane dropped only for its words is
        // the buyer lane's whose words it shows.
        if (screen.pass && !processed.has(post.id)) {
          const claim = venue ? claimForVenue : claimForBuyerLane;
          const claimed = await claim({ projectId, tweetId: post.id, laneId: lane.id, stage, matchedPhrase });
          if (claimed) track(claimed, post);
        }
        continue;
      }
      if (seenBefore) continue;
      newPosts += 1;
      counts.postsNew += 1;
      if (!screen.pass) {
        screenedOut += 1;
        counts.screenedOut[screen.reason] = (counts.screenedOut[screen.reason] ?? 0) + 1;
        // The product's own replies are threads it already answered.
        if (post.isReply && post.inReplyToId && matchedPhrase && PITCH_REASONS.has(screen.reason) && !isOwnAccount(post)) {
          trackPitchThread(sighting, post, matchedPhrase);
        }
        continue;
      }
      track(sighting, post);
    }

    // Only posts the screen let through end a lane's empty streak: a lane that
    // finds nothing but bots and launches is as empty as one that finds nothing.
    // So does a lead since its last run, which a thread under a vendor's reply
    // it found can turn up after that run wrote its row.
    const yielded = Boolean(lane.lastLeadAt && lane.lastRunAt && lane.lastLeadAt >= lane.lastRunAt);
    const streak = newPosts - screenedOut > 0 || yielded ? 0 : lane.emptyStreak + 1;
    const totalPosts = lane.posts + posts.length;
    // Yield is judged on posts actually judged, with none still waiting to be:
    // a free project judges 30 a day, so counting what the screen let through
    // would pause a busy lane before anything it found was read.
    const noYield =
      lane.judged >= NO_YIELD_JUDGED &&
      lane.leads + lane.replies + lane.reviews === 0 &&
      !(await laneHasWaiting(lane.id));
    // On a daily tier an empty lane holds one of a few slots for good; three
    // empty days in a row pause it and the next lane by rank takes the slot.
    const dead = x.cadenceHours >= 24 && streak >= EMPTY_DAYS_TO_PAUSE;
    await db()
      .update(xLanes)
      .set({
        runs: sql`${xLanes.runs} + 1`,
        pages: sql`${xLanes.pages} + ${pages}`,
        emptyPages: sql`${xLanes.emptyPages} + ${empty}`,
        fullPages: sql`${xLanes.fullPages} + ${couldNotFollow ? 1 : 0}`,
        posts: sql`${xLanes.posts} + ${posts.length}`,
        newPosts: sql`${xLanes.newPosts} + ${newPosts}`,
        screenedOut: sql`${xLanes.screenedOut} + ${screenedOut}`,
        // An empty first page never moves the watermark: a false empty loses
        // nothing, and the next window grows to cover it.
        ...(posts.length > 0 ? { coveredUntil: now } : {}),
        emptyStreak: streak,
        nextDueAt: nextDue({ posts: totalPosts, createdAt: firstRun ? now : lane.createdAt }, streak, x, now),
        lastRunAt: now,
        // A lane stored at compile time may first run days later, when a slot
        // frees up; its life, and its first look, start then.
        ...(firstRun ? { createdAt: now } : {}),
        ...(noYield
          ? { state: "paused", pauseReason: "no_yield" }
          : dead
            ? { state: "paused", pauseReason: "empty" }
            : lane.state === "paused"
              ? { state: "active", pauseReason: null }
              : {}),
      })
      .where(eq(xLanes.id, lane.id));
    counts.fullPages += couldNotFollow ? 1 : 0;
  };

  const due = lanes.filter((lane) => !lane.nextDueAt || lane.nextDueAt <= now);
  // The first look shares its pages out evenly, so the first searches cannot
  // spend what the last ones need and cut the look short.
  const pagesLeft = pools.pages.remaining;
  firstLookPages = Math.max(
    x.pagesPerLane,
    Math.min(FIRST_LOOK_PAGES, pagesLeft === null ? FIRST_LOOK_PAGES : Math.floor(pagesLeft / Math.max(1, due.length))),
  );
  // The tab puts "Searching X now:" before this line.
  const searches = `${due.length} ${due.length === 1 ? "search" : "searches"}`;
  await progress(due.length === 0 ? "checking posts found earlier" : firstLook ? `the last 30 days, ${searches}` : searches);
  await inFlight(
    due,
    async (lane) => {
      // An unexpected error in one lane stops the run the way a post's does:
      // the posts already moving are drained and the run is finished first.
      try {
        await searchLane(lane);
      } catch (error) {
        failure ??= error;
        stopped ??= "An X search could not be processed.";
      }
    },
    LANE_CONCURRENCY,
  );
  await drain();

  // Posts earlier runs left waiting: out of budget then, or unanswered. A post
  // this run's search found again but did not process is one of them.
  if (!stopped) {
    const pending = await db()
      .select()
      .from(xEvaluations)
      .where(
        and(
          eq(xEvaluations.projectId, projectId),
          inArray(
            xEvaluations.stage,
            PENDING_STAGES.filter((stage) => stage !== "pending_reply"),
          ),
        ),
      )
      .orderBy(sql`${xEvaluations.createdAt} desc`)
      .limit(200);
    const leftover = pending.filter((row) => !processed.has(row.tweetId));
    const byId = await xPostsById(leftover.map((row) => row.tweetId));
    for (const row of leftover) {
      const post = byId.get(row.tweetId);
      if (post) track(row, post);
    }
    await drain();
  }

  // Then the reply check, this run's candidates and any still waiting, best
  // first. With replies off (the switch, no brief, no model key) every waiting
  // candidate goes back to what the buyer gates made of it and nothing is paid
  // for. A candidate too old or in the product's own thread is settled for
  // free whether or not the day's checks are spent.
  if (!stopped) {
    const candidates = await db()
      .select()
      .from(xEvaluations)
      .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.stage, "pending_reply")))
      .orderBy(sql`${xEvaluations.score} desc nulls last`, sql`${xEvaluations.createdAt} desc`)
      .limit(200);
    const byId = await xPostsById(candidates.map((row) => row.tweetId));
    // A venue post is worth most while it is being read, so its place is scored
    // again with its reach now: a stored score froze its freshness at judging.
    const current = (row: XEvaluation): number => {
      const post = byId.get(row.tweetId);
      if (!post || !venueRoute(row)) return row.score ?? 0;
      const fwr = (row.signals as Record<string, { type?: string; noul?: number }> | null)?.founder_would_reply;
      return venueScore({ founderWouldReply: fwr?.type === "noul" ? (fwr.noul ?? 0) : 0 } as XSignals, reachScore(post, now));
    };
    candidates.sort((a, b) => current(b) - current(a));
    // REPLY_CONCURRENCY checks at a time, best first: a Muse check takes about
    // 30 s, so one after another a first look's twenty-odd kept its replies
    // back for over ten minutes (AnyAPI, 2026-09-28).
    let unanswered = 0;
    await inFlight(
      candidates,
      async (row) => {
        if (stopped || failure) return;
        const post = byId.get(row.tweetId);
        if (!post) return;
        const known = (row.context as StoredContext | null) ?? null;
        try {
          const refusal = replies ? unpaidRefusal(row, post, known) : "replies_off";
          if (refusal) {
            await settleCandidate(row, post, { code: refusal });
            return;
          }
          // A scan kept alive only by an alert channel sends asks: a reply
          // candidate waits for the tab to be opened, or settles for free.
          if (!openedRecently || pools.replyChecks.spent || unanswered >= MAX_UNANSWERED_REPLIES) return;
          unanswered = (await checkWorthReply(row, post, known)) ? 0 : unanswered + 1;
        } catch (error) {
          if (isStopError(error)) {
            stop(error);
            return;
          }
          failure ??= error;
        }
      },
      REPLY_CONCURRENCY,
    );
  }
  // Last, and only for a tab someone reads: a score for what the free screen
  // set aside, so Filtered out ranks it. Nothing waits on it and nothing is
  // shown because of it; a spent budget ends the run as anywhere else.
  if (!stopped && !failure && openedRecently) {
    try {
      await scoreScreened(projectId, product);
    } catch (error) {
      if (isStopError(error)) stop(error);
      else failure ??= error;
    }
  }
  if (failure) {
    await finishXRun(run, counts, partial ?? "stopped by an error");
    throw failure;
  }

  await finishXRun(run, counts, partial);
  await db().update(xProjects).set({ lastScanAt: now }).where(eq(xProjects.projectId, projectId));

  // The next run: when the earliest lane is due, never sooner than the tier's
  // cadence, and a week out while X is quiet for this product, unless this run
  // was cut short by a budget or a wallet. On a plan with Scan now presses a
  // press still runs it at once.
  const [soonest] = await db()
    .select({ at: sql<Date | null>`min(${xLanes.nextDueAt})` })
    .from(xLanes)
    .where(and(eq(xLanes.projectId, projectId), eq(xLanes.state, "active")));
  const cadenceAt = now.getTime() + x.cadenceHours * HOUR_MS;
  const laneAt = soonest?.at ? new Date(soonest.at).getTime() : cadenceAt;
  const cutShort = partial !== null && !/lookups failed/u.test(partial);
  const quietAt = !cutShort && (await xQuiet(projectId, now)).quiet ? now.getTime() + QUIET_RECHECK_DAYS * 24 * HOUR_MS : 0;
  await enqueueOnce("x_scan", new Date(Math.max(cadenceAt, laneAt, quietAt)), projectId);
}

/** Scan now: every active lane of the project is due at once. */
export async function markLanesDue(projectId: string) {
  await db()
    .update(xLanes)
    .set({ nextDueAt: new Date() })
    .where(and(eq(xLanes.projectId, projectId), eq(xLanes.state, "active")));
}
