import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { judgeAnswers, readingAnswers, type JevSpec } from "./jevAnswers";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * The one sweep a scorer change owes a project: every verdict an older scorer
 * made is judged again, and the leads table is made to agree with the answers.
 * Against a real database, because what the sweep finds and what it withdraws
 * are both queries.
 */

const { askJev } = vi.hoisted(() => ({ askJev: vi.fn() }));

vi.mock("@/lib/jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jev")>()),
  askJev,
}));

describeDb("re-judging a project under a new scorer", () => {
  let uninstallAuth: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    uninstallAuth = (await installTestAuthorizedSource("reddit")).cleanup;
  });

  afterAll(async () => {
    if (uninstallAuth) {
      await uninstallAuth();
    }
  });
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let runRescore: typeof import("@/lib/scan/rescore").runRescore;
  let projectsWithStaleEvaluations: typeof import("@/lib/scan/rescore").projectsWithStaleEvaluations;
  let SCORER_VERSION: string;
  let upsertPosts: typeof import("@/lib/reddit/store").upsertPosts;
  let eq: typeof import("drizzle-orm").eq;

  beforeEach(async () => {
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    ({ runRescore, projectsWithStaleEvaluations } = await import("@/lib/scan/rescore"));
    ({ SCORER_VERSION } = await import("@/lib/scan/evaluations"));
    ({ upsertPosts } = await import("@/lib/reddit/store"));
    ({ eq } = await import("drizzle-orm"));
    askJev.mockReset();
  });

  /** One project holding one stale verdict on one post, with or without a lead. */
  async function fixture(options: { lead: null | { status: string } }) {
    const user = await makeUser();
    const project = await makeProject(user.id, { solution: "A form builder." });
    const [post] = await upsertPosts([
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "SaaS",
        author: "asker",
        title: "Form question",
        body: "Our signup form needs conditional logic.",
        permalink: `/r/SaaS/comments/${randomUUID().slice(0, 6)}/form/`,
        score: 3,
        numComments: 2,
        createdUtc: Math.floor(Date.now() / 1000) - 3600,
      },
    ]);
    await db().insert(schema.leadEvaluations).values({
      projectId: project.id,
      postId: post.id,
      decision: "qualify",
      relationship: "buyer",
      needState: "open",
      fit: 4,
      intent: 3,
      engagement: 2,
      score: 80,
      reasonCodes: ["supported_open_need"],
      reason: "An older scorer said so.",
      profileVersion: project.profileVersion,
      contentHash: "stale",
      scorerVersion: "2026-01-01.0",
    });
    if (options.lead) {
      await db().insert(schema.leads).values({
        projectId: project.id,
        postId: post.id,
        score: 80,
        fit: 4,
        intent: 3,
        engagement: 2,
        stage: "solution_seeking",
        reason: "An older scorer said so.",
        matchedPhrase: "conditional logic",
        status: options.lead.status,
      });
    }
    return { project, post };
  }

  /**
   * Jev answers every candidate of every call the same way: the shared reading
   * first, then the judgement, both from one spec.
   */
  function answers(spec: JevSpec = {}) {
    askJev.mockImplementation(async (call: { purpose: string; itemsAsked: number }) => {
      const specs = Array.from({ length: call.itemsAsked }, () => ({ quote: "s0", ...spec }));
      return call.purpose === "reading" ? readingAnswers(specs) : judgeAnswers(specs);
    });
  }

  async function leadsOf(projectId: string) {
    return db().select().from(schema.leads).where(eq(schema.leads.projectId, projectId));
  }

  it("finds the stale verdicts, re-judges them, and stamps the current scorer", async () => {
    const { project } = await fixture({ lead: { status: "new" } });
    expect((await projectsWithStaleEvaluations()).has(project.id)).toBe(true);
    answers({});

    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome.judged).toBe(1);
    expect(outcome.unchanged).toBe(1);
    const [stored] = await db()
      .select()
      .from(schema.leadEvaluations)
      .where(eq(schema.leadEvaluations.projectId, project.id));
    expect(stored.scorerVersion).toBe(SCORER_VERSION);
    expect(stored.contentHash).toBe("stale");
    expect((await projectsWithStaleEvaluations()).has(project.id)).toBe(false);
  });

  it("takes back a lead whose verdict dropped to review", async () => {
    const { project } = await fixture({ lead: { status: "new" } });
    answers({ hardRequirement: "unknown", intent: 2, audience: 0.1, founderWouldReply: 0.05 });

    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome.demoted).toBe(1);
    expect(await leadsOf(project.id)).toHaveLength(0);
    const { listReviewItems } = await import("@/lib/leads");
    expect(await listReviewItems(project.id, 30)).toHaveLength(1);
  });

  it("takes back a lead whose verdict dropped to a rejection", async () => {
    const { project } = await fixture({ lead: { status: "new" } });
    answers({ relationship: "seller" });

    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome.demoted).toBe(1);
    expect(await leadsOf(project.id)).toHaveLength(0);
  });

  it("gives a post that now qualifies the lead it never had", async () => {
    const { project, post } = await fixture({ lead: null });
    answers({});

    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome.promoted).toBe(1);
    const rows = await leadsOf(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].postId).toBe(post.id);
  });

  it("never touches a lead the person already acted on", async () => {
    for (const status of ["hidden", "not_fit", "resolved"]) {
      const { project } = await fixture({ lead: { status } });
      answers({ hardRequirement: "unknown", intent: 2, audience: 0.1, founderWouldReply: 0.05 });

      const outcome = await runRescore(project.id, randomUUID());

      expect(outcome.demoted).toBe(0);
      const rows = await leadsOf(project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(status);
    }
  });

  /**
   * The scan judges only comments that answer the post, so a stale verdict on a
   * reply to another comment, or on one whose parent is unknown, is never
   * judged again: re-judged it could put a nested reply in the feed.
   */
  it("judges a stale comment verdict only when the comment answers the post", async () => {
    const { project, post } = await fixture({ lead: null });
    await db()
      .update(schema.leadEvaluations)
      .set({ scorerVersion: SCORER_VERSION })
      .where(eq(schema.leadEvaluations.projectId, project.id));
    const comment = async (parentId: string | null) => {
      const [row] = await db()
        .insert(schema.redditComments)
        .values({
          id: `c${randomUUID().slice(0, 8)}`,
          postId: post.id,
          parentId,
          author: `replier${randomUUID().slice(0, 4)}`,
          body: "We need conditional logic on our signup form too.",
          createdAt: new Date(),
        })
        .returning();
      await db().insert(schema.leadEvaluations).values({
        projectId: project.id,
        postId: post.id,
        commentId: row.id,
        decision: "reject",
        relationship: "unknown",
        needState: "unknown",
        engagement: 2,
        score: 0,
        reasonCodes: ["insufficient_evidence"],
        reason: "An older scorer said so.",
        profileVersion: project.profileVersion,
        contentHash: "stale",
        scorerVersion: "2026-01-01.0",
      });
      return row;
    };
    const nested = await comment("t1_another");
    const unknown = await comment(null);
    expect((await projectsWithStaleEvaluations()).has(project.id)).toBe(false);
    expect(await runRescore(project.id, randomUUID())).toEqual({ judged: 0, demoted: 0, promoted: 0, unchanged: 0 });

    const answering = await comment(post.id);
    expect((await projectsWithStaleEvaluations()).has(project.id)).toBe(true);
    answers({});
    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome.judged).toBe(1);
    expect((await leadsOf(project.id)).map((row) => row.commentId)).toEqual([answering.id]);
    const stored = await db()
      .select()
      .from(schema.leadEvaluations)
      .where(eq(schema.leadEvaluations.projectId, project.id));
    const versionOf = (id: string) => stored.find((row) => row.commentId === id)?.scorerVersion;
    expect(versionOf(nested.id)).toBe("2026-01-01.0");
    expect(versionOf(unknown.id)).toBe("2026-01-01.0");
    expect(versionOf(answering.id)).toBe(SCORER_VERSION);
  });

  it("judges nothing when every verdict is already current", async () => {
    const { project } = await fixture({ lead: { status: "new" } });
    await db()
      .update(schema.leadEvaluations)
      .set({ scorerVersion: SCORER_VERSION })
      .where(eq(schema.leadEvaluations.projectId, project.id));

    const outcome = await runRescore(project.id, randomUUID());

    expect(outcome).toEqual({ judged: 0, demoted: 0, promoted: 0, unchanged: 0 });
    expect(askJev).not.toHaveBeenCalled();
    expect((await projectsWithStaleEvaluations()).has(project.id)).toBe(false);
  });
});
