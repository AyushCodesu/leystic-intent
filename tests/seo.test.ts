import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { competitorsNamed } from "@/lib/competitors/match";
import { seoSettings } from "@/lib/seo/limits";
import { redditResults, redditThread } from "@/lib/seo/links";
import { TIERS } from "@/lib/tiers";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/** Only the booking is faked; writeProgress still writes to the real jobs row. */
vi.mock("@/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/enqueue")>()),
  enqueueJob: vi.fn(),
}));

let cleanupAuth: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const auth = await installTestAuthorizedSource("all");
  cleanupAuth = auth.cleanup;
});

afterEach(async () => {
  await cleanupAuth?.();
});

describe("Reddit thread links", () => {
  it("reads the community and the post out of a thread URL on any reddit host", () => {
    expect(redditThread("https://www.reddit.com/r/SaaS/comments/abc123/some_title/")).toEqual({
      subreddit: "SaaS",
      postId: "abc123",
      canonicalUrl: "https://www.reddit.com/r/SaaS/comments/abc123/",
    });
    expect(redditThread("https://old.reddit.com/r/SaaS/comments/abc123/")?.postId).toBe("abc123");
    expect(redditThread("https://reddit.com/r/SaaS/comments/abc123/")?.subreddit).toBe("SaaS");
  });

  it("rejects mirrors, non-thread pages and anything unparseable", () => {
    expect(redditThread("https://notreddit.com/r/SaaS/comments/abc123/")).toBeNull();
    expect(redditThread("https://reddit.com.example.net/r/SaaS/comments/abc123/")).toBeNull();
    expect(redditThread("https://www.reddit.com/r/SaaS/")).toBeNull();
    expect(redditThread("https://www.reddit.com/user/someone/")).toBeNull();
    expect(redditThread("https://www.reddit.com/r/SaaS/comments/")).toBeNull();
    expect(redditThread("/r/SaaS/comments/abc123/")).toBeNull();
  });

  it("keeps Google's own order and positions, each thread under its canonical URL", () => {
    const kept = redditResults([
      { link: "https://example.com/a", position: 1 },
      { link: "https://www.reddit.com/r/SaaS/comments/a/", position: 2 },
      { link: "https://old.reddit.com/r/nocode/comments/b/some_title/?share=1", position: 3 },
      { link: "https://www.reddit.com/r/SaaS/", position: 4 },
    ]);
    expect(kept.map((entry) => entry.result.position)).toEqual([2, 3]);
    expect(kept.map((entry) => entry.thread.canonicalUrl)).toEqual([
      "https://www.reddit.com/r/SaaS/comments/a/",
      "https://www.reddit.com/r/nocode/comments/b/",
    ]);
  });
});

describe("competitor match", () => {
  it("finds a name in the title or the body whatever its case", () => {
    expect(competitorsNamed(["Typeform"], "Is TYPEFORM worth it?")).toEqual(["Typeform"]);
    expect(competitorsNamed(["Typeform"], "Best form tool\nwe moved off typeform")).toEqual(["Typeform"]);
  });

  it("says no when no competitor is named", () => {
    expect(competitorsNamed(["Typeform", "Tally"], "Best form tool\ngoogle forms is fine")).toEqual([]);
  });

  it("ignores an empty competitor rather than matching everything", () => {
    expect(competitorsNamed(["  "], "Best form tool\nanything")).toEqual([]);
    expect(competitorsNamed([], "Best form tool\nanything")).toEqual([]);
  });
});

describe("phrasing cap", () => {
  const phrasings = Array.from({ length: 12 }, (_, index) => `way of asking ${index}`);

  it("cuts a free project to the tier's allowance and refreshes weekly", () => {
    const settings = seoSettings(TIERS.free, phrasings);
    expect(settings.phrasings).toHaveLength(10);
    expect(settings.phrasings[0]).toBe("way of asking 0");
    expect(settings.refreshDays).toBe(7);
  });

  it("caps nothing for a connected wallet", () => {
    const settings = seoSettings(TIERS.connected, phrasings);
    expect(settings.phrasings).toHaveLength(12);
  });

  it("treats a self-hosted instance like a connected wallet", () => {
    expect(seoSettings(null, phrasings).phrasings).toHaveLength(12);
    expect(seoSettings(null, phrasings).refreshDays).toBe(1);
  });
});

/**
 * The refresh searches the way buyers say the problem. It used to search the
 * plan's Reddit queries, which are Boolean expressions Google reads as
 * literal text, so this is the seam that has to stay pointed at the phrasings.
 */
