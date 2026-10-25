import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makePost, makeProject, makeUser } from "./fixtures/db";

/**
 * What the feed decides when it is read, rather than when the scan ran: the
 * project's own minimum score, and how old a comment lead is. Both are answered
 * against a real database, because both are SQL.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb("the feed at read time", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  async function fixture(threshold: number | null) {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, { scoreThreshold: threshold });
    const post = await makePost({ createdAt: new Date(Date.now() - 10 * DAY_MS) });
    return { db, schema, project, post };
  }

  /** Three leads on three threads of one project, best score first. */
  async function threeLeads(
    db: Awaited<ReturnType<typeof fixture>>["db"],
    schema: Awaited<ReturnType<typeof fixture>>["schema"],
    projectId: string,
    firstPostId: string,
  ) {
    const rows = [{ postId: firstPostId, score: 70 }];
    for (const score of [60, 50]) {
      const extra = await makePost({
        title: `Form question ${score}`,
        url: `https://www.reddit.com/r/SaaS/comments/${score}/form/`,
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      });
      rows.push({ postId: extra.id, score });
    }
    return db()
      .insert(schema.leads)
      .values(rows.map((row) => ({ projectId, ...row })))
      .returning();
  }

  it("hides a lead under the project's minimum score and shows it when that moves", async () => {
    const { db, schema, project, post } = await fixture(70);
    const { listLeads } = await import("@/lib/leads");
    const { eq } = await import("drizzle-orm");
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 60, stage: "comparing" });

    expect(await listLeads(project.id, { status: "new", days: 30 })).toHaveLength(0);
    await db()
      .update(schema.projects)
      .set({ scoreThreshold: 50 })
      .where(eq(schema.projects.id, project.id));
    expect(await listLeads(project.id, { status: "new", days: 30 })).toHaveLength(1);
  });

  it("hides a new context lead left from before the lane was switched off", async () => {
    const { db, schema, project, post } = await fixture(70);
    const { listLeads } = await import("@/lib/leads");
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 90, stage: "none", kind: "context" });

    expect(await listLeads(project.id, { status: "new", days: "all" })).toEqual([]);
  });

  it("keeps a context lead the user resolved, though the score floor would hide it", async () => {
    const { db, schema, project, post } = await fixture(70);
    const { listLeads } = await import("@/lib/leads");
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 40, stage: "none", kind: "context", status: "resolved" });

    const shown = await listLeads(project.id, { status: "resolved", days: "all" });
    expect(shown.map((lead) => lead.kind)).toEqual(["context"]);
  });

  it("dates a comment lead by the comment, not by the thread it was left in", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { listLeads } = await import("@/lib/leads");
    const [comment] = await db()
      .insert(schema.redditComments)
      .values({
        id: `c${randomUUID().slice(0, 8)}`,
        postId: post.id,
        author: "buyer",
        body: "I need the same thing for my own signup form.",
        permalink: "https://www.reddit.com/r/SaaS/comments/x/form/c1/",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();
    await db()
      .insert(schema.leads)
      .values([
        { projectId: project.id, postId: post.id, score: 60, stage: "comparing" },
        {
          projectId: project.id,
          postId: post.id,
          commentId: comment.id,
          score: 60,
          stage: "comparing",
        },
      ]);

    const today = await listLeads(project.id, { status: "new", days: 1 });
    expect(today.map((lead) => lead.commentId)).toEqual([comment.id]);
    expect(await listLeads(project.id, { status: "new", days: 30 })).toHaveLength(2);
  });

  it("narrows the feed to the leads one Insights theme holds", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { listLeads } = await import("@/lib/leads");
    const other = await makePost({
      title: "Another form question",
      url: "https://www.reddit.com/r/SaaS/comments/z/form/",
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });
    const held = await db()
      .insert(schema.leads)
      .values([
        { projectId: project.id, postId: post.id, score: 60, stage: "comparing" },
        { projectId: project.id, postId: other.id, score: 60, stage: "comparing" },
      ])
      .returning();
    const [theme] = await db()
      .insert(schema.painThemes)
      .values({ projectId: project.id, label: "prefilled forms", leadIds: [held[0].id] })
      .returning();

    const themed = await listLeads(project.id, {
      status: "new",
      days: "all",
      theme: theme.id,
    });
    expect(themed.map((lead) => lead.id)).toEqual([held[0].id]);
    expect(await listLeads(project.id, { status: "new", days: "all" })).toHaveLength(2);
  });

  it("shows what the day windows cut off once the window is all time", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { listLeads } = await import("@/lib/leads");
    const old = await makePost({
      title: "Form question from last year",
      url: "https://www.reddit.com/r/SaaS/comments/y/form/",
      createdAt: new Date(Date.now() - 300 * DAY_MS),
    });
    await db()
      .insert(schema.leads)
      .values([
        { projectId: project.id, postId: post.id, score: 60, stage: "comparing" },
        { projectId: project.id, postId: old.id, score: 60, stage: "comparing" },
      ]);

    expect(await listLeads(project.id, { status: "new", days: 30 })).toHaveLength(1);
    const everything = await listLeads(project.id, { status: "new", days: "all" });
    expect(everything.map((lead) => lead.postId).sort()).toEqual([old.id, post.id].sort());
  });

  /**
   * The list column reads one page and counts the rest. Before this, arriving
   * on a project with a backfill behind it read and drew every lead it had.
   */
  it("reads one page of the feed in its own order, and counts the whole window", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { countLeads, findLead, listLeads } = await import("@/lib/leads");
    const written = await threeLeads(db, schema, project.id, post.id);
    const best = written.sort((a, b) => b.score - a.score);

    const first = await listLeads(project.id, { status: "new", days: "all" }, { limit: 2, offset: 0 });
    const second = await listLeads(project.id, { status: "new", days: "all" }, { limit: 2, offset: 2 });

    expect(first.map((lead) => lead.id)).toEqual([best[0].id, best[1].id]);
    expect(second.map((lead) => lead.id)).toEqual([best[2].id]);
    expect(await countLeads(project.id, { status: "new", days: "all" })).toBe(3);
    // The pane opens on a lead no page of the list is holding.
    expect((await findLead(project.id, best[2].id))?.id).toBe(best[2].id);
  });

  /**
   * A post and its comments can each be a lead. Ordered by their own scores,
   * they were rows under one title scattered through the feed, with the post
   * that explains them last.
   */
  it("keeps a thread's leads together, the post before its comments", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { listLeads } = await import("@/lib/leads");
    const [between] = (await threeLeads(db, schema, project.id, post.id)).filter(
      (lead) => lead.score === 60,
    );
    const threadId = between.postId as string;
    const comments = await db()
      .insert(schema.redditComments)
      .values(
        [1, 2].map((n) => ({
          id: `c${randomUUID().slice(0, 8)}`,
          postId: threadId,
          author: `buyer${n}`,
          body: "I need the same thing.",
          permalink: `https://www.reddit.com/r/SaaS/comments/60/form/c${n}/`,
          createdAt: new Date(Date.now() - n * DAY_MS),
        })),
      )
      .returning();
    await db()
      .insert(schema.leads)
      .values([
        { projectId: project.id, postId: threadId, commentId: comments[0].id, score: 90 },
        { projectId: project.id, postId: threadId, commentId: comments[1].id, score: 55 },
      ]);

    const feed = await listLeads(project.id, { status: "new", days: "all" });

    // The thread rises on its best comment, and is read from the post down.
    expect(feed.map((lead) => [lead.postId === threadId, lead.score])).toEqual([
      [true, 60],
      [true, 90],
      [true, 55],
      [false, 70],
      [false, 50],
    ]);
  });

  /** Every face the window holds, however few of its leads have been read. */
  it("strips the faces of the whole window, not of the page", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { listLeadFaces } = await import("@/lib/leads");
    await threeLeads(db, schema, project.id, post.id);

    const faces = await listLeadFaces(project.id, { status: "new", days: "all" });

    expect(faces).toHaveLength(3);
    expect(faces[0].author).toBe("asker");
    expect(faces[0].subreddit).toBe("SaaS");
    expect(faces[0].at).toBeInstanceOf(Date);
  });

  it("lists the filter's subreddits by name and its stages in journey order, whatever order the leads land in", async () => {
    const { db, schema, project, post } = await fixture(null);
    const { feedFacets } = await import("@/lib/leads");
    const later = [
      { subreddit: "smallbusiness", stage: "problem_aware" },
      { subreddit: "Entrepreneur", stage: "comparing" },
      { subreddit: "smallbusiness", stage: "problem_aware" },
    ];
    const leadRows = [{ postId: post.id, stage: "purchase_ready" }];
    for (const row of later) {
      const extra = await makePost({
        subreddit: row.subreddit,
        title: `Form question in ${row.subreddit}`,
        url: `https://www.reddit.com/r/${row.subreddit}/comments/${randomUUID().slice(0, 6)}/form/`,
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      });
      leadRows.push({ postId: extra.id, stage: row.stage });
    }
    await db()
      .insert(schema.leads)
      .values(leadRows.map((row) => ({ projectId: project.id, score: 70, ...row })));

    expect(await feedFacets(project.id)).toEqual({
      subreddits: ["Entrepreneur", "SaaS", "smallbusiness"],
      stages: ["problem_aware", "comparing", "purchase_ready"],
    });
  });
});

