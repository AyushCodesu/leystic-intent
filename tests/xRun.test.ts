import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "@/lib/jev";
import { FIRST_LOOK_EXTRA, FIRST_LOOK_HOURS, OPENED_WITHIN_DAYS } from "@/lib/x/constants";
import { TIERS } from "@/lib/tiers";
import { describeDb, makeProject, makeUser, newId } from "./fixtures/db";

/**
 * The X pipeline end to end, against a real database with only AnyAPI and the
 * judge faked: what the first check writes and how far back it looks, the paging and watermark rules that
 * keep billed empty pages down, the parent walk for replies, and the switch
 * and the unopened-tab rule that keep X from spending when nobody looks.
 */

const { askJev, generateStructured, search, tweet, profile, wallet } = vi.hoisted(() => ({
  askJev: vi.fn(),
  generateStructured: vi.fn(),
  search: vi.fn(),
  tweet: vi.fn(),
  profile: vi.fn(),
  wallet: { connected: false },
}));

vi.mock("@/lib/jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jev")>()),
  askJev,
}));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  generateStructured,
}));
vi.mock("@/lib/anyapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/anyapi")>()),
  clientForUser: async () => ({
    client: { twitter: { search, tweet, profile } },
    funding: "house" as const,
    call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
  }),
  tierNameFor: async () => (wallet.connected ? ("connected" as const) : ("free" as const)),
}));

const HOUR = 3_600_000;

/** A rival name no other test, or test file, searches for, so no paid page is shared between them. */
function uniqueRival(): string {
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  return `calendly${letters}`;
}

type Item = Record<string, unknown>;

function item(text: string, over: Item = {}): Item {
  const id = newId("9");
  return {
    id,
    text,
    createdUtc: Math.floor((Date.now() - 2 * HOUR) / 1000),
    authorUsername: `user${id.slice(-6)}`,
    authorName: "A Person",
    authorFollowers: 200,
    authorVerified: false,
    isReply: false,
    inReplyToId: null,
    conversationId: id,
    lang: "en",
    likeCount: 0,
    replyCount: 0,
    url: `https://x.com/i/web/status/${id}`,
    ...over,
  };
}

function page(items: Item[], nextCursor: string | null = null) {
  return { output: { found: true, data: { items, nextCursor } }, costUsd: 0.00065, items: items.length };
}

type Page = ReturnType<typeof page>;
type Family = "rival" | "request" | "diy" | "stack";

/** Which family a query sent to X belongs to, from the words lanes.ts binds each to. */
function familyOfQuery(query: string): Family {
  if (query.includes(" min_faves:")) return "stack";
  if (query.includes('"vibe coded"')) return "diy";
  if (query.includes('"looking for"')) return "request";
  return "rival";
}

/**
 * Serves `pages` in order (the last one repeated) to one family's searches and
 * an empty page to every other: a project with rivals also has a build-vs-buy
 * lane, and the tests about paging and judging are about one lane at a time.
 */
function serve(family: Family, ...pages: Page[]) {
  let index = 0;
  search.mockImplementation(async (input: { query: string }) => {
    if (familyOfQuery(input.query) !== family) return page([]);
    const next = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return next;
  });
}

/** The searches sent for one family, in order. */
function callsFor(family: Family): Array<{ query: string; cursor?: string }> {
  return search.mock.calls.map(([input]) => input as { query: string; cursor?: string }).filter((input) => familyOfQuery(input.query) === family);
}

/**
 * Answers every question asked: a yes-leaning buyer unless the post says
 * otherwise. "reject-me" is a seller-ish miss; "reply-me" has no need of its
 * own but is worth a reply.
 */
function answerAll(call: { questions: Record<string, Question>; state: { posts: { p0: { text: string } } } }) {
  const text = call.state.posts.p0.text;
  const reply = /reply-me/u.test(text);
  const venue = /venue-me/u.test(text);
  const buyer = !/reject-me/u.test(text) && !reply && !venue;
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(call.questions)) {
    if (question.type === "noul" && venue) {
      // Nobody shopping: no need of their own, but this kind of product, and a founder would reply.
      const yes = ["same_kind", "can_use", "founder_would_reply", "promoting"].includes(key);
      answers[key] = { type: "noul", noul: yes ? 0.9 : 0.1 };
    } else if (question.type === "noul" && reply) {
      // A need of their own, read as a neighbouring job (wrong_job), and worth a founder's reply.
      const yes = ["own_need", "can_use", "founder_would_reply", "reply_needs_product"].includes(key);
      answers[key] = { type: "noul", noul: key === "same_kind" ? 0.4 : yes ? 0.9 : 0.1 };
    } else if (question.type === "noul") {
      const yes = ["own_need", "same_kind", "can_use", "wants_offering", "audience", "is_lead_like"].includes(key);
      answers[key] = { type: "noul", noul: yes === buyer ? 0.9 : 0.1 };
    } else if (question.type === "score") {
      answers[key] = { type: "score", score: buyer ? 3 : 0 };
    } else {
      const options = Object.keys(question.criteria);
      answers[key] = { type: "choice", choice: key === "need_quote" ? (buyer ? "s0" : "none") : options[0] };
    }
  }
  return answers;
}