describeDb("what a refresh searches", () => {
  it("takes the project's phrasings, never its Reddit Boolean queries", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { loadScanProject } = await import("@/lib/scan/project");
    const user = await makeUser();
    const project = await makeProject(user.id, {
      name: "HotelsAllow",
      problemPhrasings: ["hotels that let 19 year olds check in"],
    });
    await db()
      .insert(schema.projectKeywords)
      .values({ projectId: project.id, keyword: "(hotel OR hotels) AND (18 OR 19)" });

    const loaded = await loadScanProject(project.id);
    const settings = seoSettings(TIERS.free, loaded?.phrasings ?? []);
    expect(settings.phrasings).toEqual(["hotels that let 19 year olds check in"]);
    expect(settings.phrasings).not.toContain("(hotel OR hotels) AND (18 OR 19)");
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});

/**
 * The refresh used to return before booking anything when a project had no
 * phrasings yet, so the one job a new project gets was also its last: the page
 * kept saying the first refresh had finished and nothing ever looked again.
 */
describeDb("what a refresh books next", () => {
  it("books the next refresh even when there are no phrasings to search", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { enqueueJob } = await import("@/jobs/enqueue");
    const { runSeoRefresh } = await import("@/lib/seo/refresh");
    const booked = vi.mocked(enqueueJob);
    booked.mockClear();

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "No phrasings yet", problemPhrasings: [] });
    const [job] = await db()
      .insert(schema.jobs)
      .values({ kind: "seo_refresh", projectId: project.id, runAt: new Date() })
      .returning();

    const outcome = await runSeoRefresh(project.id, job.id);

    expect(outcome).toEqual({ phrasings: 0, threads: 0, costUsd: 0 });
    expect(booked).toHaveBeenCalledTimes(1);
    const [kind, projectId, runAt] = booked.mock.calls[0];
    expect(kind).toBe("seo_refresh");
    expect(projectId).toBe(project.id);
    expect(runAt!.getTime()).toBeGreaterThan(Date.now());

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});

/**
 * Discovery already judges every thread it buys, and since both sides ask
 * Google the one question, the threads that rank for a phrasing are the ones
 * it judged. The tab used to list them in Google's order alone, so a thread
 * with nobody asking in it sat above one with a buyer in it. It sorts on the
 * verdict now and hides nothing: a thread nobody asked in still ranks, and one
 * reply in it still works.
 */
describeDb("the order ranking threads are read in", () => {
  it("puts the threads worth replying in first, and an unjudged one above a rejected one", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { listOpportunities, verdictOf } = await import("@/lib/seo/read");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    const verdicts = [
      ["irrelevant", 1],
      ["unlabeled", 2],
      ["plausible", 3],
      ["relevant", 4],
    ] as const;
    for (const [relevance, position] of verdicts) {
      const postId = `${run}${relevance}`;
      await db().insert(schema.redditPosts).values({
        id: postId,
        subreddit: "webscraping",
        title: `A thread judged ${relevance}`,
        url: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        createdAt: new Date(),
      });
      await db().insert(schema.seoOpportunities).values({
        projectId: project.id,
        keyword: "reddit scraper",
        postId,
        position,
        competitorPresent: false,
        refreshedAt: new Date(),
      });
      await db().insert(schema.discoveryEvidence).values({
        projectId: project.id,
        postId,
        canonicalUrl: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        subreddit: "webscraping",
        query: "reddit scraper reddit",
        position,
        title: `A thread judged ${relevance}`,
        relevance,
      });
    }

    const rows = await listOpportunities(project.id, {});
    expect(rows.map((row) => row.postId)).toEqual([
      `${run}relevant`,
      `${run}plausible`,
      `${run}unlabeled`,
      `${run}irrelevant`,
    ]);
    expect(rows.map((row) => verdictOf(row.verdictRank))).toEqual([
      "relevant",
      "plausible",
      null,
      "irrelevant",
    ]);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    await db()
      .delete(schema.redditPosts)
      .where(
        inArray(
          schema.redditPosts.id,
          verdicts.map(([relevance]) => `${run}${relevance}`),
        ),
      );
  });
});

/**
 * The refresh pays to judge a ranking thread only when nothing has judged it.
 * Discovery and this refresh ask Google the one question, so most threads
 * arrive with a verdict already on them, and asking the model about those
 * again would buy an answer this project already holds.
 */
