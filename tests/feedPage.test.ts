import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { forgetEveryProjectFeed } from "@/lib/projectFeedCache";
import { describeDb, makePost, makeProject, makeUser } from "./fixtures/db";

/**
 * What the leads page reads against a real database, and what it does not read
 * twice. The holder itself is pinned in projectFeedCache.test.ts; this proves
 * the page's own reads go through it, and that the writers behind them drop it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb("the leads page read", () => {
  /** Every user this file made, so nothing it wrote outlives the test. */
  const made: string[] = [];
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
    forgetEveryProjectFeed();
  });

  /**
   * The scheduler sweeps every project there is, so a project left behind here
   * is one it seeds a scan for while another suite is counting what it seeded.
   * Deleting the user cascades to the project and its leads; the posts are
   * shared by every project and are left where they are.
   */
  afterEach(async () => {
    await cleanupAuth?.();
    if (made.length === 0) {
      return;
    }
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");
    await db().delete(schema.users).where(inArray(schema.users.id, made.splice(0)));
  });

  async function fixture() {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    made.push(user.id);
    const project = await makeProject(user.id);
    const post = await makePost({ createdAt: new Date(Date.now() - DAY_MS) });
    return { db, schema, project, post };
  }

  /** Another post in the window, written behind the page's back. */
  async function anotherLead(
    db: Awaited<ReturnType<typeof fixture>>["db"],
    schema: Awaited<ReturnType<typeof fixture>>["schema"],
    projectId: string,
  ) {
    const post = await makePost({
      title: "Another form question",
      url: "https://www.reddit.com/r/SaaS/comments/y/form/",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    await db()
      .insert(schema.leads)
      .values({ projectId, postId: post.id, score: 60, stage: "comparing" });
  }

  const FILTER = { status: "new", days: 30 } as const;

  it("answers a second read of the same filter without reading again", async () => {
    const { db, schema, project, post } = await fixture();
    const { feedPage } = await import("@/lib/feedPage");
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 60, stage: "comparing" });

    const first = await feedPage(project.id, FILTER);
    await anotherLead(db, schema, project.id);

    // The same object, not an equal one: nothing was read the second time.
    expect(await feedPage(project.id, FILTER)).toBe(first);
    expect(first.rows).toHaveLength(1);
    expect(first.total).toBe(1);
  });

  /**
   * A first sweep's leads are mostly older than the month the feed opens on.
   * The page opening on all time instead has to be one held entry under the
   * URL asked for: two entries, the window's and all time's, evicted each
   * other and every refresh read twice.
   */
  it("opens an empty window nobody picked on all time, and answers its repeat from one entry", async () => {
    const { db, schema, project } = await fixture();
    const { feedPage } = await import("@/lib/feedPage");
    const old = await makePost({
      title: "An old form question",
      url: "https://www.reddit.com/r/SaaS/comments/z/form/",
      createdAt: new Date(Date.now() - 90 * DAY_MS),
    });
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: old.id, score: 60, stage: "comparing" });

    const opened = await feedPage(project.id, FILTER, true);
    expect(opened.widened).toBe(true);
    expect(opened.total).toBe(1);
    expect(await feedPage(project.id, FILTER, true)).toBe(opened);
    // The same thirty days picked by hand stay thirty days.
    const picked = await feedPage(project.id, FILTER);
    expect(picked.widened).toBe(false);
    expect(picked.total).toBe(0);
    expect(picked.elsewhere).toBe(1);
  });

  it("reads again when the filter moves", async () => {
    const { db, schema, project, post } = await fixture();
    const { feedPage } = await import("@/lib/feedPage");
    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 60, stage: "comparing" });

    const shown = await feedPage(project.id, FILTER);
    const hidden = await feedPage(project.id, { status: "hidden", days: 30 });
    expect(shown.rows).toHaveLength(1);
    expect(hidden.rows).toHaveLength(0);
  });

  it("reads one page of leads and counts the rest", async () => {
    const { db, schema, project } = await fixture();
    const { FEED_PAGE_SIZE } = await import("@/lib/feed");
    const { feedPage } = await import("@/lib/feedPage");
    for (let made = 0; made < FEED_PAGE_SIZE + 3; made += 1) {
      await anotherLead(db, schema, project.id);
    }

    const page = await feedPage(project.id, FILTER);
    expect(page.rows).toHaveLength(FEED_PAGE_SIZE);
    expect(page.total).toBe(FEED_PAGE_SIZE + 3);
    // The strip over the list is a calendar of everyone, not of one page.
    expect(page.faces).toHaveLength(FEED_PAGE_SIZE + 3);
  });

  it("reads again after a scan writes a lead", async () => {
    const { project, post } = await fixture();
    const { feedPage } = await import("@/lib/feedPage");
    const { writeLeads } = await import("@/lib/scan/leads");
    expect((await feedPage(project.id, FILTER)).rows).toHaveLength(0);

    await writeLeads([
      {
        projectId: project.id,
        postId: post.id,
        commentId: null,
        kind: "buyer",
        score: 60,
        quality: 0.55,
        fit: 3,
        intent: 3,
        engagement: 2,
        stage: "comparing",
        reason: "asked for exactly this",
        matchedPhrase: "prefilled forms",
      },
    ]);

    expect((await feedPage(project.id, FILTER)).rows).toHaveLength(1);
  });

  it("reads again after a lead's status changes", async () => {
    const { db, schema, project, post } = await fixture();
    const { feedPage } = await import("@/lib/feedPage");
    const { setLeadStatus } = await import("@/lib/leads");
    const [lead] = await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: post.id, score: 60, stage: "comparing" })
      .returning();
    expect((await feedPage(project.id, FILTER)).rows).toHaveLength(1);

    await setLeadStatus(project.id, lead.id, "hidden", null);

    expect((await feedPage(project.id, FILTER)).rows).toHaveLength(0);
  });
});