describeDb("the X pipeline against a database", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let run: typeof import("@/lib/x/run");
  let openX: typeof import("@/lib/x/open").openX;
  let orm: typeof import("drizzle-orm");

  beforeEach(async () => {
    process.env.X_LEADS = "true";
    // The local .env is self-hosted, which has no caps; these tests are about the hosted tiers.
    process.env.SELF_HOSTED = "false";
    // Replies need a model key; tests that want them set it (the model itself is mocked).
    delete process.env.OPENROUTER_API_KEY;
    // Pin what these tests depend on: the persistent test database carries every
    // earlier run's spend, which a $5 X cap would eventually refuse.
    process.env.X_REPLIES = "true";
    process.env.HOUSE_X_DATA_CAP_USD_PER_DAY = "1000";
    process.env.HOUSE_X_LLM_CAP_USD_PER_DAY = "1000";
    wallet.connected = false;
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    run = await import("@/lib/x/run");
    ({ openX } = await import("@/lib/x/open"));
    orm = await import("drizzle-orm");
    for (const mock of [askJev, generateStructured, search, tweet, profile]) {
      mock.mockReset();
    }
    // No model key in tests: the pain-search call and the reply check fail
    // unless a test answers them.
    generateStructured.mockRejectedValue(new Error("no model in tests"));
    askJev.mockImplementation(async (call) => answerAll(call));
    profile.mockResolvedValue({ output: { found: true, data: { handle: "x", bio: "runs a small agency" } }, costUsd: 0.00022 });
  });

  async function fixture(competitors: string[], opts: { brief?: boolean } = {}) {
    const user = await makeUser();
    const brief = {
      kind: "open source meeting scheduling software",
      neighbours: [
        { kind: "calendar app", whyNot: "keeps events, does not take bookings" },
        { kind: "virtual assistant", whyNot: "a person, not software" },
      ],
      buyers: ["consultants"],
      nonBuyers: ["scheduling vendors"],
      price: "freemium",
      goodAsks: ["need a calendly alternative for my team"],
      nearMisses: [{ ask: "best calendar app?", why: "calendar, not booking" }],
    };
    const project = await makeProject(user.id, {
      name: "Cal.com",
      url: "https://cal.com",
      pain: "Scheduling back and forth",
      solution: "Scheduling links",
      ...(opts.brief ? { brief } : {}),
    });
    for (const name of competitors) {
      await db().insert(schema.projectCompetitors).values({ projectId: project.id, name, source: "user" });
    }
    return { user, project };
  }

  /** Answers model calls with `answer`, recording each the way llm.ts does, so the day's counts see them. */
  function modelAnswers(answer: (call: { purpose: string; prompt: string; projectId: string | null }) => unknown) {
    generateStructured.mockImplementation(async (call: { purpose: string; prompt: string; projectId: string | null }) => {
      const value = answer(call);
      await db()
        .insert(schema.llmUsage)
        .values({ projectId: call.projectId, purpose: call.purpose, costUsd: "0.0004", itemsAsked: 1, itemsAnswered: 1, finishReason: "stop" });
      return value;
    });
  }

  function slots(over: Record<string, unknown> = {}) {
    return { artifacts: [], topics: [], ordinaryWordRivals: [], notProducts: [], ...over };
  }

  function venueWorthy(worth: boolean, moment = "workflow") {
    return {
      moment: worth ? moment : "none",
      checks: {
        on_the_job: true,
        readers_buy: worth,
        reply_adds_value: worth,
        not_a_rival: true,
        genuine: true,
        not_vulnerable: true,
      },
      worth_reply: worth,
      why: worth ? "Shows a booking workflow to other founders; a cheaper way to do the round robin step fits." : "General chatter.",
      quote: worth ? "s0" : "none",
    };
  }

  /** The project's lane of one family. */
  async function laneOf(projectId: string, family: Family) {
    const lanes = await db().select().from(schema.xLanes).where(orm.eq(schema.xLanes.projectId, projectId));
    return lanes.find((lane) => lane.family === family)!;
  }

  function worthy(worth: boolean) {
    return {
      shape: worth ? "living_the_pain" : "none",
      checks: {
        fixes_this_case: worth,
        own_situation: true,
        reply_welcome: worth,
        still_open: true,
        could_buy: true,
        genuine: true,
        not_selling: true,
        not_vulnerable: true,
      },
      worth_reply: worth,
      why: worth ? "Rebooking clients by hand after a price rise; the product removes that." : "Chatter about the topic, no situation of their own.",
      quote: worth ? "s0" : "none",
    };
  }

  /** Forgets the shared pages this project's lanes bought, so the next scan buys fresh ones; never another test's. */
  async function forgetPages(projectId: string) {
    const lanes = await db().select({ body: schema.xLanes.body }).from(schema.xLanes).where(orm.eq(schema.xLanes.projectId, projectId));
    if (lanes.length === 0) return;
    await db()
      .delete(schema.searchRuns)
      .where(orm.inArray(schema.searchRuns.normalizedQuery, lanes.map((lane) => lane.body)));
  }

  async function leadsOf(projectId: string) {
    return db().select().from(schema.xLeads).where(orm.eq(schema.xLeads.projectId, projectId));
  }

  async function evaluationsOf(projectId: string) {
    return db().select().from(schema.xEvaluations).where(orm.eq(schema.xEvaluations.projectId, projectId));
  }

  async function queued(projectId: string, kind: string) {
    return db()
      .select()
      .from(schema.jobs)
      .where(orm.and(orm.eq(schema.jobs.projectId, projectId), orm.eq(schema.jobs.kind, kind), orm.isNull(schema.jobs.startedAt)));
  }

  it("reads the last month on first open: screens, walks a reply's parent and judges it too, writes leads and books the next scan", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const parent = item("Anyone have a scheduling tool they love? Mine keeps double booking.", { authorUsername: "otherperson" });
    const ask = item(`I'm looking for an alternative to ${rival}. The only feature I want is round-robin.`);
    const hook = item(`Looking for a ${rival} alternative? SlotPro gives you unlimited links https://t.co/abc`);
    const reply = item(`@otherperson honestly I need an alternative to ${rival} too, the pricing &amp; limits jumped.`, {
      isReply: true,
      inReplyToId: parent.id,
      conversationId: parent.id,
    });
    serve("rival", page([ask, hook, reply]));
    tweet.mockResolvedValue({ output: { found: true, data: { ...parent, authorHandle: "otherperson" } }, costUsd: 0.00022 });

    expect(await openX(project.id)).toBe("scan");
    expect(await openX(project.id)).toBe("none");
    expect(await queued(project.id, "x_scan")).toHaveLength(1);
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));

    const before = Date.now();
    await run.runXScan(project.id, null);

    const evaluations = await evaluationsOf(project.id);
    const byTweet = new Map(evaluations.map((row) => [row.tweetId, row]));
    expect(byTweet.get(hook.id as string)?.freeReject).toBe("vendor_hook");
    expect(byTweet.get(ask.id as string)?.stage).toBe("lead");
    expect(byTweet.get(reply.id as string)?.stage).toBe("lead");
    const replyContext = byTweet.get(reply.id as string)?.context as { replyingTo: string[] };
    expect(replyContext.replyingTo[0]).toMatch(/^@otherperson: Anyone have a scheduling tool/u);
    expect(tweet).toHaveBeenCalledWith({ url: `https://x.com/i/status/${parent.id}` });

    // The post the reply answers never used the searched words, and is an ask of its own.
    expect(byTweet.get(parent.id as string)).toMatchObject({
      stage: "lead",
      laneId: byTweet.get(reply.id as string)?.laneId,
      matchedPhrase: null,
      context: expect.objectContaining({ via: { tweetId: reply.id, author: reply.authorUsername, phrase: expect.any(String) } }),
    });

    const leads = await leadsOf(project.id);
    expect(leads.map((lead) => lead.tweetId).sort()).toEqual([ask.id, reply.id, parent.id].sort());
    expect(leads.find((lead) => lead.tweetId === ask.id)?.matchedPhrase).toBe(`I'm looking for an alternative to ${rival}.`);
    const [stored] = await db().select().from(schema.xPosts).where(orm.eq(schema.xPosts.id, reply.id as string));
    expect(stored.text).toContain("pricing & limits");

    // The query was the compiled rival lane, exact case, with the cutoff appended.
    const query = callsFor("rival")[0].query;
    expect(query).toMatch(new RegExp(`^${rival} \\(alternative OR alternatives OR .*\\) lang:en -filter:retweets since_time:\\d+$`, "u"));
    expect(callsFor("rival")[0]).toMatchObject({ queryType: "Latest", limit: 20 });
    // A build-vs-buy lane made from the rival alone searched too, with nothing to find.
    expect(callsFor("diy")).toHaveLength(1);
    // The first look reads the last thirty days, from the top of the hour.
    const since = Number(query.match(/since_time:(\d+)$/u)?.[1]) * 1000;
    expect(since).toBe(Math.floor(before / HOUR) * HOUR - FIRST_LOOK_HOURS * HOUR);

    const [xRun] = await db().select().from(schema.xRuns).where(orm.eq(schema.xRuns.projectId, project.id));
    expect(xRun.firstLeadAt).not.toBeNull();
    expect(xRun.leads).toBe(3);
    expect(await queued(project.id, "x_scan")).toHaveLength(1);
    const [state] = await db().select().from(schema.xProjects).where(orm.eq(schema.xProjects.projectId, project.id));
    expect(state.lastScanAt).not.toBeNull();

    // Nothing reached a Reddit table.
    expect(await db().select().from(schema.leads).where(orm.eq(schema.leads.projectId, project.id))).toHaveLength(0);
    expect(
      await db().select().from(schema.leadEvaluations).where(orm.eq(schema.leadEvaluations.projectId, project.id)),
    ).toHaveLength(0);

    // The ledger names the twitter.* SKUs, and the judge wrote its own purposes.
    const skus = await db().select({ sku: schema.usageLedger.sku }).from(schema.usageLedger).where(orm.eq(schema.usageLedger.projectId, project.id));
    expect(new Set(skus.map((row) => row.sku))).toEqual(new Set(["twitter.search", "twitter.tweet", "twitter.profile"]));
  });

  it("rejects a post the judge settles against, and never shows it", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const miss = item(`reject-me: alternative to ${rival} for my cat's birthday party? lol`);
    serve("rival", page([miss]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [evaluation] = await evaluationsOf(project.id);
    expect(evaluation.stage).toBe("rejected");
    expect(profile).not.toHaveBeenCalled();
    expect(await leadsOf(project.id)).toHaveLength(0);
  });

  it("takes page 2 only after a full page 1, never after a short one even with a cursor", async () => {
    wallet.connected = true;
    const shortRival = uniqueRival();
    const short = await fixture([shortRival]);
    serve("rival", page([item(`alternative to ${shortRival} anyone?`)], "cursor-after-short"), page([]));
    await openX(short.project.id);
    await run.runXScan(short.project.id, null);
    expect(callsFor("rival")).toHaveLength(1);

    search.mockReset();
    const fullRival = uniqueRival();
    const full = await fixture([fullRival]);
    const twenty = Array.from({ length: 20 }, (_, i) => item(`reject-me ${i}: alternative to ${fullRival} is what?`));
    serve("rival", page(twenty, "cursor-after-full"), page([]));
    await openX(full.project.id);
    await run.runXScan(full.project.id, null);
    expect(callsFor("rival")).toHaveLength(2);
    expect(callsFor("rival")[1].cursor).toBe("cursor-after-full");
  });

  it("never moves a lane's watermark on an empty page, and moves it on a page with posts", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    search.mockResolvedValue(page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const empty = await laneOf(project.id, "rival");
    expect(empty.coveredUntil).toBeNull();
    expect(empty.emptyPages).toBe(1);

    // The first check's empty page would serve the same window for 55 minutes; a
    // later scan with the lane due buys a fresh one.
    await db().delete(schema.searchRuns).where(orm.eq(schema.searchRuns.normalizedQuery, empty.body));
    await run.markLanesDue(project.id);
    serve("rival", page([item(`reject-me: alternative to ${rival}?`)]));
    await run.runXScan(project.id, null);
    const moved = await laneOf(project.id, "rival");
    expect(moved.coveredUntil).not.toBeNull();
  });

  it("writes nothing and books nothing while X_LEADS is off, even for a project that opened it", async () => {
    const { project } = await fixture([uniqueRival()]);
    await openX(project.id);
    // The run under test is the job openX queued; what matters is it books no successor.
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    process.env.X_LEADS = "false";
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
    expect(await db().select().from(schema.xRuns).where(orm.eq(schema.xRuns.projectId, project.id))).toHaveLength(0);
    expect(await queued(project.id, "x_scan")).toHaveLength(0);
  });

  it("stops scanning, and booking, once nobody has opened the tab for a week", async () => {
    const { project } = await fixture([uniqueRival()]);
    await openX(project.id, new Date(Date.now() - (OPENED_WITHIN_DAYS + 1) * 24 * HOUR));
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    search.mockResolvedValue(page([]));
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
    expect(await queued(project.id, "x_scan")).toHaveLength(0);
  });

  it("keeps scanning for a project whose alerts carry X asks, but buys no reply checks nobody will see", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    await openX(project.id, new Date(Date.now() - (OPENED_WITHIN_DAYS + 1) * 24 * HOUR));
    await db().insert(schema.alerts).values({ projectId: project.id, channel: "email", target: "a@example.com", cadence: "daily" });
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    serve("rival", page([item(`reply-me: ${rival} could be cheaper, its pricing doubled again and I rebooked every client by hand.`)]));
    modelAnswers((call) => {
      if (call.purpose !== "x_reply") throw new Error("no seed words here");
      return worthy(true);
    });
    await run.runXScan(project.id, null);
    expect(callsFor("rival")).toHaveLength(1);
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_reply")).toHaveLength(0);
    const [evaluation] = await evaluationsOf(project.id);
    expect(evaluation.stage).toBe("pending_reply");
    expect(await queued(project.id, "x_scan")).toHaveLength(1);
  });

  it("gives the first look's bigger allowance on its first day only, even when it never finished", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    await openX(project.id);
    const yesterday = new Date(Date.now() - 24 * HOUR);
    await db().insert(schema.xRuns).values({ projectId: project.id, startedAt: yesterday, finishedAt: yesterday, lanesRun: 0, partialReason: "stopped by an error" });
    // Today's ordinary pages are spent; a first look would still have FIRST_LOOK_EXTRA.
    await db()
      .insert(schema.usageLedger)
      .values(Array.from({ length: TIERS.free.x.pagesPerDay ?? 0 }, () => ({ projectId: project.id, sku: "twitter.search", costUsd: "0.00065" })));
    search.mockResolvedValue(page([item(`alternative to ${rival} anyone?`)]));
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
  });

  it("is not quiet, and checks again at the plan's cadence, when the first look left posts unjudged", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const { xQuiet } = await import("@/lib/x/quiet");
    serve("rival", page([item(`alternative to ${rival} anyone?`), item(`I'm looking for an alternative to ${rival} for my team.`)]));
    // The judge never answers: every post waits.
    askJev.mockRejectedValue(new Error("judge down"));
    await openX(project.id);
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    await run.runXScan(project.id, null);
    expect((await evaluationsOf(project.id)).every((row) => row.stage === "pending_llm")).toBe(true);
    expect((await xQuiet(project.id)).quiet).toBe(false);
    const [next] = await queued(project.id, "x_scan");
    expect(next.runAt.getTime()).toBeLessThan(Date.now() + 2 * 24 * HOUR);
  });

  it("spends nothing when there are no competitors and no seed words", async () => {
    const { project } = await fixture([]);
    await openX(project.id);
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
    expect(await db().select().from(schema.xLanes).where(orm.eq(schema.xLanes.projectId, project.id))).toHaveLength(0);
  });

  /** Serves each looked-up post by its id, so a thread's posts come back as themselves. */
  function serveTweets(...posts: Item[]) {
    const byId = new Map(posts.map((post) => [post.id as string, post]));
    tweet.mockImplementation(async ({ url }: { url: string }) => {
      const post = byId.get(url.split("/").at(-1) ?? "");
      return post
        ? { output: { found: true, data: { ...post, authorHandle: post.authorUsername } }, costUsd: 0.00022 }
        : { output: { found: false, data: null }, costUsd: 0.00022 };
    });
  }

  it("holds a thread's opener that is only an image for a look, since the judge cannot read it", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const picture = item("look at this https://t.co/pic", { authorUsername: "pictureposter", media: [{ type: "photo" }] });
    const reply = item(`@pictureposter ${rival} did this to me too, I need an alternative`, {
      isReply: true,
      inReplyToId: picture.id,
      conversationId: picture.id,
    });
    serve("rival", page([reply]));
    serveTweets(picture);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const held = (await evaluationsOf(project.id)).find((row) => row.tweetId === picture.id);
    expect(held).toMatchObject({ stage: "review", reasonCode: "image_only", llmAttempts: 0 });
    expect(held?.reason).toBe(
      `Mostly an image, which lurk can't read. @${reply.authorUsername} replied in its thread using the words lurk searched for (${rival} · alternative), so open it on X to see what they posted.`,
    );
    const { listXHeld } = await import("@/lib/x/read");
    const [card] = await listXHeld(project.id);
    expect(card).toMatchObject({ tweetId: picture.id, via: { author: reply.authorUsername, tweetId: reply.id } });
    // The judge read the picture's caption only as the reply's context, never as a post to judge.
    const judged = askJev.mock.calls.map(([call]) => (call as { state: { posts: { p0: { text: string } } } }).state.posts.p0.text);
    expect(judged.some((text) => text.includes("look at this"))).toBe(false);
  });

  it("walks the thread of a rival's own reply that used the searched words, and judges the post it answers", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const asker = item("what do you all use for booking calls? mine keeps double booking", { authorUsername: "asker" });
    const pitch = item(`@asker sorry about that! ${rival} is the alternative with round-robin built in`, {
      authorUsername: rival,
      isReply: true,
      inReplyToId: asker.id,
      conversationId: asker.id,
    });
    const offTopic = item(`@someone ${rival} here, happy to help`, { authorUsername: rival, isReply: true, inReplyToId: newId("9") });
    // The product's own reply is a thread it already answered.
    const ownReply = item(`@someone2 we're the open ${rival} alternative, come try us`, { authorUsername: "calcom", isReply: true, inReplyToId: newId("9") });
    serve("rival", page([pitch, offTopic, ownReply]));
    serveTweets(asker);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(pitch.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "own_or_rival_account" });
    expect((byTweet.get(pitch.id as string)?.context as { replyingTo: string[] }).replyingTo[0]).toMatch(/^@asker: what do you all use/u);
    expect(byTweet.get(asker.id as string)).toMatchObject({ stage: "lead", context: expect.objectContaining({ via: expect.objectContaining({ tweetId: pitch.id }) }) });
    expect(byTweet.get(ownReply.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "own_or_rival_account" });
    // A pitch without the searched words in it says nothing about its thread, and the product's own is answered: neither is walked.
    expect(tweet.mock.calls.map(([input]) => (input as { url: string }).url)).toEqual([`https://x.com/i/status/${asker.id}`]);
  });

  it("judges the posts a reply answers once each, takes one its search screened out for lacking the words, and walks no further from them", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const top = item("anyone running a small agency here?", { authorUsername: "top" });
    const opener = item("@top yes, and our booking page is a mess", { authorUsername: "opener", isReply: true, inReplyToId: top.id, conversationId: top.id });
    const middle = item("@opener still hunting for a booking tool that does round robin", {
      authorUsername: "middle",
      isReply: true,
      inReplyToId: opener.id,
      conversationId: top.id,
    });
    const reply = item(`@middle try anything but ${rival}, I need an alternative too`, {
      isReply: true,
      inReplyToId: middle.id,
      conversationId: top.id,
    });
    // The search also returned the middle post, matched on something it does not
    // show, and screened it out before the reply's walk reached it.
    serve("rival", page([middle, reply]));
    serveTweets(top, opener, middle);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const rows = await evaluationsOf(project.id);
    const byTweet = new Map(rows.map((row) => [row.tweetId, row]));
    // Two hops from the reply reach the middle post and the opener; both are judged, once.
    expect(byTweet.get(middle.id as string)).toMatchObject({ stage: "lead", context: expect.objectContaining({ via: expect.objectContaining({ tweetId: reply.id }) }) });
    expect(byTweet.get(opener.id as string)).toMatchObject({ stage: "lead", context: expect.objectContaining({ via: expect.objectContaining({ tweetId: reply.id }) }) });
    expect(rows.filter((row) => row.tweetId === middle.id)).toHaveLength(1);
    expect(byTweet.get(middle.id as string)?.freeReject).toBeNull();
    // Their own walks reach the top post as context, and find nothing further.
    expect(byTweet.has(top.id as string)).toBe(false);
  });

  it("holds no image from a competitor's account, nor one a vendor's pitch sits under", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const rivalImage = item("New ✨ https://t.co/pic", { authorUsername: rival, media: [{ type: "photo" }] });
    const reply = item(`@${rival} pricing jumped again, I need an alternative to ${rival}`, { isReply: true, inReplyToId: rivalImage.id });
    const meme = item("lmao 😭 https://t.co/meme", { authorUsername: "memes", media: [{ type: "photo" }] });
    const pitch = item(`@memes try ${rival}, the best alternative`, { authorUsername: rival, isReply: true, inReplyToId: meme.id });
    serve("rival", page([reply, pitch]));
    serveTweets(rivalImage, meme);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(rivalImage.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "own_or_rival_account" });
    expect(byTweet.get(meme.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "bare_link" });
    expect((await evaluationsOf(project.id)).filter((row) => row.stage === "review")).toHaveLength(0);
  });

  it("leaves a thread the product's own account posted in: someone it already answered", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const asker = item("what do you use for booking calls?", { authorUsername: "asker" });
    const ours = item("@asker we do round robin for free!", { authorUsername: "calcom", isReply: true, inReplyToId: asker.id });
    const reply = item(`@calcom @asker is this cheaper than ${rival}? I need an alternative`, { isReply: true, inReplyToId: ours.id });
    serve("rival", page([reply]));
    serveTweets(asker, ours);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const tweets = new Set((await evaluationsOf(project.id)).map((row) => row.tweetId));
    expect(tweets.has(reply.id as string)).toBe(true);
    expect(tweets.has(asker.id as string)).toBe(false);
    expect(tweets.has(ours.id as string)).toBe(false);
  });

  it("walks only replies screened out for who wrote them, and a failed walk costs the run nothing", async () => {
    const { AnyAPIError } = await import("@getanyapi/sdk");
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const elsewhere = item("anyone?", { authorUsername: "elsewhere" });
    // Screened out for its language, not its author: its thread says nothing more.
    const french = item(`@elsewhere je cherche une alternative à ${rival}`, { lang: "fr", isReply: true, inReplyToId: elsewhere.id });
    const pitch = item(`@someone ${rival} is the alternative you want`, { authorUsername: rival, isReply: true, inReplyToId: newId("9") });
    serve("rival", page([french, pitch]));
    tweet.mockRejectedValue(new AnyAPIError("upstream failed", 502));
    await openX(project.id);
    await expect(run.runXScan(project.id, null)).resolves.toBeUndefined();
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(french.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "other_language" });
    expect(byTweet.get(pitch.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "own_or_rival_account", context: null });
    expect(tweet.mock.calls.map(([input]) => (input as { url: string }).url)).toEqual([`https://x.com/i/status/${pitch.inReplyToId}`]);
  });

  it("reads a thread post's own chain from what the reply's walk stored, buying nothing more", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const top = item("booking tools for a two-person agency?", { authorUsername: "top" });
    const middle = item("@top same question, we keep double booking", { authorUsername: "middle", isReply: true, inReplyToId: top.id, conversationId: top.id });
    const reply = item(`@middle @top ditch ${rival}, I need an alternative too`, { isReply: true, inReplyToId: middle.id, conversationId: top.id });
    serve("rival", page([reply]));
    serveTweets(top, middle);
    await openX(project.id);
    // The day's parent lookups leave exactly the reply's two.
    await db()
      .insert(schema.usageLedger)
      .values(Array.from({ length: 10 + FIRST_LOOK_EXTRA.parents - 2 }, () => ({ projectId: project.id, sku: "twitter.tweet", costUsd: "0.00022" })));
    await run.runXScan(project.id, null);
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(middle.id as string)).toMatchObject({ stage: "lead" });
    expect((byTweet.get(middle.id as string)?.context as { replyingTo: string[] }).replyingTo[0]).toMatch(/^@top: booking tools/u);
    // The reply's walk bought the two posts above it; the middle post's walk read them from the store.
    expect(tweet).toHaveBeenCalledTimes(2);
  });

  it("gives a post claimed from its search's screen a fresh wait, so it is neither expired nor too late to answer", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const opener = item("what do people use for scheduling these days?", { authorUsername: "opener" });
    const reply = item(`@opener not ${rival}, I need an alternative`, { isReply: true, inReplyToId: opener.id });
    // Seen by a search 100 hours ago, matched on something it does not show.
    const { upsertXPosts } = await import("@/lib/x/store");
    const { toXPost } = await import("@/lib/x/map");
    await upsertXPosts([toXPost(opener)!]);
    await db()
      .insert(schema.xEvaluations)
      .values({ projectId: project.id, tweetId: opener.id as string, stage: "free_rejected", freeReject: "no_visible_term", createdAt: new Date(Date.now() - 100 * HOUR) });
    serve("rival", page([reply]));
    serveTweets(opener);
    await openX(project.id);
    await run.runXScan(project.id, null);
    const row = (await evaluationsOf(project.id)).find((one) => one.tweetId === opener.id);
    expect(row).toMatchObject({ stage: "lead", freeReject: null });
    expect(Date.now() - (row?.createdAt.getTime() ?? 0)).toBeLessThan(HOUR);
  });

  it("writes a walked thread's posts even when the run stops before judging them, for the next run", async () => {
    const { InsufficientBalanceError } = await import("@getanyapi/sdk");
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const asker = item("what do you all use for booking calls?", { authorUsername: "asker" });
    const reply = item(`@asker not ${rival}, I need an alternative`, { isReply: true, inReplyToId: asker.id });
    const other = item(`@someone ${rival} broke again, need an alternative`, { isReply: true, inReplyToId: newId("9") });
    serve("rival", page([reply, other]));
    tweet.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith(asker.id as string)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { output: { found: true, data: { ...asker, authorHandle: "asker" } }, costUsd: 0.00022 };
      }
      throw new InsufficientBalanceError("empty wallet", 402);
    });
    await openX(project.id);
    await run.runXScan(project.id, null);
    const row = (await evaluationsOf(project.id)).find((one) => one.tweetId === asker.id);
    expect(row).toMatchObject({ stage: "pending_llm", context: expect.objectContaining({ via: expect.objectContaining({ tweetId: reply.id }) }) });
  });

  it("keeps going when one parent lookup fails: that reply loses an attempt, the rest are judged", async () => {
    const { AnyAPIError } = await import("@getanyapi/sdk");
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const ask = item(`I'm looking for an alternative to ${rival}. Round robin is all I need.`);
    const reply = item(`@someone I need an alternative to ${rival} as well, it keeps double booking me.`, {
      isReply: true,
      inReplyToId: newId("9"),
    });
    serve("rival", page([ask, reply]));
    tweet.mockRejectedValue(new AnyAPIError("upstream failed", 502));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(ask.id as string)?.stage).toBe("lead");
    expect(byTweet.get(reply.id as string)).toMatchObject({ stage: "pending_parent", llmAttempts: 1 });
    const [xRun] = await db().select().from(schema.xRuns).where(orm.eq(schema.xRuns.projectId, project.id));
    expect(xRun.partialReason).toMatch(/lookups failed/u);
    expect(await queued(project.id, "x_scan")).toHaveLength(1);
  });

  it("gives a retried scan only what is left of the day's budget, never a fresh one", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    await openX(project.id);
    // Free may buy its day's search pages, and the first look's day FIRST_LOOK_EXTRA more; a failed attempt already bought them.
    await db()
      .insert(schema.usageLedger)
      .values(Array.from({ length: (TIERS.free.x.pagesPerDay ?? 0) + FIRST_LOOK_EXTRA.pages }, () => ({ projectId: project.id, sku: "twitter.search", costUsd: "0.00065" })));
    search.mockResolvedValue(page([item(`alternative to ${rival} anyone?`)]));
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves a paused lane paused on the next scan, and buys nothing for it", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    search.mockResolvedValue(page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    await db()
      .update(schema.xLanes)
      .set({ state: "paused", pauseReason: "no_yield", nextDueAt: new Date(0) })
      .where(orm.eq(schema.xLanes.projectId, project.id));
    search.mockClear();
    await forgetPages(project.id);
    await run.runXScan(project.id, null);
    expect(search).not.toHaveBeenCalled();
    const lanes = await db().select().from(schema.xLanes).where(orm.eq(schema.xLanes.projectId, project.id));
    expect(lanes.every((lane) => lane.state === "paused" && lane.runs === 1)).toBe(true);
  });

  it("tries an empty-paused lane again after a week, and a recompile gives any paused lane another chance", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    search.mockResolvedValue(page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const weekAgo = new Date(Date.now() - 8 * 24 * HOUR);
    await db()
      .update(schema.xLanes)
      .set({ state: "paused", pauseReason: "empty", lastRunAt: weekAgo, nextDueAt: new Date(0), emptyStreak: 0 })
      .where(orm.eq(schema.xLanes.projectId, project.id));
    await forgetPages(project.id);
    serve("rival", page([item(`alternative to ${rival} anyone? my team needs round robin`)]));
    await run.runXScan(project.id, null);
    const retried = await laneOf(project.id, "rival");
    expect(retried).toMatchObject({ state: "active", pauseReason: null, runs: 2 });

    await db()
      .update(schema.xLanes)
      .set({ state: "paused", pauseReason: "no_yield" })
      .where(orm.eq(schema.xLanes.projectId, project.id));
    await db().insert(schema.projectCompetitors).values({ projectId: project.id, name: uniqueRival(), source: "user" });
    await run.runXScan(project.id, null);
    const lanes = await db().select().from(schema.xLanes).where(orm.eq(schema.xLanes.projectId, project.id));
    expect(lanes.filter((lane) => lane.state === "paused")).toHaveLength(0);
  });

  it("builds build-vs-buy and workflow lanes from the model's words once, beside the rival lane, and caches them", async () => {
    wallet.connected = true;
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const topic = `${rival}ing`;
    modelAnswers((call) => {
      if (call.purpose === "x_seeds") return slots({ artifacts: ["booking page"], topics: [topic, "app"] });
      throw new Error("no reply check here");
    });
    search.mockResolvedValue(page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);

    const lanes = await db()
      .select()
      .from(schema.xLanes)
      .where(orm.eq(schema.xLanes.projectId, project.id))
      .orderBy(schema.xLanes.rank);
    expect(lanes.map((lane) => lane.family)).toEqual(["request", "request", "rival", "diy", "stack"]);
    // The request lane keeps replies: an ask is often a reply in someone else's thread.
    expect(lanes[0].body).toMatch(/^"booking page" \("looking for" OR .*\) lang:en -filter:retweets$/u);
    // The rival-request lane: the coined rival asked about, without "alternative".
    expect(lanes[1].body).toMatch(new RegExp(`^${rival} \\("looking for" OR .*\\) lang:en -filter:retweets$`, "u"));
    expect(lanes[1].body).not.toContain("alternative");
    expect(lanes[3].body.startsWith(`(${rival} OR "booking page") ("vibe coded" OR`)).toBe(true);
    // A lone generic word is dropped; the workflow lane asks for top-level posts with reach.
    expect(lanes[4].body).toMatch(new RegExp(`^\\("claude code" OR .*\\) ${topic} lang:en -filter:retweets -filter:replies min_faves:20$`, "u"));
    // The category request query is shared across projects and may already be
    // cached by another test; the four unique rival/topic queries still reach X.
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(search.mock.calls.length).toBeLessThanOrEqual(5);
    const [state] = await db().select().from(schema.xProjects).where(orm.eq(schema.xProjects.projectId, project.id));
    expect((state.seeds as { slots: { topics: string[] } }).slots.topics).toEqual([topic, "app"]);

    // A second scan with nothing changed asks the model nothing.
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_seeds")).toHaveLength(1);
  });

  it("searches every lane of a free project each day, and never a competitor row that names no product", async () => {
    const rival = uniqueRival();
    const { project } = await fixture(["This", rival, "loom"]);
    modelAnswers((call) => {
      if (call.purpose === "x_seeds") {
        return slots({ artifacts: [`${rival} page`], topics: [`${rival}ing`], notProducts: ["This"] });
      }
      throw new Error("no reply check here");
    });
    search.mockResolvedValue(page([]));
    await openX(project.id);
    // The first look reads every lane once, and free reads every lane again each day after.
    await run.runXScan(project.id, null);
    // The next day: the first look's pages were yesterday's.
    await db()
      .update(schema.usageLedger)
      .set({ at: new Date(Date.now() - 24 * HOUR) })
      .where(orm.eq(schema.usageLedger.projectId, project.id));
    await forgetPages(project.id);
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    const lanes = await db()
      .select()
      .from(schema.xLanes)
      .where(orm.eq(schema.xLanes.projectId, project.id))
      .orderBy(schema.xLanes.rank);
    expect(lanes.map((lane) => [lane.family, lane.runs])).toEqual([
      ["request", 2],
      ["rival", 2],
      ["diy", 2],
      ["stack", 2],
      ["rival", 2],
    ]);
    // The rival-request lane names the coined rival only, never "loom".
    expect(lanes[0].body.startsWith(`${rival} ("looking for"`)).toBe(true);
    expect(lanes[1].body.startsWith(`${rival} (alternative`)).toBe(true);
    expect(lanes[4].body.startsWith('("alternative to loom"')).toBe(true);
    expect(lanes.some((lane) => /\bthis\b/u.test(lane.body.split(" lang:")[0]))).toBe(false);
  });

  it("does not ask for seed words again for six hours after the call fails", async () => {
    const { project } = await fixture([uniqueRival()]);
    search.mockResolvedValue(page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [state] = await db().select().from(schema.xProjects).where(orm.eq(schema.xProjects.projectId, project.id));
    expect((state.seeds as { failedKey?: string }).failedKey).toBeTruthy();
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_seeds")).toHaveLength(1);
  });

  it("pauses a lane that comes back empty three days running on a daily tier, and hands on its slot", async () => {
    const { project } = await fixture([uniqueRival()]);
    search.mockResolvedValue(page([]));
    await openX(project.id);
    for (let day = 0; day < 3; day += 1) {
      // Each loop is a new day: the free plan's three pages a day go to the rival and build-vs-buy lanes.
      await db().delete(schema.usageLedger).where(orm.eq(schema.usageLedger.projectId, project.id));
      await forgetPages(project.id);
      await run.markLanesDue(project.id);
      await run.runXScan(project.id, null);
    }
    const lane = await laneOf(project.id, "rival");
    expect(lane).toMatchObject({ state: "paused", pauseReason: "empty", emptyStreak: 3 });
  });

  it("shows a post worth a reply only after the model checks it with the bio, and an ask beats a reply in one thread", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    // A handle no earlier run has used, so its bio is bought, never served from the shared store.
    const venting = item(`reply-me: ${rival} could be cheaper, its pricing doubled again and I rebooked every client by hand today.`, {
      authorUsername: `v${randomUUID().slice(0, 12)}`,
    });
    const nope = item(`reply-me too: ${rival} alternative talk is everywhere this week, wild.`);
    const conversation = newId("9");
    const sameAuthorReply = item(`reply-me: ${rival} could be cheaper, its pricing is so annoying for a team our size.`, { authorUsername: "samey", conversationId: conversation });
    const sameAuthorAsk = item(`I'm looking for an alternative to ${rival} for my team of four.`, { authorUsername: "samey", conversationId: conversation });
    serve("rival", page([venting, nope, sameAuthorReply, sameAuthorAsk]));
    modelAnswers((call) => {
      if (call.purpose !== "x_reply") throw new Error("no seed words here");
      return worthy(!call.prompt.includes("reply-me too"));
    });
    await openX(project.id);
    await run.runXScan(project.id, null);

    const leads = await leadsOf(project.id);
    const byTweet = new Map(leads.map((lead) => [lead.tweetId, lead]));
    expect(byTweet.get(venting.id as string)).toMatchObject({ kind: "reply", reason: expect.stringMatching(/by hand/u) });
    expect(byTweet.has(nope.id as string)).toBe(false);
    expect(byTweet.get(sameAuthorAsk.id as string)).toMatchObject({ kind: "ask" });
    expect(byTweet.has(sameAuthorReply.id as string)).toBe(false);

    const evaluations = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(evaluations.get(venting.id as string)).toMatchObject({ stage: "reply", reasonCode: "worth_reply" });
    expect((evaluations.get(venting.id as string)?.signals as { reply?: { worth_reply: boolean } }).reply?.worth_reply).toBe(true);
    // Not worth a reply: back to the buyer verdict and its reason, the reply's answer kept beside it.
    expect(evaluations.get(nope.id as string)).toMatchObject({ stage: "rejected", reasonCode: "wrong_job" });
    expect((evaluations.get(nope.id as string)?.signals as { reply?: { code: string } }).reply?.code).toBe("not_reply_worthy");
    expect(profile).toHaveBeenCalledWith({ handle: venting.authorUsername });
    const [xRun] = await db().select().from(schema.xRuns).where(orm.eq(schema.xRuns.projectId, project.id));
    expect(xRun.replies).toBeGreaterThanOrEqual(1);
    expect(xRun.replyChecks).toBeGreaterThanOrEqual(2);
  });

  it("checks at most the day's reply allowance, and nothing at all without a brief", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const allowance = TIERS.free.x.replyChecksPerDay ?? 0;
    const posts = Array.from({ length: allowance + 2 }, (_, index) => item(`reply-me ${index}: ${rival} could be cheaper, its pricing went up again for my small team.`));
    serve("rival", page(posts));
    modelAnswers((call) => {
      if (call.purpose !== "x_reply") throw new Error("no seed words here");
      return worthy(true);
    });
    const { project } = await fixture([rival], { brief: true });
    await openX(project.id);
    // A day after the first look, which had FIRST_LOOK_EXTRA more checks.
    const yesterday = new Date(Date.now() - 24 * HOUR);
    await db().insert(schema.xRuns).values({ projectId: project.id, startedAt: yesterday, finishedAt: yesterday, lanesRun: 3 });
    await run.runXScan(project.id, null);
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_reply")).toHaveLength(allowance);

    generateStructured.mockClear();
    const other = uniqueRival();
    serve("rival", page([item(`reply-me: ${other} could be cheaper, its pricing went up again for my small team.`)]));
    const bare = await fixture([other]);
    await openX(bare.project.id);
    await run.runXScan(bare.project.id, null);
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_reply")).toHaveLength(0);
    const [evaluation] = await evaluationsOf(bare.project.id);
    expect(evaluation.stage).toBe("rejected");
  });

  it("shows an ask beside the same author's reply somebody hid", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    const conversation = newId("9");
    const author = `h${randomUUID().slice(0, 12)}`;
    const venting = item(`reply-me: ${rival} could be cheaper, its pricing is so annoying for a team our size.`, { authorUsername: author, conversationId: conversation });
    serve("rival", page([venting]));
    modelAnswers((call) => {
      if (call.purpose !== "x_reply") throw new Error("no seed words here");
      return worthy(true);
    });
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [reply] = await leadsOf(project.id);
    expect(reply.kind).toBe("reply");
    await db().update(schema.xLeads).set({ status: "hidden" }).where(orm.eq(schema.xLeads.id, reply.id));

    const ask = item(`I'm looking for an alternative to ${rival} for my team of four.`, {
      authorUsername: author,
      conversationId: conversation,
      createdUtc: Math.floor(Date.now() / 1000),
    });
    await forgetPages(project.id);
    serve("rival", page([ask]));
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    const leads = await leadsOf(project.id);
    expect(leads.map((lead) => [lead.kind, lead.status]).sort()).toEqual([
      ["ask", "new"],
      ["reply", "hidden"],
    ]);
  });

  it("keeps reply candidates waiting when the model never answers, and stops asking after the first checks in flight", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    const posts = Array.from({ length: run.REPLY_CONCURRENCY + 4 }, (_, index) =>
      item(`reply-me ${index}: ${rival} could be cheaper, its pricing doubled again and I rebooked clients by hand.`),
    );
    serve("rival", page(posts));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const evaluations = await evaluationsOf(project.id);
    expect(evaluations.every((row) => row.stage === "pending_reply" && row.llmAttempts === 0)).toBe(true);
    // An outage costs about the checks already in flight, then the run stops asking.
    const asked = generateStructured.mock.calls.filter(([call]) => call.purpose === "x_reply").length;
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(asked).toBeLessThanOrEqual(run.REPLY_CONCURRENCY + 1);
    expect(await leadsOf(project.id)).toHaveLength(0);
  });

  it("settles every waiting candidate back to its buyer verdict, for free, once replies are off", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    serve("rival", page([item(`reply-me: ${rival} could be cheaper, its pricing doubled again and I rebooked clients by hand.`)]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    expect((await evaluationsOf(project.id))[0].stage).toBe("pending_reply");

    process.env.X_REPLIES = "false";
    generateStructured.mockClear();
    profile.mockClear();
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    const [evaluation] = await evaluationsOf(project.id);
    expect(evaluation).toMatchObject({ stage: "rejected", reasonCode: "wrong_job" });
    expect(generateStructured.mock.calls.filter(([call]) => call.purpose === "x_reply")).toHaveLength(0);
  });

  it("returns an unchecked candidate the gates held to Held when it expires, rather than dropping it", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    serve("rival", page([item(`reply-me: ${rival} could be cheaper, its pricing doubled again and I rebooked clients by hand.`)]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    await db()
      .update(schema.xEvaluations)
      .set({ decision: "review", createdAt: new Date(Date.now() - 100 * HOUR) })
      .where(orm.eq(schema.xEvaluations.projectId, project.id));
    await run.runXScan(project.id, null);
    const [evaluation] = await evaluationsOf(project.id);
    expect(evaluation.stage).toBe("review");
  });

  it("shows a workflow post nobody is shopping in as worth a reply after the venue check, and reads a rival-lane post with no need of its own with it too", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    wallet.connected = true;
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    const topic = `${rival}ing`;
    const workflow = item(`venue-me: my setup for booking demos: n8n pulls every lead, then ${topic} with round robin across the team.`, {
      authorUsername: `w${randomUUID().slice(0, 12)}`,
      likeCount: 240,
      viewCount: 18_000,
    });
    const onRival = item(`venue-me: we compared ${rival} vs a spreadsheet at work today, fun afternoon.`);
    search.mockImplementation(async (input: { query: string }) => {
      const family = familyOfQuery(input.query);
      return page(family === "stack" ? [workflow] : family === "rival" ? [onRival] : []);
    });
    const systems: string[] = [];
    generateStructured.mockImplementation(async (call: { purpose: string; system: string; projectId: string | null }) => {
      await db()
        .insert(schema.llmUsage)
        .values({ projectId: call.projectId, purpose: call.purpose, costUsd: "0.0004", itemsAsked: 1, itemsAnswered: 1, finishReason: "stop" });
      if (call.purpose === "x_seeds") return slots({ topics: [topic] });
      systems.push(call.system);
      return venueWorthy(!/spreadsheet/u.test((call as { prompt?: string }).prompt ?? ""));
    });
    await openX(project.id);
    await run.runXScan(project.id, null);

    const leads = await leadsOf(project.id);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ tweetId: workflow.id, kind: "reply", moment: "workflow" });
    // Two checks, both the venue rubric: the rival-lane post has no need of its own, so it is read as a place to reply, and fails.
    expect(systems).toHaveLength(2);
    expect(systems.every((system) => /found because it talks about the job/u.test(system))).toBe(true);
    const byTweet = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(byTweet.get(onRival.id as string)).toMatchObject({ stage: "rejected", reasonCode: "no_active_need" });
    expect((byTweet.get(onRival.id as string)?.signals as { reply?: { check: string } }).reply?.check).toBe("venue");
    expect((byTweet.get(workflow.id as string)?.signals as { reply?: { check: string } }).reply?.check).toBe("venue");
  });

  it("hands a numbered workflow the rival lane screened out to the workflow lane, which judges it", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    wallet.connected = true;
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    const topic = `${rival}ing`;
    const steps = item(
      `venue-me: the setup I use for demos\n1) n8n pulls every lead\n2) ${topic} with round robin\n3) ${rival} alternative for the rest\n4) claude writes the follow ups`,
      { likeCount: 90, viewCount: 9_000 },
    );
    // Both lanes find it; the rival lane reads it first and drops it as a listicle.
    search.mockImplementation(async (input: { query: string }) =>
      page(familyOfQuery(input.query) === "diy" ? [] : [steps]),
    );
    generateStructured.mockImplementation(async (call: { purpose: string; projectId: string | null }) => {
      await db()
        .insert(schema.llmUsage)
        .values({ projectId: call.projectId, purpose: call.purpose, costUsd: "0.0004", itemsAsked: 1, itemsAnswered: 1, finishReason: "stop" });
      if (call.purpose === "x_seeds") return slots({ topics: [topic] });
      return venueWorthy(true);
    });
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [evaluation] = await evaluationsOf(project.id);
    const stack = await laneOf(project.id, "stack");
    expect(evaluation).toMatchObject({ laneId: stack.id, stage: "reply", freeReject: null });
    expect((await leadsOf(project.id))[0]).toMatchObject({ kind: "reply", moment: "workflow" });
  });

  /** A category noun no other test searches for, so the request lane's page is this test's own. */
  function uniqueNoun(rival: string): string {
    return `${rival.slice("calendly".length)} page`;
  }

  /** A post whose category and request words sit sentences apart, which only the rival lane's screen keeps. */
  function splitAsk(noun: string, rival: string, over: Item = {}): Item {
    return item(`Our ${noun} keeps breaking every week. Is there an alternative to ${rival}?`, over);
  }

  it("lets the rival lane judge a post the request lanes of the same run dropped for not showing their words", async () => {
    wallet.connected = true;
    const rival = uniqueRival();
    const noun = uniqueNoun(rival);
    const { project } = await fixture([rival]);
    modelAnswers((call) => {
      if (call.purpose === "x_seeds") return slots({ artifacts: [noun] });
      throw new Error("no reply check here");
    });
    const ask = splitAsk(noun, rival);
    // The request lanes run first and read it first; the rival lane's page comes back after.
    search.mockImplementation(async (input: { query: string }) => {
      const family = familyOfQuery(input.query);
      if (family === "rival") await new Promise((resolve) => setTimeout(resolve, 200));
      return page(family === "request" || family === "rival" ? [ask] : []);
    });
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [evaluation] = await evaluationsOf(project.id);
    const rivalLane = await laneOf(project.id, "rival");
    expect(evaluation).toMatchObject({ tweetId: ask.id, laneId: rivalLane.id, stage: "lead", freeReject: null });
    expect(await leadsOf(project.id)).toHaveLength(1);
  });

  it("lets the rival lane claim on a later run a post a request lane dropped for its words, but never one dropped for who wrote it", async () => {
    wallet.connected = true;
    const rival = uniqueRival();
    const noun = uniqueNoun(rival);
    const { project } = await fixture([rival]);
    modelAnswers((call) => {
      if (call.purpose === "x_seeds") return slots({ artifacts: [noun] });
      throw new Error("no reply check here");
    });
    const ask = splitAsk(noun, rival);
    // Three conversations on one page by one author is a farm, whatever the next lane's page shows of them.
    const farmer = { authorUsername: `farm${ask.id as string}`.slice(0, 15) };
    const farmed = [splitAsk(noun, rival, farmer), splitAsk(noun, rival, farmer), splitAsk(noun, rival, farmer)];
    serve("request", page([ask, ...farmed]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const first = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(first.get(ask.id as string)).toMatchObject({ stage: "free_rejected", freeReject: "no_visible_term" });
    expect(first.get(farmed[0].id as string)).toMatchObject({ stage: "free_rejected", freeReject: "reply_farm" });

    // The next run's rival lane finds the ask and one of the farmed posts, alone on its page.
    await forgetPages(project.id);
    await run.markLanesDue(project.id);
    serve("rival", page([ask, farmed[0]]));
    await run.runXScan(project.id, null);
    const rivalLane = await laneOf(project.id, "rival");
    const second = new Map((await evaluationsOf(project.id)).map((row) => [row.tweetId, row]));
    expect(second.get(ask.id as string)).toMatchObject({ laneId: rivalLane.id, stage: "lead", freeReject: null });
    expect(second.get(farmed[0].id as string)).toMatchObject({
      laneId: first.get(farmed[0].id as string)!.laneId,
      stage: "free_rejected",
      freeReject: "reply_farm",
    });
    expect((await leadsOf(project.id)).map((lead) => lead.tweetId)).toEqual([ask.id]);
  });

  it("checks weekly once an empty first look read the last month, and daily again after anything is found", async () => {
    // A wallet, so scans in one test day never run out of pages: a run cut short is never quiet.
    wallet.connected = true;
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const { xQuiet } = await import("@/lib/x/quiet");
    await openX(project.id);
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    const earlier = (days: number) => new Date(Date.now() - days * 24 * HOUR);
    const searchedRun = (days: number, over: Record<string, unknown> = {}) => ({
      projectId: project.id,
      startedAt: earlier(days),
      finishedAt: earlier(days),
      lanesRun: 3,
      postsNew: 12,
      ...over,
    });
    // Runs cut short by a spent budget, or that searched nothing, are no evidence of quiet.
    await db()
      .insert(schema.xRuns)
      .values([searchedRun(6, { partialReason: "Today's X search budget is used." }), searchedRun(4, { lanesRun: 0 })]);
    expect((await xQuiet(project.id)).quiet).toBe(false);

    // The first look reads a month of X and finds nothing: quiet at once, checked weekly.
    search.mockResolvedValue(page([]));
    const before = Date.now();
    await run.runXScan(project.id, null);
    const [quietJob] = await queued(project.id, "x_scan");
    expect(quietJob.runAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * HOUR - 60_000);

    // One reply-worthy post in the last two weeks and it is not quiet any more.
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    await db().insert(schema.xRuns).values(searchedRun(1, { replies: 1 }));
    await forgetPages(project.id);
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    const [dailyJob] = await queued(project.id, "x_scan");
    expect(dailyJob.runAt.getTime()).toBeLessThan(Date.now() + 2 * 24 * HOUR);
  });

  it("reads a month page by page on the first look, and one page a day after on free", async () => {
    const rival = uniqueRival();
    const { project } = await fixture([rival]);
    const full = (minutesAgo = 120) =>
      Array.from({ length: 20 }, (_, i) =>
        item(`reject-me ${i}: alternative to ${rival} is what?`, { createdUtc: Math.floor((Date.now() - minutesAgo * 60_000) / 1000) }),
      );
    serve("rival", page(full(), "c1"), page(full(), "c2"), page([]));
    await openX(project.id);
    await run.runXScan(project.id, null);
    // Two full pages and the short one that ended the month.
    expect(callsFor("rival").map((call) => call.cursor ?? null)).toEqual([null, "c1", "c2"]);

    search.mockClear();
    // A full page of posts from the last few minutes: more was there, and free reads one page a day.
    serve("rival", page(full(5), "c3"), page(full(5), "c4"));
    await db()
      .update(schema.usageLedger)
      .set({ at: new Date(Date.now() - 24 * HOUR) })
      .where(orm.eq(schema.usageLedger.projectId, project.id));
    await forgetPages(project.id);
    await run.markLanesDue(project.id);
    await run.runXScan(project.id, null);
    expect(callsFor("rival")).toHaveLength(1);
    const lane = await laneOf(project.id, "rival");
    expect(lane.fullPages).toBe(1);
  });

  it("writes an ask with the gates' reason and no extra model call, and files a replied lead apart", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    serve("rival", page([item(`I'm looking for an alternative to ${rival}. The only feature I want is round-robin.`)]));
    generateStructured.mockRejectedValue(new Error("no model"));
    await openX(project.id);
    await run.runXScan(project.id, null);
    const [lead] = await leadsOf(project.id);
    expect(lead).toMatchObject({ kind: "ask", reason: expect.stringMatching(/^Wants what this product does/u) });
    expect(generateStructured.mock.calls.map(([call]) => call.purpose)).not.toContain("x_why");

    const { listXLeads } = await import("@/lib/x/read");
    const { setXLeadStatus } = await import("@/lib/x/write");
    await setXLeadStatus(project.id, lead.id, "replied", null);
    expect(await listXLeads(project.id, { days: 30, status: "new" })).toHaveLength(0);
    expect((await listXLeads(project.id, { days: 30, status: "replied" })).map((card) => card.id)).toEqual([lead.id]);
  });

  it("checks a weeks-old post the first look found, but not one older than the month it reads", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const rival = uniqueRival();
    const { project } = await fixture([rival], { brief: true });
    const old = (days: number, words: string) =>
      item(`reply-me: ${rival} could be cheaper, ${words}`, {
        authorUsername: `o${randomUUID().slice(0, 12)}`,
        createdUtc: Math.floor((Date.now() - days * 24 * HOUR) / 1000),
      });
    const tenDays = old(10, "its pricing doubled again and I rebooked every client by hand.");
    const tooOld = old(40, "its pricing doubled and I rebooked every client by hand.");
    serve("rival", page([tenDays, tooOld]));
    modelAnswers((call) => {
      if (call.purpose !== "x_reply") throw new Error("no other model call here");
      return worthy(true);
    });
    await openX(project.id);
    await run.runXScan(project.id, null);
    const leads = new Map((await leadsOf(project.id)).map((lead) => [lead.tweetId, lead]));
    expect(leads.get(tenDays.id as string)).toMatchObject({ kind: "reply" });
    expect(leads.has(tooOld.id as string)).toBe(false);
  });

  it("lists asks first, then posts worth a reply by how much a reply now would be seen, with what kind of place each is", async () => {
    const { project } = await fixture([uniqueRival()]);
    const { listXLeads } = await import("@/lib/x/read");
    const post = (id: string, hoursAgo: number, views: number) => ({
      id,
      text: `post ${id}`,
      createdAt: new Date(Date.now() - hoursAgo * HOUR),
      authorUsername: `a${id.slice(-8)}`,
      viewCount: views,
      likeCount: Math.round(views / 100),
    });
    const [ask, stale, fresh] = [post(newId("9"), 30, 500), post(newId("9"), 30, 90_000), post(newId("9"), 2, 20_000)];
    await db().insert(schema.xPosts).values([ask, stale, fresh]);
    await db()
      .insert(schema.xLeads)
      .values([
        { projectId: project.id, tweetId: ask.id, kind: "ask", score: 60, authorUsername: ask.authorUsername },
        { projectId: project.id, tweetId: stale.id, kind: "reply", moment: "price_gripe", score: 90, authorUsername: stale.authorUsername },
        { projectId: project.id, tweetId: fresh.id, kind: "reply", moment: "workflow", score: 50, authorUsername: fresh.authorUsername },
      ]);
    const cards = await listXLeads(project.id);
    expect(cards.map((card) => [card.tweetId, card.kind, card.moment, card.fresh])).toEqual([
      [ask.id, "ask", null, false],
      [fresh.id, "reply", "workflow", true],
      [stale.id, "reply", "price_gripe", false],
    ]);
  });

  it("queues no second scan when the tab opens while one is running", async () => {
    const { project } = await fixture([uniqueRival()]);
    await openX(project.id);
    await db().delete(schema.jobs).where(orm.eq(schema.jobs.projectId, project.id));
    await db().insert(schema.jobs).values({ kind: "x_scan", projectId: project.id, startedAt: new Date() });
    expect(await openX(project.id)).toBe("none");
    expect(await queued(project.id, "x_scan")).toHaveLength(0);
  });
});