describeDb("what a refresh pays to judge", () => {
  it("judges only the ranking threads nothing has judged yet", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const label = await import("@/lib/discovery/label");
    const { judgeUnseen } = await import("@/lib/seo/refresh");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    const judged = `${run}judged`;
    const fresh = `${run}fresh`;
    await db().insert(schema.discoveryEvidence).values({
      projectId: project.id,
      postId: judged,
      canonicalUrl: `https://www.reddit.com/r/webscraping/comments/${judged}/x/`,
      subreddit: "webscraping",
      query: "reddit scraper reddit",
      position: 1,
      title: "Discovery already read this one",
      relevance: "relevant",
    });

    const asked = vi.spyOn(label, "labelThreads").mockResolvedValue([
      { id: fresh, relevance: "irrelevant", destination: null, entities: [] },
    ]);
    await judgeUnseen(
      { id: project.id, product: { name: "AnyAPI" } } as never,
      [judged, fresh].map((postId, index) => ({
        postId,
        canonicalUrl: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        subreddit: "webscraping",
        query: "reddit scraper reddit",
        position: index + 1,
        title: `A ranking thread ${postId}`,
        snippet: "Someone wrote something here.",
      })),
    );

    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0][0].candidates.map((item) => item.id)).toEqual([fresh]);
    const rows = await db()
      .select()
      .from(schema.discoveryEvidence)
      .where(eq(schema.discoveryEvidence.projectId, project.id));
    const byPost = new Map(rows.map((row) => [row.postId, row.relevance]));
    expect(byPost.get(judged)).toBe("relevant");
    expect(byPost.get(fresh)).toBe("irrelevant");

    asked.mockRestore();
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});

/**
 * The rail's pill used to read every ranking thread and take the length, on
 * every page of the app. The count it asks for now has to agree with the list
 * it stands for, including the part that is easy to get wrong: a thread whose
 * post has aged out of our thirty days keeps its row with a null post, and the
 * list does not show it.
 */
describeDb("the ranking-thread count in the rail", () => {
  it("counts what the list shows, and not a thread whose post is gone", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { countOpportunities, listOpportunities } = await import("@/lib/seo/read");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    const held = [`${run}a`, `${run}b`];
    for (const [index, postId] of held.entries()) {
      await db().insert(schema.redditPosts).values({
        id: postId,
        subreddit: "webscraping",
        title: `A ranking thread ${postId}`,
        url: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        createdAt: new Date(),
      });
      await db().insert(schema.seoOpportunities).values({
        projectId: project.id,
        keyword: "reddit scraper",
        postId,
        position: index + 1,
      });
    }
    // The closed thread the tab opens without, and so the pill counts without.
    const closed = `${run}closed`;
    await db().insert(schema.redditPosts).values({
      id: closed,
      subreddit: "webscraping",
      title: "A locked ranking thread",
      url: `https://www.reddit.com/r/webscraping/comments/${closed}/x/`,
      isLocked: true,
      createdAt: new Date(),
    });
    await db().insert(schema.seoOpportunities).values({
      projectId: project.id,
      keyword: "reddit scraper",
      postId: closed,
      position: 4,
    });
    // The thread whose post retention already deleted, which set its post to
    // null rather than taking the row away.
    await db().insert(schema.seoOpportunities).values({
      projectId: project.id,
      keyword: "reddit scraper",
      postId: null,
      position: 3,
    });

    const rows = await listOpportunities(project.id, {});
    expect(await countOpportunities(project.id)).toBe(rows.length);
    expect(rows.length).toBe(held.length);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    await db().delete(schema.redditPosts).where(inArray(schema.redditPosts.id, [...held, closed]));
  });
});

/**
 * A thread Reddit archived or a moderator locked cannot be replied in, so the
 * tab hides it by default rather than offering it as an opportunity. It is a
 * filter and not a deletion: asking for them brings them back, after the open
 * ones, because they are still evidence of what ranks.
 */
