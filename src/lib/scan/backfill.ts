import { writeProgress } from "@/jobs/enqueue";
import { clientForUser } from "@/lib/anyapi";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchSearch } from "@/lib/reddit/skus";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import { asRawPost, upsertPosts, type StoredPost } from "@/lib/reddit/store";
import { constraintQueries } from "@/lib/discovery/rank";
import { TRIAGE_BATCH_SIZE } from "./constants";
import { retrieved, type PlanRow } from "./coverage";
import { loadEvaluations, writeEvaluations } from "./evaluations";
import { writeLeads, type LeadRow } from "./leads";
import { requireScanProject, type ScanProject } from "./project";
import { SMALL_SWEEP, smallSweep, spread } from "@/lib/sweepScale";
import {
  evaluationsFor,
  fetchAvatars,
  postItem,
  toLead,
  triagedOrder,
  unjudged,
} from "./judging";
import type { Judgement } from "./judgement";
import { judgeItems } from "./score";
import type { StoredJudgement } from "./evaluations";
import { sweepSearches } from "./searches";
import { creditSources, keepSearches, markCovered, recordSources, type CandidateSource } from "./sources";

/**
 * The one-time sweep a new project starts with. A scan polls the last thirty
 * days; this asks Reddit's own search for a year of the problem's language, in
 * the order of relevance, and keeps everything it finds however old it
 * is, because a person who asked eleven months ago is still the person a
 * founder wants to answer. There is no reading gate and no `reddit.post` call
 * here: search now carries the body, and the reading costs more than judging
 * the same post twice would. It never writes `seo_opportunities` either, which
 * is what keeps the Reddit SEO tab a Google-only list.
 *
 * What it spends is bounded four ways, the first three measured 2026-09-18 on a sweep of
 * 22 walks that read every page: 4,229 posts, 137 leads, $0.46. Read this way
 * the same sweep keeps 130 of the 137 for $0.11:
 *
 *   depth    walks read FIRST_PASS_PAGES, and only the DEEP_WALKS that found the
 *            most leads there read on, to DEPTH_PAGES. Pages one and two held
 *            71% of the qualified leads in 18% of the posts; pages nine and
 *            later held 3 in 1,074.
 *   triage   a title under ASKING_FLOOR is not scored. Scoring a post costs
 *            six times what triaging it does, and 95% of scored posts were
 *            rejected.
 *   budget   POST_BUDGET posts, whatever the plan's size, so one project's
 *            first sweep costs about $0.20 at most.
 *   leads    LEAD_CAP buyer leads, and the sweep stops searching and scoring.
 */

/** Lead authors a sweep looks up, best leads first. $0.00038 each through `reddit.avatar`, so 2¢. */
const FACES = 50;

/**
 * How long posts wait for a triage call's worth to join them. Pages land a
 * couple of seconds apart, but one slow search can hold the rest for minutes:
 * on 2026-09-24 two `reddit.search` calls took 141 s, and the 50 posts
 * already in sat unjudged behind them, so a new project's first lead came
 * two and a half minutes in rather than four seconds. Past this, what is
 * queued is judged as it is.
 */
const QUIET_MS = 3000;

/** Pages in a row carrying nothing new to their walk before the walk ends. */
const STALE_PAGES = 3;

/**
 * How often a sweep rewrites its progress line. Its counts move with every
 * page found and every post scored, which is up to sixty writes in flight on
 * a ten-connection pool, and the person watching reads a line a second at most.
 */
const REPORT_EVERY_MS = 1000;

/**
 * Pages each walk reads in the first pass, before any walk reads more. A page
 * takes about two seconds and a walk reads its pages one after another, so
 * the first pass is over in about as many seconds as this times two, whatever
 * the deepest listing holds; measured 2026-09-18, one relevance walk needed
 * 59 pages and the sweep waited 53 seconds on it. The walks then pick up from
 * their cursors and read the rest of the year.
 *
 * One page, of 25 posts, since 2026-09-19: a sweep now asks some twenty more
 * searches than the page's own phrasings (src/lib/scan/searches.ts), and what
 * a search finds on its first page says what the rest of it holds. Measured on
 * 24 projects and 557 searches, the leads on page one ranked a search's two
 * pages at 0.89 (Spearman, the median project) and its second page alone at
 * 0.59, where the share of its titles passing triage managed 0.37.
 */
const FIRST_PASS_PAGES = 1;