describe("where an X lane's window starts", () => {
  const now = new Date("2026-09-27T17:40:00Z");
  const hour = Date.UTC(2026, 8, 27, 17);
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);

  it("reads the last month on a lane's first run, and never backfills past three days after", async () => {
    const { windowStart } = await import("@/lib/x/run");
    expect(windowStart({ coveredUntil: null, createdAt: now }, now, FIRST_LOOK_HOURS).getTime()).toBe(hour - FIRST_LOOK_HOURS * HOUR);
    // A lane that has run and never found a post: every hour since, up to three days.
    expect(windowStart({ coveredUntil: null, createdAt: at(30) }, now).getTime()).toBe(hour - 72 * HOUR);
    expect(windowStart({ coveredUntil: null, createdAt: at(24 * 5) }, now).getTime()).toBe(hour - 72 * HOUR);
  });

  it("starts an hour back over the watermark, up to the same three days", async () => {
    const { windowStart } = await import("@/lib/x/run");
    expect(windowStart({ coveredUntil: at(3), createdAt: at(100) }, now).getTime()).toBe(
      Math.floor(at(4).getTime() / HOUR) * HOUR,
    );
    expect(windowStart({ coveredUntil: at(24 * 5), createdAt: at(24 * 9) }, now).getTime()).toBe(hour - 72 * HOUR);
  });
});

describe("the project's own names on X", () => {
  it("reads the registrable name from its domain, and nothing from a shared host", async () => {
    const { domainLabel } = await import("@/lib/x/run");
    expect(domainLabel("https://app.getanyapi.com/docs")).toBe("getanyapi");
    expect(domainLabel("https://cal.com")).toBe("cal");
    expect(domainLabel("https://acme.co.uk")).toBe("acme");
    expect(domainLabel("https://acme.vercel.app")).toBe("acme");
    expect(domainLabel("https://github.com/acme/tool")).toBeNull();
    expect(domainLabel("https://apps.apple.com/app/id1")).toBeNull();
  });

  it("knows a thread by or to the product's usual handles", async () => {
    const { ownThread } = await import("@/lib/x/run");
    const names = ["AnyAPI", "getanyapi"];
    expect(ownThread({ text: "@getanyapi is this any good?" }, [], names)).toBe(true);
    expect(ownThread({ text: "@anyapihq love it" }, [], names)).toBe(true);
    expect(ownThread({ text: "great point" }, ["@anyapi: we shipped reddit search"], names)).toBe(true);
    expect(ownThread({ text: "@someone the x api is too expensive" }, ["@someone: what do you use?"], names)).toBe(false);
  });
});
