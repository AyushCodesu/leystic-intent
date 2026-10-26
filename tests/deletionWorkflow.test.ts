import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const POSTS_NOW = new Date("1969-12-31T00:00:00Z");
const LONG_AGO = Math.floor(POSTS_NOW.getTime() / 1000) - 600 * 24 * 3600;

describeDb("enforceable retention and content redaction across references", () => {
  it("scrubs raw provider content and excerpts from expired referenced posts while preserving lead history", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { deleteExpiredPosts } = await import("@/lib/retention");
    const { inArray, eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "RetentionScrubbing" });

    const [expiredReferenced, expiredUnreferenced, freshPost] = await upsertPosts([
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "authorA",
        title: "Old post with lead",
        body: "Raw sensitive provider post body",
        permalink: "/r/saas/comments/old1/",
        createdUtc: LONG_AGO,
      },
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "authorB",
        title: "Old post loose",
        body: "Raw body loose",
        permalink: "/r/saas/comments/old2/",
        createdUtc: LONG_AGO,
      },
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "authorC",
        title: "Fresh post",
        body: "Fresh post body",
        permalink: "/r/saas/comments/fresh/",
        createdUtc: Math.floor(POSTS_NOW.getTime() / 1000) - 5 * 24 * 3600,
      },
    ]);

    const [comment] = await db()
      .insert(schema.redditComments)
      .values({
        id: `c${randomUUID().slice(0, 8)}`,
        postId: expiredReferenced.id,
        author: "authorA",
        body: "Raw sensitive comment body",
        createdAt: new Date(LONG_AGO * 1000),
      })
      .returning();

    await db().insert(schema.postReadings).values({
      postId: expiredReferenced.id,
      relationship: "buyer",
      needState: "open",
      quote: "Excerpt of raw need from post",
      contentHash: "hash1",
      readingVersion: "v1",
    });

    const [lead] = await db()
      .insert(schema.leads)
      .values({
        projectId: project.id,
        postId: expiredReferenced.id,
        commentId: comment.id,
        score: 85,
        matchedPhrase: "Need form alternative",
        stage: "evaluating",
        status: "new",
      })
      .returning();

    await db().insert(schema.leadEvaluations).values({
      projectId: project.id,
      postId: expiredReferenced.id,
      commentId: comment.id,
      decision: "lead",
      relationship: "buyer",
      needState: "open",
      score: 85,
      engagement: 3,
      reasonCodes: ["active_need"],
      reason: "Buyer evaluated",
      evidenceQuote: "Raw evidence quote from comment",
      profileVersion: 1,
      contentHash: "hash1",
      scorerVersion: "v1",
    });

    await db().insert(schema.competitorMentions).values({
      projectId: project.id,
      competitor: "Typeform",
      postId: expiredReferenced.id,
      commentId: comment.id,
      quote: "Typeform is too expensive",
      switchingEvidence: "Looking to switch from Typeform",
    });

    await deleteExpiredPosts(POSTS_NOW);

    // 1. Unreferenced expired post is completely deleted
    const unreferencedCheck = await db()
      .select({ id: schema.redditPosts.id })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, expiredUnreferenced.id));
    expect(unreferencedCheck).toHaveLength(0);

    // 2. Referenced expired post retains its row/metadata, but raw body and raw JSON are nulled
    const [keptPost] = await db()
      .select({ id: schema.redditPosts.id, body: schema.redditPosts.body, raw: schema.redditPosts.raw })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, expiredReferenced.id));
    expect(keptPost).toBeDefined();
    expect(keptPost.body).toBeNull();
    expect(keptPost.raw).toBeNull();

    // 3. Expired comment has raw body and raw JSON nulled
    const [keptComment] = await db()
      .select({ id: schema.redditComments.id, body: schema.redditComments.body, raw: schema.redditComments.raw })
      .from(schema.redditComments)
      .where(eq(schema.redditComments.id, comment.id));
    expect(keptComment).toBeDefined();
    expect(keptComment.body).toBeNull();
    expect(keptComment.raw).toBeNull();

    // 4. Downstream excerpts are scrubbed
    const [keptLead] = await db()
      .select({ id: schema.leads.id, score: schema.leads.score, matchedPhrase: schema.leads.matchedPhrase })
      .from(schema.leads)
      .where(eq(schema.leads.id, lead.id));
    expect(keptLead.score).toBe(85);
    expect(keptLead.matchedPhrase).toBeNull();

    const [keptEval] = await db()
      .select({ evidenceQuote: schema.leadEvaluations.evidenceQuote })
      .from(schema.leadEvaluations)
      .where(eq(schema.leadEvaluations.postId, expiredReferenced.id));
    expect(keptEval.evidenceQuote).toBeNull();

    const [keptMention] = await db()
      .select({ quote: schema.competitorMentions.quote, switchingEvidence: schema.competitorMentions.switchingEvidence })
      .from(schema.competitorMentions)
      .where(eq(schema.competitorMentions.postId, expiredReferenced.id));
    expect(keptMention.quote).toBeNull();
    expect(keptMention.switchingEvidence).toBeNull();

    const [keptReading] = await db()
      .select({ quote: schema.postReadings.quote })
      .from(schema.postReadings)
      .where(eq(schema.postReadings.postId, expiredReferenced.id));
    expect(keptReading.quote).toBeNull();

    // 5. Fresh post retains its full body intact
    const [keptFresh] = await db()
      .select({ id: schema.redditPosts.id, body: schema.redditPosts.body })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, freshPost.id));
    expect(keptFresh.body).toBe("Fresh post body");

    await db().delete(schema.projects).where(eq(schema.projects.id, project.id));
    await db().delete(schema.redditPosts).where(inArray(schema.redditPosts.id, [expiredReferenced.id, freshPost.id]));
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });
});