/**
 * Walks that read past the first pass: the ones whose first page found the most
 * leads. On the same 24 projects, every search read two pages deep found 1,886
 * leads at 6.8 in 100 posts; the best eight by page one, 1,614 at 8.6. Two
 * more than that because a plan's keywords are walked here as well.
 */
const DEEP_WALKS = 10;

/** Searches of the sweep's own that a project's scans go on asking: the ones that found the most leads. */
const KEPT_SEARCHES = 8;

/** Pages a walk reads in all, when its first pass found a lead. */
const DEPTH_PAGES = 6;

/**
 * Posts one sweep may find. A found post costs about $0.000076 all in: its
 * share of a search page, its title's triage, and the scoring of the 41% that
 * pass the floor. 2,500 of them is $0.19.
 */
const POST_BUDGET = 2500;

/**
 * Buyer leads a sweep stops at. The 2026-09-18 sweep wrote 337 of them, more
 * than one person answers, and the searching and scoring after the first 150
 * were over half of what it spent. Walks read by relevance and their first
 * pages first, so the ones kept are the ones Reddit ranked highest. A chunk
 * already being judged finishes, so a sweep can end a few over.
 */
const LEAD_CAP = 150;

/**
 * The triage `asking` a title needs before its post is scored. Measured on the
 * 3,914 posts the sweep above scored (.context/probe-triage.ts): 0.10 keeps
 * 1,616 of them and every one of the 137 leads; 0.20 keeps 1,012 and loses 4.
 */
const ASKING_FLOOR = 0.1;

/**
 * The order a query is read in. It was both of Reddit's, until the newest-first
 * copy of each search was measured 2026-09-18 on the first six pages of four
 * projects' walks (a data API, a form builder, a hotel finder twice): 1,306 of
 * the 2,095 posts scored were ones only it found, and 5 of the 289 leads. It
 * doubled the search pages and more than doubled the scoring for 2% of the leads.
 */
const SORTS = ["relevance"] as const;

export type BackfillOutcome = {
  /** Query and sort pairs walked. */
  walks: number;
  /** Distinct posts the sweep found. */
  found: number;
  /** Posts this project had no verdict on, so this sweep judged them. */
  judged: number;
  /** Leads written, of either kind. */
  leads: number;
  /** Walks a failed page ended before Reddit ran out of pages. */
  cutShort: number;
};

/** One query, as it is asked and what plan rows it credits. */
type Query = { text: string; rows: PlanRow[] };

/**
 * The whole of one query in one order, page after page. The walk stops when
 * Reddit stops handing out a cursor, or hands back the one just followed. It
 * does not stop on a page that carried nothing new: measured 2026-09-10, the
 * relevance sort returns sparse pages in the middle of a listing (2, 6, 6, 1,
 * 0, then six full pages), so treating the first of them as the end truncated
 * `(hotel OR hotels) AND "under 21"` to 16 posts where the listing holds 150.
 * It also stops when the listing stops moving: three pages in a row that carry
 * nothing this walk has not already seen. Measured 2026-09-18 on the cheapest
 * source, a relevance walk ran 183 pages for 302 posts, every page after the
 * eleventh the same posts under a new cursor, and the walk before the stop
 * was the whole cost of the sweep.
 *
 * A page that fails ends this walk and nothing else. Measured 2026-09-14 on
 * lurk.so: 13 of 380 paged searches in two days came back "all providers
 * failed", a transient upstream error, and each one threw away a whole sweep
 * of dozens of walks and made its person wait a scan interval for the retry.
 * The pages before it are kept; the true answer is whether it was cut short.
 */
type Walk = {
  query: Query;
  sort: (typeof SORTS)[number];
  /** Where to continue from; unset before the first page. */
  cursor?: string;
  /** Posts this walk has already been handed, to notice a listing that stops moving. */
  walked: Set<string>;
  stale: number;
};

/** How a walk ended: at the end of its listing, at its page cap or the sweep's post budget, or on a failed page. */
type WalkEnd = "done" | "paused" | "cutShort";