/**
 * The slice a column in the people strip puts in the URL, read back. It reaches
 * a SQL bound, so a value that is not one of ours has to become no filter at
 * all rather than a date JavaScript was willing to invent.
 */
describe("the slice one strip column filters to", () => {
  it("takes a month, a day and an hour, and drops anything else", async () => {
    const { feedFilter } = await import("@/lib/feed");

    expect(feedFilter({ at: "2026-09" }).at).toBe("2026-09");
    expect(feedFilter({ at: "2026-09-14" }).at).toBe("2026-09-14");
    expect(feedFilter({ at: "2026-09-14T15" }).at).toBe("2026-09-14T15");
    // February the thirty-first parses, as the third of March. It is not a day.
    expect(feedFilter({ at: "2026-02-31" }).at).toBeUndefined();
    expect(feedFilter({ at: "2026-09-14T25" }).at).toBeUndefined();
    expect(feedFilter({ at: "2026-13" }).at).toBeUndefined();
    expect(feedFilter({ at: "yesterday" }).at).toBeUndefined();
    expect(feedFilter({ at: "2026-09-14'; drop table leads--" }).at).toBeUndefined();
    expect(feedFilter({}).at).toBeUndefined();
  });

  it("bounds each grain from its own start to the next one's", async () => {
    const { atBounds, atLabel, grainOf } = await import("@/lib/feed");

    expect(grainOf("2026-09")).toBe("month");
    expect(grainOf("2026-09-14")).toBe("day");
    expect(grainOf("2026-09-14T15")).toBe("hour");

    // A month is as long as the month is, not thirty days.
    expect(atBounds("2026-02")).toEqual({
      start: new Date(2026, 1, 1),
      end: new Date(2026, 2, 1),
    });
    expect(atBounds("2026-09-14T15").end).toEqual(new Date(2026, 8, 14, 16));
    expect(atLabel("2026-09-14")).toContain("14");
  });

  it("keeps the window the slice was picked from, so it can be handed back", async () => {
    const { feedFilter } = await import("@/lib/feed");

    expect(feedFilter({ days: "7", at: "2026-09-14" })).toMatchObject({
      days: 7,
      at: "2026-09-14",
    });
  });
});