describeDb("closed ranking threads", () => {
  it("hides a closed thread until it is asked for, then sorts it last", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { listOpportunities, seoFacets } = await import("@/lib/seo/read");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    // The closed ones rank above the open one, so Google's order alone would
    // put them first and only the closed rule can move them.
    const threads = [
      { suffix: "archived", isArchived: true, isLocked: null, position: 1 },
      { suffix: "locked", isArchived: null, isLocked: true, position: 2 },
      { suffix: "open", isArchived: false, isLocked: false, position: 3 },
      { suffix: "unknown", isArchived: null, isLocked: null, position: 4 },
    ];
    for (const thread of threads) {
      const postId = `${run}${thread.suffix}`;
      await db().insert(schema.redditPosts).values({
        id: postId,
        subreddit: "webscraping",
        title: `A ${thread.suffix} thread`,
        url: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        isArchived: thread.isArchived,
        isLocked: thread.isLocked,
        createdAt: new Date(),
      });
      await db().insert(schema.seoOpportunities).values({
        projectId: project.id,
        keyword: "reddit scraper",
        postId,
        position: thread.position,
      });
    }

    const open = await listOpportunities(project.id, {});
    expect(open.map((row) => row.postId)).toEqual([`${run}open`, `${run}unknown`]);
    expect(open.map((row) => row.closed)).toEqual([false, false]);

    const all = await listOpportunities(project.id, { closed: "yes" });
    expect(all.map((row) => row.postId)).toEqual([
      `${run}open`,
      `${run}unknown`,
      `${run}archived`,
      `${run}locked`,
    ]);
    expect(all.map((row) => row.closed)).toEqual([false, false, true, true]);

    // A phrasing whose threads are all closed is not offered as a filter that
    // would show nothing, so the facets apply the same rule.
    await db().insert(schema.seoOpportunities).values({
      projectId: project.id,
      keyword: "only closed threads rank for this",
      postId: `${run}archived`,
      position: 1,
    });
    expect((await seoFacets(project.id)).keywords).toEqual(["reddit scraper"]);
    expect((await seoFacets(project.id, { closed: "yes" })).keywords).toHaveLength(2);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    await db()
      .delete(schema.redditPosts)
      .where(
        inArray(
          schema.redditPosts.id,
          threads.map((thread) => `${run}${thread.suffix}`),
        ),
      );
  });
});

/**
 * The discovery verdict answers whether anybody is asking; it does not say how
 * far along they are. The refresh judges every thread it opens the way the scan
 * judges a candidate, so the tab can be read in that order.
 *
 * The order is applied over the rows now rather than in SQL, because three of
 * the four orders the tab offers fold a score no column holds. This pins both
 * halves: that the read still hands the judgement over, and that the order puts
 * it to use.
 */
describeDb("ranking threads ordered by buyer intent", () => {
  it("puts the higher intent first and an unjudged thread last", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { listOpportunities, toThread } = await import("@/lib/seo/read");
    const { scoreThreads } = await import("@/lib/seo/score");
    const { orderThreads } = await import("@/lib/seo/views");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    // Google ranks them in exactly the order buyer intent does not.
    const threads = [
      { suffix: "unjudged", judgement: null, position: 1 },
      { suffix: "weak", judgement: { fit: 3, intent: 2 }, position: 2 },
      { suffix: "strong", judgement: { fit: 3, intent: 4 }, position: 3 },
    ];
    for (const thread of threads) {
      const postId = `${run}${thread.suffix}`;
      await db().insert(schema.redditPosts).values({
        id: postId,
        subreddit: "webscraping",
        title: `A ${thread.suffix} thread`,
        url: `https://www.reddit.com/r/webscraping/comments/${postId}/x/`,
        createdAt: new Date(),
      });
      await db().insert(schema.seoOpportunities).values({
        projectId: project.id,
        keyword: "reddit scraper",
        postId,
        position: thread.position,
      });
      if (!thread.judgement) {
        continue;
      }
      await db().insert(schema.leadEvaluations).values({
        projectId: project.id,
        postId,
        commentId: null,
        decision: "qualify",
        relationship: "buyer",
        needState: "open",
        fit: thread.judgement.fit,
        intent: thread.judgement.intent,
        engagement: 0,
        score: 0,
        reasonCodes: ["supported_open_need"],
        reason: "Judged for this test.",
        profileVersion: 1,
        contentHash: postId,
        scorerVersion: "test",
      });
    }

    const held = scoreThreads((await listOpportunities(project.id, {})).map(toThread));

    const byIntent = orderThreads(held, "intent");
    expect(byIntent.map((thread) => thread.postId)).toEqual([
      `${run}strong`,
      `${run}weak`,
      `${run}unjudged`,
    ]);
    expect(byIntent.map((thread) => thread.intent)).toEqual([4, 2, null]);
    expect(byIntent.map((thread) => thread.fit)).toEqual([3, 3, null]);

    // Google's own order is one of the four the tab offers, and it disagrees
    // with the other three, which is the whole reason the tab offers a choice.
    expect(orderThreads(held, "google").map((thread) => thread.postId)).toEqual([
      `${run}unjudged`,
      `${run}weak`,
      `${run}strong`,
    ]);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    await db()
      .delete(schema.redditPosts)
      .where(
        inArray(
          schema.redditPosts.id,
          threads.map((thread) => `${run}${thread.suffix}`),
        ),
      );
  });
});