async function walk(
  ctx: FetchContext,
  state: Walk,
  maxPages: number,
  postBudget: number,
  found: Map<string, StoredPost>,
  sources: Map<string, CandidateSource[]>,
  landed: (posts: StoredPost[]) => void,
  full: () => boolean,
): Promise<WalkEnd> {
  const { query, sort, walked } = state;
  let { cursor, stale } = state;
  for (let pages = 0; ; pages += 1) {
    if (pages >= maxPages || found.size >= postBudget || full()) {
      state.cursor = cursor;
      state.stale = stale;
      return "paused";
    }
    let result: Awaited<ReturnType<typeof fetchSearch>>;
    try {
      result = await fetchSearch(ctx, query.text, {
        timeframe: "year",
        sort,
        operation: ACQUISITION_OPERATIONS.lead_search,
        ...(cursor ? { cursor } : {}),
      });
    } catch {
      return "cutShort";
    }
    const fresh: StoredPost[] = [];
    let moved = false;
    for (const post of result.value.posts) {
      if (!walked.has(post.id)) {
        walked.add(post.id);
        moved = true;
      }
      if (!found.has(post.id)) {
        // Every walk checks the budget before its page and all of them are in
        // flight at once, so without this the pages already asked for land on
        // top of it: the 2026-09-18 sweep found 4,164 posts on a budget of 2,500.
        if (found.size >= postBudget) {
          continue;
        }
        fresh.push(post);
      }
      found.set(post.id, post);
      const held = sources.get(post.id) ?? [];
      held.push({ kind: "search", key: query.text, rows: query.rows });
      sources.set(post.id, held);
    }
    landed(fresh);
    stale = moved ? 0 : stale + 1;
    const next = result.value.nextCursor ?? undefined;
    if (!next || next === cursor || stale >= STALE_PAGES) {
      return "done";
    }
    cursor = next;
  }
}

/**
 * Everything this project knows how to ask: each keyword row split into one
 * search per constraint, so no single constraint's posts are lost behind a
 * bounded listing (see `constraintQueries`), and each phrasing of the problem
 * as plain words. Measured 2026-09-10: a quoted phrasing returned nothing,
 * because a buyer rarely types the profile's exact sentence.
 */
function queriesOf(project: ScanProject, added: string[] = []): Query[] {
  const rows = retrieved(project.queries);
  const byText = new Map<string, Query>();
  const add = (text: string, row: PlanRow | null) => {
    const held = byText.get(text) ?? { text, rows: [] as PlanRow[] };
    if (row) {
      held.rows.push(row);
    }
    byText.set(text, held);
  };
  // Two compiled keywords that differ only in a constraint the other also has
  // split into the same searches, and a query is walked once however many plan
  // rows it covers. Each row it covers is still credited.
  for (const row of rows) {
    for (const text of constraintQueries(row.key)) {
      add(text, row);
    }
  }
  for (const phrasing of [...project.phrasings, ...added]) {
    add(phrasing, null);
  }
  return [...byText.values()];
}

async function progress(jobId: string | undefined, text: string): Promise<void> {
  if (jobId) {
    await writeProgress(jobId, text);
  }
}

/**
 * Judges posts as the pages carrying them land, while the other walks are
 * still searching. Posts queue until a triage call's worth has arrived, or
 * the search is over, and each chunk is triaged, ordered, judged and
 * committed batch by batch before the next chunk starts. The 2026-09-17 run
 * searched for 51 seconds before judging its first title; the person watching
 * their feed sees leads in the first few seconds of a sweep instead.
 */
class Judge {
  private pending: StoredPost[] = [];
  private seen = new Set<string>();
  private running: Promise<void> | null = null;
  private draining = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  readonly judged: Judgement[] = [];
  readonly leads: LeadRow[] = [];
  readonly candidates: StoredPost[] = [];

  constructor(
    private readonly project: ScanProject,
    private readonly stored: Map<string, StoredJudgement>,
    private readonly sources: Map<string, CandidateSource[]>,
    private readonly report: () => Promise<void>,
  ) {}

  /** True once the sweep holds LEAD_CAP buyer leads; nothing more is searched or scored. */
  get full(): boolean {
    return this.leads.length >= LEAD_CAP;
  }

  /** Posts a page just carried; only the ones with no verdict are queued. */
  offer(posts: StoredPost[]): void {
    for (const post of unjudged(this.project, this.stored, posts)) {
      if (!this.seen.has(post.id)) {
        this.seen.add(post.id);
        this.pending.push(post);
      }
    }
    this.pump();
  }

  /** Judges whatever is queued, and resolves once every chunk has landed. */
  async settle(): Promise<void> {
    this.stopQuiet();
    this.draining = true;
    this.pump();
    while (this.running) {
      await this.running;
    }
    this.draining = false;
  }

  private stopQuiet(): void {
    if (this.quiet) {
      clearTimeout(this.quiet);
      this.quiet = null;
    }
  }