describeDb("targeted deletion and author erasure workflows", () => {
  it("prunes orphaned authors while preserving referenced ones and scrubbing stale raw payloads", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { pruneOrphanedAuthors } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const authorOrphan = `orphan_${randomUUID().slice(0, 6)}`;
    const authorActive = `active_${randomUUID().slice(0, 6)}`;

    await db().insert(schema.redditAuthors).values([
      { username: authorOrphan, karma: 100, fetchedAt: POSTS_NOW },
      { username: authorActive, karma: 200, raw: { bio: "active" }, fetchedAt: POSTS_NOW },
    ]);

    const [post] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: authorActive,
        title: "Post by active",
        url: "https://reddit.com/r/saas/comments/x1/",
        createdAt: new Date(),
      })
      .returning();

    await pruneOrphanedAuthors(POSTS_NOW);

    const checkOrphan = await db()
      .select()
      .from(schema.redditAuthors)
      .where(eq(schema.redditAuthors.username, authorOrphan));
    expect(checkOrphan).toHaveLength(0);

    const [checkActive] = await db()
      .select()
      .from(schema.redditAuthors)
      .where(eq(schema.redditAuthors.username, authorActive));
    expect(checkActive).toBeDefined();
    expect(checkActive.raw).toBeNull();

    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
    await db().delete(schema.redditAuthors).where(eq(schema.redditAuthors.username, authorActive));
  });

  it("executes targeted post deletion with cascade and author pruning, idempotently", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteRedditPost } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "PostTargetDelete" });
    const authorName = `target_author_${randomUUID().slice(0, 6)}`;

    await db().insert(schema.redditAuthors).values({ username: authorName, karma: 50 });

    const [post] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: authorName,
        title: "Targeted delete post",
        body: "Body to delete",
        url: "https://reddit.com/r/saas/comments/del1/",
        createdAt: new Date(),
      })
      .returning();

    await db().insert(schema.leads).values({
      projectId: project.id,
      postId: post.id,
      score: 75,
    });

    const dryResult = await deleteRedditPost(post.id, { dryRun: true });
    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.deleted).toBe(false);

    const realResult = await deleteRedditPost(post.id);
    expect(realResult.deleted).toBe(true);

    const postCheck = await db().select().from(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
    expect(postCheck).toHaveLength(0);

    const leadCheck = await db().select().from(schema.leads).where(eq(schema.leads.postId, post.id));
    expect(leadCheck).toHaveLength(0);

    const authorCheck = await db().select().from(schema.redditAuthors).where(eq(schema.redditAuthors.username, authorName));
    expect(authorCheck).toHaveLength(0);

    const repeatResult = await deleteRedditPost(post.id);
    expect(repeatResult.deleted).toBe(false);
    expect(repeatResult.notFound).toBe(true);

    await db().delete(schema.projects).where(eq(schema.projects.id, project.id));
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("erases an author by anonymizing posts and comments and deleting author profile", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { eraseRedditAuthor } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const authorName = `erase_me_${randomUUID().slice(0, 6)}`;
    await db().insert(schema.redditAuthors).values({ username: authorName, karma: 300 });

    const [post] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: authorName,
        title: "Post with author",
        url: "https://reddit.com/r/saas/comments/erase1/",
        createdAt: new Date(),
      })
      .returning();

    const [comment] = await db()
      .insert(schema.redditComments)
      .values({
        id: `c${randomUUID().slice(0, 8)}`,
        postId: post.id,
        author: authorName,
        body: "Comment by author",
        createdAt: new Date(),
      })
      .returning();

    const eraseResult = await eraseRedditAuthor(authorName);
    expect(eraseResult.erased).toBe(true);

    const [updatedPost] = await db().select().from(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
    expect(updatedPost.author).toBe("[deleted]");

    const [updatedComment] = await db().select().from(schema.redditComments).where(eq(schema.redditComments.id, comment.id));
    expect(updatedComment.author).toBe("[deleted]");

    const authorCheck = await db().select().from(schema.redditAuthors).where(eq(schema.redditAuthors.username, authorName));
    expect(authorCheck).toHaveLength(0);

    const repeatResult = await eraseRedditAuthor(authorName);
    expect(repeatResult.erased).toBe(false);
    expect(repeatResult.notFound).toBe(true);

    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
  });

  it("deletes a project cleanly while isolating multi-tenant shared records", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteProject } = await import("@/lib/projects");
    const { eq, inArray } = await import("drizzle-orm");

    const user1 = await makeUser();
    const user2 = await makeUser();
    const project1 = await makeProject(user1.id, { name: "ProjectOne" });
    const project2 = await makeProject(user2.id, { name: "ProjectTwo" });

    const [sharedPost] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "shared_author",
        title: "Shared post tracked by two projects",
        url: "https://reddit.com/r/saas/comments/shared/",
        createdAt: new Date(),
      })
      .returning();

    const [lead1] = await db()
      .insert(schema.leads)
      .values({ projectId: project1.id, postId: sharedPost.id, score: 90 })
      .returning();
    const [lead2] = await db()
      .insert(schema.leads)
      .values({ projectId: project2.id, postId: sharedPost.id, score: 85 })
      .returning();

    const delResult = await deleteProject(user1.id, project1.id);
    expect(delResult.deleted).toBe(true);

    const p1Check = await db().select().from(schema.projects).where(eq(schema.projects.id, project1.id));
    expect(p1Check).toHaveLength(0);
    const l1Check = await db().select().from(schema.leads).where(eq(schema.leads.id, lead1.id));
    expect(l1Check).toHaveLength(0);

    const p2Check = await db().select().from(schema.projects).where(eq(schema.projects.id, project2.id));
    expect(p2Check).toHaveLength(1);
    const l2Check = await db().select().from(schema.leads).where(eq(schema.leads.id, lead2.id));
    expect(l2Check).toHaveLength(1);

    const postCheck = await db().select().from(schema.redditPosts).where(eq(schema.redditPosts.id, sharedPost.id));
    expect(postCheck).toHaveLength(1);

    const repeatDel = await deleteProject(user1.id, project1.id);
    expect(repeatDel.deleted).toBe(false);
    expect(repeatDel.notFound).toBe(true);

    await deleteProject(user2.id, project2.id);
    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, sharedPost.id));
    await db().delete(schema.users).where(inArray(schema.users.id, [user1.id, user2.id]));
  });

  it("handles project deletion through the API handler with authorization check", async () => {
    const { createApiKey } = await import("@/lib/api/keys");
    const { deleteProjectHandler } = await import("@/lib/api/handlers");
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");

    const owner = await makeUser();
    const otherUser = await makeUser();
    const project = await makeProject(owner.id, { name: "ApiDeleteProject" });
    await createApiKey(owner.id, "OwnerKey");
    await createApiKey(otherUser.id, "OtherKey");

    const ownerCaller = {
      keyId: "k1",
      keyPrefix: "pref1",
      scopes: ["read", "write"] as ("read" | "write")[],
      user: owner,
      tier: "free" as const,
      selfHosted: false,
      limits: null,
    };
    const otherCaller = {
      keyId: "k2",
      keyPrefix: "pref2",
      scopes: ["read", "write"] as ("read" | "write")[],
      user: otherUser,
      tier: "free" as const,
      selfHosted: false,
      limits: null,
    };

    // Other user cannot delete owner's project (404 not_found)
    await expect(deleteProjectHandler(otherCaller, project.id)).rejects.toMatchObject({
      code: "not_found",
    });

    // Owner successfully deletes project
    const res = await deleteProjectHandler(ownerCaller, project.id);
    expect(res).toEqual({ deleted: true, id: project.id });

    // Repeated call throws 404 not_found
    await expect(deleteProjectHandler(ownerCaller, project.id)).rejects.toMatchObject({
      code: "not_found",
    });

    await db().delete(schema.users).where(inArray(schema.users.id, [owner.id, otherUser.id]));
  });
});