/**
 * Everything the refresh already paid for and the tab never showed: what Google
 * put under the link, who asked, how established they are, what the community
 * allows. It is one query, and the part that can quietly go wrong is the
 * snippet: a post can carry evidence from several phrasings, and a snippet from
 * the wrong one is a claim about what a searcher saw that is simply false.
 */
describeDb("the facts a thread arrives with", () => {
  it("takes the snippet Google showed for this phrasing, not for another one", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { listOpportunities, toThread } = await import("@/lib/seo/read");
    const { watchedCompetitors } = await import("@/lib/competitors/read");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "AnyAPI" });

    const run = randomUUID().replace(/-/g, "").slice(0, 8);
    const postId = `${run}post`;
    const url = `https://www.reddit.com/r/webscraping/comments/${postId}/x/`;
    await db().insert(schema.redditAuthors).values({
      username: `u_${run}`,
      avatarUrl: "https://example.com/face.png",
      karma: 4120,
      accountCreatedAt: new Date("2019-04-01T00:00:00Z"),
    });
    await db()
      .insert(schema.subreddits)
      .values({
        name: `webscraping_${run}`,
        subscribers: 91000,
        promoPolicy: "No self-promotion outside the Saturday thread",
        rulesText: "Rule 4: no advertising.",
      });
    await db().insert(schema.redditPosts).values({
      id: postId,
      subreddit: `webscraping_${run}`,
      author: `U_${run}`,
      title: "What do people use to pull Reddit data now?",
      body: "Tried a few and none of them keep up.",
      url,
      score: 240,
      numComments: 31,
      createdAt: new Date(),
    });
    await db().insert(schema.seoOpportunities).values({
      projectId: project.id,
      keyword: "  reddit scraper  ",
      postId,
      position: 2,
    });
    // Two phrasings found the same thread. Only one of them is this row's.
    await db()
      .insert(schema.discoveryEvidence)
      .values([
        {
          projectId: project.id,
          postId,
          canonicalUrl: url,
          subreddit: `webscraping_${run}`,
          query: "reddit scraper reddit",
          position: 2,
          title: "What do people use to pull Reddit data now?",
          snippet: "The snippet for this phrasing.",
          relevance: "relevant",
        },
        {
          projectId: project.id,
          postId,
          canonicalUrl: url,
          subreddit: `webscraping_${run}`,
          query: "some other way of asking reddit",
          position: 7,
          title: "What do people use to pull Reddit data now?",
          snippet: "The snippet for a different phrasing.",
          relevance: "relevant",
        },
      ]);

    const [held] = (await listOpportunities(project.id, {})).map(toThread);

    // The stored keyword has the padding `googleQuery` trims, so this also
    // pins that the join is built the way the refresh wrote the query.
    expect(held.snippet).toBe("The snippet for this phrasing.");
    expect(held.author).toBe(`U_${run}`);
    expect(held.authorKarma).toBe(4120);
    expect(held.authorAvatarUrl).toBe("https://example.com/face.png");
    expect(held.authorCreatedAt).toBeInstanceOf(Date);
    expect(held.subredditSubscribers).toBe(91000);
    expect(held.promoPolicy).toBe("No self-promotion outside the Saturday thread");
    expect(held.rulesText).toBe("Rule 4: no advertising.");
    expect(held.body).toBe("Tried a few and none of them keep up.");
    expect(held.postId).toBe(postId);
    expect(held.refreshedAt).toBeInstanceOf(Date);

    // A competitor a person excluded on the Product page is not named here.
    await db()
      .insert(schema.projectCompetitors)
      .values([
        { projectId: project.id, name: "Apify", state: "active" },
        { projectId: project.id, name: "Bright Data", state: "pinned" },
        { projectId: project.id, name: "Dropped", state: "excluded" },
      ]);
    expect((await watchedCompetitors(project.id)).map((row) => row.name).sort()).toEqual([
      "Apify",
      "Bright Data",
    ]);

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, postId));
    await db()
      .delete(schema.redditAuthors)
      .where(eq(schema.redditAuthors.username, `u_${run}`));
    await db()
      .delete(schema.subreddits)
      .where(eq(schema.subreddits.name, `webscraping_${run}`));
  });
});