  private pump(flush = false): void {
    if (this.running) {
      return;
    }
    this.stopQuiet();
    if (this.pending.length === 0) {
      return;
    }
    if (!this.draining && !flush && this.pending.length < TRIAGE_BATCH_SIZE) {
      this.quiet = setTimeout(() => {
        this.quiet = null;
        this.pump(true);
      }, QUIET_MS);
      return;
    }
    const chunk = this.pending;
    this.pending = [];
    this.running = this.judge(chunk).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async judge(chunk: StoredPost[]): Promise<void> {
    if (this.full) {
      return;
    }
    // Retention can delete an unreferenced post while this sweep still holds
    // it, so re-persist the chunk before pointing a source or a lead at it.
    await upsertPosts(chunk.map(asRawPost));
    await recordSources(
      this.project.id,
      chunk.map((post) => ({ postId: post.id, sources: this.sources.get(post.id) ?? [] })),
    );
    this.candidates.push(...chunk);
    const ordered = await triagedOrder(
      this.project.id,
      this.project.product,
      chunk,
      ASKING_FLOOR,
    );

    // Every batch of verdicts is committed the moment it lands, so the feed
    // fills while the sweep is still running. A batch whose commit fails is
    // not lost either: whatever is still uncommitted is written from the list
    // judgeItems returns.
    const committed = new Set<string>();
    const commit = async (batch: Judgement[]): Promise<void> => {
      const written = batch
        .filter((judgement) => judgement.decision === "qualify")
        .map((judgement) => toLead(this.project, judgement, judgement.id, null));
      // Leads first: a stored verdict stops a post being judged again, so it
      // must never exist without the lead it stands for.
      await writeLeads(written);
      await writeEvaluations(evaluationsFor(this.project, chunk, batch));
      this.leads.push(...written);
      for (const judgement of batch) {
        committed.add(judgement.id);
      }
      this.judged.push(...batch);
      await this.report();
    };
    const judgements = await judgeItems(
      this.project.id,
      this.project.product,
      ordered.map(postItem),
      new Map(),
      commit,
    );
    const uncommitted = judgements.filter((judgement) => !committed.has(judgement.id));
    if (uncommitted.length > 0) {
      await commit(uncommitted);
    }
  }
}

/** One backfill: sweep a year, judge what has no verdict, write the leads. */
export async function runBackfill(projectId: string, jobId?: string): Promise<BackfillOutcome> {
  const project = await requireScanProject(projectId);
  // These reads supply nothing to the search-writing model. On 2026-09-25
  // that call took 11-15 seconds at the median; use that wait to prepare the
  // client and the held verdicts, then start exactly the same walks together.
  // Keep the post-discovery product: Google can add competitors to its input.
  const small = smallSweep();
  const [funded, stored, added] = await Promise.all([
    clientForUser(project.userId),
    loadEvaluations(projectId),
    small ? Promise.resolve([]) : sweepSearches(projectId, project.product),
    progress(jobId, "Working out what your buyers search for"),
  ]);
  // A backfill reuses nothing. A retry exists because the first attempt was
  // truncated or died, and a cached page from that attempt would hand the retry
  // the same truncated listing: the 2026-09-10 run served all 532 of its
  // searches from the cache of earlier failures and so never reached Reddit.
  const ctx: FetchContext = { projectId, funded, maxAgeMs: 0 };

  // A trial-size sweep is the same sweep over less: see src/lib/sweepScale.ts.
  const all = queriesOf(project, added);
  const queries = small ? spread(all, SMALL_SWEEP.queries) : all;
  const postBudget = small ? SMALL_SWEEP.posts : POST_BUDGET;
  const firstPassPages = small ? SMALL_SWEEP.pages : FIRST_PASS_PAGES;
  const depthPages = small ? SMALL_SWEEP.pages : DEPTH_PAGES;
  const found = new Map<string, StoredPost>();
  const sourcesByPost = new Map<string, CandidateSource[]>();
  const plan: Walk[] = queries.flatMap((query) =>
    SORTS.map((sort) => ({ query, sort, walked: new Set<string>(), stale: 0 })),
  );
  let walks = 0;
  let cutShort = 0;
  let pass: "first" | "rest" | "scoring" = "first";
  let reportedAt = 0;
  // At most once every REPORT_EVERY_MS. A new pass and the counts the sweep
  // ends on are forced through, so no line a person should see is skipped.
  const report = (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - reportedAt < REPORT_EVERY_MS) {
      return Promise.resolve();
    }
    reportedAt = now;
    return progress(
      jobId,
      pass === "first"
        ? `First pass over a year of Reddit · ${plan.length} searches · ${found.size} posts found · ${judge.judged.length} scored · ${judge.leads.length} leads`
        : pass === "rest"
          ? `Reading further where the leads are · ${walks} of ${plan.length} searches done · ${found.size} posts found · ${judge.judged.length} scored · ${judge.leads.length} leads`
          : `Scoring ${judge.candidates.length} posts · ${judge.judged.length} scored · ${judge.leads.length} leads`,
    );
  };
  const judge: Judge = new Judge(project, stored, sourcesByPost, report);

