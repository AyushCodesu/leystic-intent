import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import type { StoredPost } from "@/lib/reddit/store";
import { judgeAnswers, triageAnswers } from "./jevAnswers";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The one-time backfill, against a real database with only AnyAPI and the
 * language model faked. What a unit test cannot prove: that a year of one
 * query is walked to its end and no further, that both kinds of query are
 * asked, that a post far outside the feed window still becomes a
 * lead, that a verdict already held is not bought again, that nothing is
 * opened with `reddit.post`, and that the Reddit SEO tab stays Google's.
 */

const { askJev, generateStructured } = vi.hoisted(() => ({ askJev: vi.fn(), generateStructured: vi.fn() }));
const fetchSearch = vi.fn();
const fetchSubredditPosts = vi.fn();
const fetchPost = vi.fn();
const fetchPostComments = vi.fn();
const fetchAuthorProfile = vi.fn();
const fetchSubredditDetails = vi.fn();
const googleSearch = vi.fn();

vi.mock("@/lib/jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jev")>()),
  askJev,
}));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  generateStructured,
}));
vi.mock("@/lib/reddit/skus", () => ({
  fetchSearch,
  fetchSubredditPosts,
  fetchPost,
  fetchPostComments,
  fetchAuthorProfile,
  fetchSubredditDetails,
}));
vi.mock("@/lib/seo/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/fetch")>()),
  googleSearch,
}));
vi.mock("@/lib/anyapi", () => ({
  clientForUser: async () => ({
    client: {},
    funding: "house" as const,
    call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
  }),
  tierNameFor: async () => "free" as const,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/** One search call as the test reads it: the query, the sort, the timeframe. */
type Call = { query: string; sort: string; timeframe: string; cursor: string | undefined };

function callsOf(): Call[] {
  return fetchSearch.mock.calls.map((call) => ({
    query: call[1] as string,
    sort: (call[2] as { sort?: string }).sort ?? "relevance",
    timeframe: (call[2] as { timeframe: string }).timeframe,
    cursor: (call[2] as { cursor?: string }).cursor,
  }));
}

/** The cadence each search was allowed to reuse a stored run under. */
function maxAgesOf(): number[] {
  return fetchSearch.mock.calls.map((call) => (call[0] as { maxAgeMs: number }).maxAgeMs);
}

describeDb("runBackfill against a database", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let runBackfill: typeof import("@/lib/scan/backfill").runBackfill;
  let upsertPosts: typeof import("@/lib/reddit/store").upsertPosts;
  let eq: typeof import("drizzle-orm").eq;
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("all");
    cleanupAuth = auth.cleanup;
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    ({ runBackfill } = await import("@/lib/scan/backfill"));
    ({ upsertPosts } = await import("@/lib/reddit/store"));
    ({ eq } = await import("drizzle-orm"));
    askJev.mockReset();
    // No searches of the sweep's own, unless a test makes some up.
    generateStructured.mockReset();
    generateStructured.mockRejectedValue(new Error("no model"));
    for (const mock of [fetchSearch, fetchSubredditPosts, fetchPost, fetchPostComments]) {
      mock.mockReset();
    }
    fetchAuthorProfile.mockResolvedValue({ value: null, reused: true, costUsd: 0 });
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  async function project(phrasings: string[] = []) {
    const user = await makeUser();
    const row = await makeProject(user.id, {
      solution: "A form builder with conditional logic.",
      problemPhrasings: phrasings,
    });
    await db()
      .insert(schema.projectKeywords)
      .values({ projectId: row.id, keyword: "form builder" });
    return row;
  }

  const BODY = "Our signup form needs conditional logic.";

  /** Search results as they arrive now: with their own text, and any age. */
  async function posts(count: number, ageDays = 1): Promise<StoredPost[]> {
    const created = Math.floor((Date.now() - ageDays * DAY_MS) / 1000);
    return upsertPosts(
      Array.from({ length: count }, (_, index) => ({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "SaaS",
        author: `asker${index}`,
        title: `Form question ${index}`,
        body: BODY,
        permalink: `/r/SaaS/comments/x${index}/form/`,
        score: 3,
        numComments: 2,
        createdUtc: created,
      })),
    );
  }

  /** Triage that wants every title read, then one qualifying judgement each. */
  function model() {
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) =>
      call.purpose === "triage"
        ? triageAnswers(Array.from({ length: call.itemsAsked }, () => ({})))
        : judgeAnswers(Array.from({ length: call.itemsAsked }, () => ({ quote: "s0" }))),
    );
  }

  /** Every page of a walk, in order, replayed per query and sort. */
  function pages(list: { posts: StoredPost[]; nextCursor: string | null }[]) {
    const at = new Map<string, number>();
    fetchSearch.mockImplementation(
      async (_ctx: unknown, query: string, options: { sort?: string }) => {
        const key = `${query} ${options.sort ?? "relevance"}`;
        const index = at.get(key) ?? 0;
        at.set(key, index + 1);
        return { value: list[Math.min(index, list.length - 1)], reused: true, costUsd: 0 };
      },
    );
  }

  it("stops walking a query when Reddit stops handing out a cursor", async () => {
    const row = await project();
    pages([
      { posts: await posts(2), nextCursor: "page-2" },
      { posts: await posts(1), nextCursor: "page-3" },
      { posts: await posts(1), nextCursor: null },
    ]);
    model();

    await runBackfill(row.id);

    // Three pages, and the third ends the listing.
    expect(callsOf().map((call) => call.cursor)).toEqual([undefined, "page-2", "page-3"]);
  });

  it("ends a walk whose listing stops moving, however many cursors it is handed", async () => {
    const row = await project();
    const same = await posts(2);
    let cursors = 0;
    // A source that repeats the same page under a fresh cursor forever.
    fetchSearch.mockImplementation(async () => {
      cursors += 1;
      return { value: { posts: same, nextCursor: `page-${cursors}` }, reused: true, costUsd: 0 };
    });
    model();

    const outcome = await runBackfill(row.id);

    // Page one moved the walk; three more that did not end it.
    expect(callsOf()).toHaveLength(4);
    expect(outcome.cutShort).toBe(0);
    expect(outcome.found).toBe(2);
  });

  it("ends only the walk whose page failed, and keeps the pages before it", async () => {
    const row = await project(["forms that branch"]);
    const first = await posts(2);
    const later = await posts(1);
    const at = new Map<string, number>();
    fetchSearch.mockImplementation(
      async (_ctx: unknown, query: string) => {
        const index = at.get(query) ?? 0;
        at.set(query, index + 1);
        if (query === "forms that branch" && index === 1) {
          throw new Error("all providers failed");
        }
        const value =
          index === 0 ? { posts: first, nextCursor: "page-2" } : { posts: later, nextCursor: null };
        return { value, reused: true, costUsd: 0 };
      },
    );
    model();

    const outcome = await runBackfill(row.id);

    expect(outcome.cutShort).toBe(1);
    expect(outcome.walks).toBe(2);
    expect(outcome.found).toBe(3);
    expect(callsOf().filter((call) => call.query === "form builder")).toHaveLength(2);
    expect(callsOf().filter((call) => call.query === "forms that branch")).toHaveLength(2);
  });

  it("keeps walking past a page that carried nothing new", async () => {
    const row = await project();
    const repeated = await posts(2);
    const behind = await posts(1);
    pages([
      { posts: repeated, nextCursor: "page-2" },
      // The sparse page Reddit's relevance sort returns mid-listing. Stopping
      // here is what lost 29 of 48 buyers on 2026-09-10.
      { posts: [], nextCursor: "page-3" },
      { posts: behind, nextCursor: null },
    ]);
    model();

    await runBackfill(row.id);

    expect(callsOf()).toHaveLength(3);
    const found = await db().select().from(schema.leads).where(eq(schema.leads.projectId, row.id));
    expect(found.map((lead) => lead.postId)).toContain(behind[0].id);
  });

  it("stops walking when the cursor it just followed comes back again", async () => {
    const row = await project();
    pages([
      { posts: await posts(1), nextCursor: "page-2" },
      { posts: await posts(1), nextCursor: "page-2" },
    ]);
    model();

    await runBackfill(row.id);

    expect(callsOf()).toHaveLength(2);
  });

  /** A listing that never ends: a fresh page of new posts under every cursor. */
  function endless(perPage: number) {
    let cursors = 0;
    fetchSearch.mockImplementation(async () => {
      cursors += 1;
      return {
        value: { posts: await posts(perPage), nextCursor: `page-${cursors}` },
        reused: true,
        costUsd: 0,
      };
    });
  }

  it("reads on past the first pass only where the first pass found a lead", async () => {
    const row = await project();
    endless(2);
    // Every title is worth reading, and nobody in them is a buyer.
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) =>
      call.purpose === "triage"
        ? triageAnswers(Array.from({ length: call.itemsAsked }, () => ({})))
        : judgeAnswers(
            Array.from({ length: call.itemsAsked }, () => ({ relationship: "discussion", solvesProblem: 0.1, audience: 0.1 })),
          ),
    );

    const outcome = await runBackfill(row.id);

    // One page, and the walk did not earn a second.
    expect(callsOf()).toHaveLength(1);
    expect(outcome.leads).toBe(0);
  });

  it("asks the searches it made up, and keeps the ones that found buyers as keywords", async () => {
    const row = await project(["form with conditional logic"]);
    generateStructured.mockResolvedValue({
      searches: [
        { kind: "tool_ask", text: "app for  conditional forms" },
        { kind: "alternative_to", text: "alternative to Typeform" },
      ],
    });
    // Only the tool ask finds anybody, and only on its one page.
    const buyers = await posts(2);
    fetchSearch.mockImplementation(async (_ctx: unknown, query: string) => ({
      value: { posts: query === "app for conditional forms" ? buyers : [], nextCursor: null },
      reused: true,
      costUsd: 0,
    }));
    model();

    await runBackfill(row.id);

    expect(callsOf().map((call) => call.query).sort()).toEqual([
      "alternative to Typeform",
      "app for conditional forms",
      "form builder",
      "form with conditional logic",
    ]);
    const kept = await db()
      .select()
      .from(schema.projectKeywords)
      .where(eq(schema.projectKeywords.projectId, row.id));
    expect(kept.filter((item) => item.source === "sweep")).toMatchObject([
      { keyword: "app for conditional forms", state: "active", freshLeads: 2, freshCandidates: 2 },
    ]);
  });

  it("prepares the client and held verdicts beside search generation, before starting any walk", async () => {
    const row = await project(["forms that branch"]);
    await db().insert(schema.projectCompetitors).values({
      projectId: row.id, name: "Typeform", source: "serp", state: "active",
    });
    const anyapi = await import("@/lib/anyapi");
    const evaluations = await import("@/lib/scan/evaluations");
    const funded = await anyapi.clientForUser(row.userId);
    let releaseClient = () => {};
    let releaseModel = () => {};
    const clientHeld = new Promise<void>((resolve) => { releaseClient = resolve; });
    const modelHeld = new Promise<void>((resolve) => { releaseModel = resolve; });
    const client = vi.spyOn(anyapi, "clientForUser").mockImplementation(async () => {
      await clientHeld;
      return funded;
    });
    const stored = vi.spyOn(evaluations, "loadEvaluations");
    generateStructured.mockImplementation(async () => {
      await modelHeld;
      return { searches: [{ kind: "alternative_to", text: "alternative to Typeform" }] };
    });
    pages([{ posts: [], nextCursor: null }]);
    const sweep = runBackfill(row.id);
    try {
      await vi.waitFor(() => {
        expect(client).toHaveBeenCalledOnce();
        expect(stored).toHaveBeenCalledWith(row.id);
        expect(generateStructured).toHaveBeenCalledOnce();
      });
      expect(fetchSearch).not.toHaveBeenCalled();
      releaseClient();
      expect(fetchSearch).not.toHaveBeenCalled();
      expect(JSON.parse(generateStructured.mock.calls[0][0].prompt).product.competitors).toEqual(["Typeform"]);
      releaseModel();
      await sweep;
      expect(callsOf().map((call) => call.query)).toEqual([
        "form builder", "forms that branch", "alternative to Typeform",
      ]);
    } finally {
      releaseClient();
      releaseModel();
      await sweep;
      client.mockRestore();
      stored.mockRestore();
    }
  });

  it("reads deeper only on the walks whose first page found the most buyers", async () => {
    const row = await project();
    generateStructured.mockResolvedValue({
      searches: Array.from({ length: 12 }, (_, index) => ({ kind: "tool_ask", text: `tool for forms ${index}` })),
    });
    // Search n finds n buyers on its first page; the plan's own keyword finds none.
    const asked = new Map<string, number>();
    fetchSearch.mockImplementation(async (_ctx: unknown, query: string) => {
      const page = asked.get(query) ?? 0;
      asked.set(query, page + 1);
      const index = Number(query.split(" ").at(-1));
      const count = page === 0 && Number.isFinite(index) ? index : 0;
      return { value: { posts: await posts(count), nextCursor: `${query}-${page}` }, reused: true, costUsd: 0 };
    });
    model();

    await runBackfill(row.id);

    const deep = [...asked].filter(([, pages]) => pages > 1).map(([query]) => query);
    expect(deep.sort()).toEqual(Array.from({ length: 10 }, (_, index) => `tool for forms ${index + 2}`).sort());
  });

  it("stops a walk that keeps finding leads at its depth", async () => {
    const row = await project();
    endless(2);
    model();

    await runBackfill(row.id);

    // Six pages.
    expect(callsOf()).toHaveLength(6);
  });

  it("scores no post whose title triage says is asking for nothing", async () => {
    const row = await project();
    pages([{ posts: await posts(4), nextCursor: null }]);
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) =>
      call.purpose === "triage"
        ? triageAnswers(
            Array.from({ length: call.itemsAsked }, (_, index) => ({ asking: index === 0 ? 0.4 : 0.03 })),
          )
        : judgeAnswers(Array.from({ length: call.itemsAsked }, () => ({ quote: "s0" }))),
    );

    const outcome = await runBackfill(row.id);

    expect(outcome.found).toBe(4);
    expect(outcome.judged).toBe(1);
  });

  it("stops finding posts once the sweep's budget is spent", async () => {
    const row = await project();
    endless(600);
    // One buyer, so the walk reads on, and too few of them to stop the sweep.
    let buyers = 0;
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) =>
      call.purpose === "triage"
        ? triageAnswers(Array.from({ length: call.itemsAsked }, () => ({})))
        : judgeAnswers(
            Array.from({ length: call.itemsAsked }, () =>
              (buyers += 1) === 1
                ? { quote: "s0" }
                : { relationship: "discussion", solvesProblem: 0.1, audience: 0.1 },
            ),
          ),
    );

    const outcome = await runBackfill(row.id);

    // Six pages were on offer; the budget ran out before the last of them.
    expect(callsOf().length).toBeLessThan(6);
    expect(outcome.found).toBe(2500);
  }, 60_000);

  it("stops searching and scoring once it holds as many buyers as one person answers", async () => {
    const row = await project();
    endless(200);
    model();

    const outcome = await runBackfill(row.id);

    // Six pages of buyers were on offer. The first held the 150, and a chunk already
    // being judged finishes, so the sweep ends a few over and reads no deeper.
    expect(callsOf().length).toBeLessThan(6);
    expect(outcome.leads).toBeGreaterThanOrEqual(150);
    expect(outcome.leads).toBeLessThan(300);
  }, 60_000);

  it("reuses no cached search, because a retry must not inherit a truncated walk", async () => {
    const row = await project();
    pages([{ posts: await posts(1), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    expect(maxAgesOf()).toEqual([0]);
  });

  it("starts every walk at once, and leaves the pace to the shared Reddit pace", async () => {
    const row = await project(["forms that branch", "a form that asks one question"]);
    let live = 0;
    let peak = 0;
    fetchSearch.mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return { value: { posts: [], nextCursor: null }, reused: false, costUsd: 0 };
    });
    model();

    await runBackfill(row.id);

    // Three walks, one a query, all in flight together. How many calls that
    // is allowed to be is decided in src/lib/reddit/pace.ts, underneath the
    // fetch this test replaces.
    expect(callsOf()).toHaveLength(3);
    expect(peak).toBe(3);
  });

  /**
   * A first sweep judges for minutes. Holding every verdict until the last
   * batch left the feed empty for the whole of the 2026-09-10 re-run, so a
   * batch's leads are written the moment that batch is judged. One batch is
   * held open here while the others land: without the per-batch commit no lead
   * exists until every batch is done, and this waits out its whole budget.
   */
  it("writes a batch's leads while it is still judging the rest", async () => {
    const { SCORE_BATCH_SIZE } = await import("@/lib/scan/constants");
    const row = await project();
    pages([{ posts: await posts(SCORE_BATCH_SIZE * 3), nextCursor: null }]);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scoringCalls = 0;
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) => {
      if (call.purpose === "triage") {
        return triageAnswers(Array.from({ length: call.itemsAsked }, () => ({})));
      }
      scoringCalls += 1;
      if (scoringCalls === 1) {
        await held;
      }
      return judgeAnswers(Array.from({ length: call.itemsAsked }, () => ({ quote: "s0" })));
    });

    const sweep = runBackfill(row.id);
    let midRun = 0;
    // Until both free batches have landed, not until the first has: the two
    // commit a few milliseconds apart, and a slow runner read between them.
    for (let tries = 0; tries < 100 && midRun < SCORE_BATCH_SIZE * 2; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      midRun = (
        await db().select().from(schema.leads).where(eq(schema.leads.projectId, row.id))
      ).length;
    }
    release();
    await sweep;

    // Two batches were in the feed while the third had not answered yet.
    expect(midRun).toBe(SCORE_BATCH_SIZE * 2);
  });

  /**
   * Posts wait for a triage call's worth to arrive, and on 2026-09-24 two
   * searches that took 141 s held the 50 posts already in behind them. Here
   * one walk answers with a few posts and the others hang: the few are judged
   * and written while the others are still out.
   */
  it("judges what has arrived when the other searches go quiet", async () => {
    const row = await project(["forms that branch", "a form that asks one question"]);
    const found = await posts(5);
    let release = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    fetchSearch.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) {
        await hung;
        return { value: { posts: [], nextCursor: null }, reused: false, costUsd: 0 };
      }
      return { value: { posts: found, nextCursor: null }, reused: false, costUsd: 0 };
    });
    model();

    const sweep = runBackfill(row.id);
    let midRun = 0;
    for (let tries = 0; tries < 60 && midRun === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      midRun = (
        await db().select().from(schema.leads).where(eq(schema.leads.projectId, row.id))
      ).length;
    }
    release();
    await sweep;

    expect(midRun).toBe(5);
  }, 15_000);

  it("asks both the plan's keywords and the problem's phrasings, by relevance over a year", async () => {
    const row = await project(["forms that branch"]);
    pages([{ posts: await posts(1), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    expect(callsOf().map((call) => `${call.query} | ${call.sort}`).sort()).toEqual([
      "form builder | relevance",
      "forms that branch | relevance",
    ]);
    expect(callsOf().every((call) => call.timeframe === "year")).toBe(true);
  });

  it("walks a query once when two keywords compile to it, and credits both", async () => {
    const row = await project();
    await db()
      .insert(schema.projectKeywords)
      .values([
        { projectId: row.id, keyword: '(form OR forms) AND (branch OR "conditional logic")' },
        { projectId: row.id, keyword: "(form OR forms) AND branch" },
      ]);
    pages([{ posts: await posts(1), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    const branch = callsOf().filter((call) => call.query === "(form OR forms) AND branch");
    expect(branch.map((call) => call.sort)).toEqual(["relevance"]);
    const covered = await db()
      .select()
      .from(schema.projectKeywords)
      .where(eq(schema.projectKeywords.projectId, row.id));
    expect(covered.every((keyword) => keyword.lastCoveredAt !== null)).toBe(true);
  });

  it("never asks a bare negation, and asks two keywords that differ only by one once", async () => {
    const row = await project();
    await db()
      .insert(schema.projectKeywords)
      .values([
        { projectId: row.id, keyword: "(form OR forms) AND (no OR without)" },
        { projectId: row.id, keyword: '(form OR forms) AND ("under 21")' },
        { projectId: row.id, keyword: '(form OR forms) AND ("under 21" OR not)' },
      ]);
    pages([{ posts: [], nextCursor: null }]);
    model();

    await runBackfill(row.id);

    const asked = [...new Set(callsOf().map((call) => call.query))].sort();
    expect(asked).toEqual(['(form OR forms) AND "under 21"', "form builder"]);
  });

  it("asks a compiled keyword one constraint at a time, so none hides behind the others", async () => {
    const row = await project();
    await db()
      .insert(schema.projectKeywords)
      .values({ projectId: row.id, keyword: '(form OR forms) AND (branch OR "conditional logic")' });
    pages([{ posts: await posts(1), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    const queries = [...new Set(callsOf().map((call) => call.query))].sort();
    expect(queries).toEqual([
      "(form OR forms) AND \"conditional logic\"",
      "(form OR forms) AND branch",
      "form builder",
    ]);
  });

  it("re-persists a found post that retention deleted mid-run, and still writes it", async () => {
    const row = await project();
    const [found] = await posts(1);
    // The retention job runs in the same queue and can delete an unreferenced
    // post while the sweep still holds it in memory.
    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, found.id));
    pages([{ posts: [found], nextCursor: null }]);
    model();

    const outcome = await runBackfill(row.id);

    expect(outcome.leads).toBe(1);
    const [post] = await db()
      .select()
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, found.id));
    expect(post?.id).toBe(found.id);
    const leads = await db().select().from(schema.leads).where(eq(schema.leads.projectId, row.id));
    expect(leads.map((lead) => lead.postId)).toEqual([found.id]);
  });

  it("judges a post from long outside the feed window and writes it as a lead", async () => {
    const row = await project();
    const [old] = await posts(1, 200);
    pages([{ posts: [old], nextCursor: null }]);
    model();

    const outcome = await runBackfill(row.id);

    expect(outcome.judged).toBe(1);
    const leads = await db().select().from(schema.leads).where(eq(schema.leads.projectId, row.id));
    expect(leads.map((lead) => [lead.postId, lead.kind])).toEqual([[old.id, "buyer"]]);
  });

  it("never judges a post it already holds a verdict on", async () => {
    const row = await project();
    pages([{ posts: await posts(2), nextCursor: null }]);
    model();

    await runBackfill(row.id);
    expect(askJev).toHaveBeenCalled();

    askJev.mockClear();
    const second = await runBackfill(row.id);
    expect(askJev).not.toHaveBeenCalled();
    expect(second.judged).toBe(0);
  });

  it("opens no post, because search carried the text", async () => {
    const row = await project(["forms that branch"]);
    pages([{ posts: await posts(3), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("writes no Reddit SEO row, which stays Google's alone", async () => {
    const row = await project(["forms that branch"]);
    pages([{ posts: await posts(2), nextCursor: null }]);
    model();

    await runBackfill(row.id);

    const seo = await db()
      .select()
      .from(schema.seoOpportunities)
      .where(eq(schema.seoOpportunities.projectId, row.id));
    expect(seo).toHaveLength(0);
  });
});