  // Every walk is independent of every other and nearly all waiting on Reddit,
  // so all of them start at once and the shared pace in src/lib/reddit/pace.ts
  // decides how many calls are actually in flight. Each page hands its new
  // posts to the judge as it lands. The first pass reads a few pages of every
  // walk, so the feed has leads in seconds; the second reads further into the
  // walks that found one.
  await report();
  const run = async (item: Walk, maxPages: number): Promise<WalkEnd> => {
    const end = await walk(
      ctx,
      item,
      maxPages,
      postBudget,
      found,
      sourcesByPost,
      (posts) => judge.offer(posts),
      () => judge.full,
    );
    if (end === "cutShort") {
      cutShort += 1;
    }
    await report();
    return end;
  };
  const ends = await Promise.all(plan.map((item) => run(item, firstPassPages)));
  await judge.settle();
  /** Buyer leads among the posts this walk has been handed, as the sweep stands now. */
  const buyersOf = (item: Walk): number => {
    const buyers = new Set(judge.leads.map((lead) => lead.postId));
    return [...item.walked].filter((id) => buyers.has(id)).length;
  };
  const deeper = plan
    .filter((item, index) => depthPages > firstPassPages && ends[index] === "paused" && buyersOf(item) > 0)
    .sort((a, b) => buyersOf(b) - buyersOf(a))
    .slice(0, DEEP_WALKS);
  walks = plan.length - deeper.length;
  pass = "rest";
  await report(true);
  await Promise.all(
    deeper.map(async (item) => {
      await run(item, depthPages - firstPassPages);
      walks += 1;
    }),
  );
  pass = "scoring";
  await report(true);
  await judge.settle();
  await report(true);

  // Faces for the top of the feed only. A full sweep writes hundreds of leads:
  // looked up for all 448 of them on 2026-09-18, through `reddit.profile` as
  // it then was, they were $0.88 of a $1.27 sweep, and they shared
  // Reddit's pace with the searches, which tripled how long the sweep took.
  // The rest keep their initials until a scan or a refresh reaches them.
  const faces = [...judge.leads]
    .sort((a, b) => b.score - a.score)
    .slice(0, FACES)
    .map((lead) => found.get(lead.postId)?.author ?? "");
  await fetchAvatars(ctx, faces);

  // A post several walks found gained sources after its chunk was judged, so
  // record every source once more; the ones already written are ignored.
  await recordSources(
    projectId,
    [...sourcesByPost.entries()].map(([postId, sources]) => ({ postId, sources })),
  );
  await creditSources(
    sourcesByPost,
    judge.candidates.map((post) => post.id),
    judge.leads.map((lead) => lead.postId),
  );
  // A search of the sweep's own belongs to no plan row, so the scans that
  // follow would never ask it again. The ones that found the most buyers join
  // the plan as keywords, where a person can switch them off like any other.
  if (!small) {
    const judgedPosts = new Set(judge.judged.map((judgement) => judgement.id));
    await keepSearches(
      projectId,
      plan
        .map((item) => ({ item, buyers: buyersOf(item) }))
        .filter(({ item, buyers }) => item.query.rows.length === 0 && buyers > 0)
        .sort((a, b) => b.buyers - a.buyers)
        .slice(0, KEPT_SEARCHES)
        .map(({ item, buyers }) => ({
          text: item.query.text,
          candidates: [...item.walked].filter((id) => judgedPosts.has(id)).length,
          leads: buyers,
        })),
    );
  }
  const at = new Date();
  await markCovered(queries.flatMap((query) => query.rows.map((row) => ({ row, at }))));

  await progress(
    jobId,
    cutShort === 0
      ? "Finished"
      : `Finished; ${cutShort} of ${walks} searches stopped early on a Reddit error`,
  );
  return {
    walks,
    found: found.size,
    judged: judge.judged.length,
    leads: judge.leads.length,
    cutShort,
  };
}
