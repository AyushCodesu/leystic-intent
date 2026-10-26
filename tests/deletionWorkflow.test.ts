import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { describeDb, makeProject, makeUser } from "./fixtures/db";
import { __testOnlyRegisterOperatorCredential } from "@/lib/sourcePolicy";
import { REDACTED_AUTHOR, REDACTED_TITLE } from "@/lib/retention";

const POSTS_NOW = new Date("1969-12-31T00:00:00Z");
const LONG_AGO = Math.floor(POSTS_NOW.getTime() / 1000) - 600 * 24 * 3600;

const adminContext = {
  operatorId: "op_deletion_admin",
  role: "system_administrator" as const,
  operatorKey: "secret_admin_token_xyz_12345",
};

function setupAdminCredential() {
  __testOnlyRegisterOperatorCredential({
    credentialId: "cred_op_admin",
    operatorId: adminContext.operatorId,
    role: adminContext.role,
    secret: adminContext.operatorKey,
  });
}

describeDb("enforceable retention and content redaction across references", () => {
  it("scrubs raw provider content, title, and author from expired referenced posts while preserving lead history and recording TTL audit event", async () => {
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
      summary: "Customer switching from Typeform due to price",
      explanation: "Pricing tier exceeded budget",
    });

    await deleteExpiredPosts(POSTS_NOW);

    // 1. Unreferenced expired post is completely deleted
    const unreferencedCheck = await db()
      .select({ id: schema.redditPosts.id })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, expiredUnreferenced.id));
    expect(unreferencedCheck).toHaveLength(0);

    // 2. Referenced expired post retains its row/metadata, but title, author, body, and raw JSON are scrubbed
    const [keptPost] = await db()
      .select({
        id: schema.redditPosts.id,
        title: schema.redditPosts.title,
        author: schema.redditPosts.author,
        body: schema.redditPosts.body,
        raw: schema.redditPosts.raw,
      })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, expiredReferenced.id));
    expect(keptPost).toBeDefined();
    expect(keptPost.title).toBe(REDACTED_TITLE);
    expect(keptPost.author).toBe(REDACTED_AUTHOR);
    expect(keptPost.body).toBeNull();
    expect(keptPost.raw).toBeNull();

    // 3. Expired comment has raw body, raw JSON, and author scrubbed
    const [keptComment] = await db()
      .select({
        id: schema.redditComments.id,
        author: schema.redditComments.author,
        body: schema.redditComments.body,
        raw: schema.redditComments.raw,
      })
      .from(schema.redditComments)
      .where(eq(schema.redditComments.id, comment.id));
    expect(keptComment).toBeDefined();
    expect(keptComment.author).toBe(REDACTED_AUTHOR);
    expect(keptComment.body).toBeNull();
    expect(keptComment.raw).toBeNull();

    // 4. Downstream excerpts, quotes, and derived summaries are scrubbed while preserving business metadata
    const [keptLead] = await db()
      .select({ id: schema.leads.id, score: schema.leads.score, matchedPhrase: schema.leads.matchedPhrase })
      .from(schema.leads)
      .where(eq(schema.leads.id, lead.id));
    expect(keptLead.score).toBe(85);
    expect(keptLead.matchedPhrase).toBeNull();

    const [keptEval] = await db()
      .select({ evidenceQuote: schema.leadEvaluations.evidenceQuote, decision: schema.leadEvaluations.decision })
      .from(schema.leadEvaluations)
      .where(eq(schema.leadEvaluations.postId, expiredReferenced.id));
    expect(keptEval.evidenceQuote).toBeNull();
    expect(keptEval.decision).toBe("lead");

    const [keptMention] = await db()
      .select({
        competitor: schema.competitorMentions.competitor,
        quote: schema.competitorMentions.quote,
        switchingEvidence: schema.competitorMentions.switchingEvidence,
        summary: schema.competitorMentions.summary,
        explanation: schema.competitorMentions.explanation,
      })
      .from(schema.competitorMentions)
      .where(eq(schema.competitorMentions.postId, expiredReferenced.id));
    expect(keptMention.competitor).toBe("Typeform");
    expect(keptMention.quote).toBeNull();
    expect(keptMention.switchingEvidence).toBeNull();
    expect(keptMention.summary).toBeNull();
    expect(keptMention.explanation).toBeNull();

    const [keptReading] = await db()
      .select({ quote: schema.postReadings.quote, relationship: schema.postReadings.relationship })
      .from(schema.postReadings)
      .where(eq(schema.postReadings.postId, expiredReferenced.id));
    expect(keptReading.quote).toBeNull();
    expect(keptReading.relationship).toBe("buyer");

    // 5. Fresh post retains its full title and body intact
    const [keptFresh] = await db()
      .select({ id: schema.redditPosts.id, title: schema.redditPosts.title, body: schema.redditPosts.body })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, freshPost.id));
    expect(keptFresh.title).toBe("Fresh post");
    expect(keptFresh.body).toBe("Fresh post body");

    // 6. Routine TTL execution wrote an audit record to deletion_audit_log
    const auditRows = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(eq(schema.deletionAuditLog.action, "TTL_BATCH_CLEANUP"));
    expect(auditRows.length).toBeGreaterThan(0);
    const ttlAudit = auditRows[auditRows.length - 1];
    expect(ttlAudit.actor).toBe("system:routine_ttl");
    expect(ttlAudit.actorRole).toBe("system_service");
    expect(ttlAudit.targetType).toBe("retention_batch");
    expect(ttlAudit.outcome).toBe("SUCCESS");

    await db().delete(schema.projects).where(eq(schema.projects.id, project.id));
    await db().delete(schema.redditPosts).where(inArray(schema.redditPosts.id, [expiredReferenced.id, freshPost.id]));
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("ensures repeated cleanup passes on already-redacted content do not re-redact or crash, and dry-run accurately reports zero", async () => {
    const { deleteExpiredPosts, redactExpiredProviderContent } = await import("@/lib/retention");

    // Dry-run plan on already-cleaned state accurately returns 0
    const dryRunResult = await redactExpiredProviderContent(POSTS_NOW, undefined, { dryRun: true });
    expect(dryRunResult.redactedPosts).toBe(0);
    expect(dryRunResult.redactedComments).toBe(0);

    // Repeated execution is idempotent and safely returns 0 deleted posts
    const repeatedDeleted = await deleteExpiredPosts(POSTS_NOW);
    expect(repeatedDeleted).toBe(0);
  });

  it("preserves an expired post container when newer unexpired comments exist, redacting post body while keeping the fresh comment", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { deleteExpiredPosts } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const [oldPostWithNewComment] = await upsertPosts([
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "oldAuthor",
        title: "Old post with fresh discussion",
        body: "Old body that must be redacted",
        permalink: "/r/saas/comments/thread_new_comment/",
        createdUtc: LONG_AGO,
      },
    ]);

    // Insert an unexpired comment (created 2 days before POSTS_NOW, well within 30-day window)
    const freshCommentCreated = new Date(POSTS_NOW.getTime() - 2 * 24 * 3600 * 1000);
    const [freshComment] = await db()
      .insert(schema.redditComments)
      .values({
        id: `c${randomUUID().slice(0, 8)}`,
        postId: oldPostWithNewComment.id,
        author: "freshCommenter",
        body: "I am a fresh comment on an old thread",
        createdAt: freshCommentCreated,
      })
      .returning();

    await deleteExpiredPosts(POSTS_NOW);

    // Post row is NOT dropped because it holds an unexpired comment
    const [postCheck] = await db()
      .select({
        id: schema.redditPosts.id,
        title: schema.redditPosts.title,
        body: schema.redditPosts.body,
        author: schema.redditPosts.author,
      })
      .from(schema.redditPosts)
      .where(eq(schema.redditPosts.id, oldPostWithNewComment.id));
    expect(postCheck).toBeDefined();
    expect(postCheck.title).toBe(REDACTED_TITLE);
    expect(postCheck.body).toBeNull();
    expect(postCheck.author).toBe(REDACTED_AUTHOR);

    // The newer comment remains intact and unredacted
    const [commentCheck] = await db()
      .select({
        id: schema.redditComments.id,
        body: schema.redditComments.body,
        author: schema.redditComments.author,
      })
      .from(schema.redditComments)
      .where(eq(schema.redditComments.id, freshComment.id));
    expect(commentCheck).toBeDefined();
    expect(commentCheck.body).toBe("I am a fresh comment on an old thread");
    expect(commentCheck.author).toBe("freshCommenter");

    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, oldPostWithNewComment.id));
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
      { username: authorOrphan, karma: 100, fetchedAt: new Date(LONG_AGO * 1000) },
      { username: authorActive, karma: 200, raw: { bio: "active" }, fetchedAt: new Date(LONG_AGO * 1000) },
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

  it("rejects privileged operator-only destructive operations when OperatorContext is missing or unauthorized", async () => {
    const { deleteRedditPost, eraseRedditAuthor } = await import("@/lib/retention");
    const { deleteXPost, eraseXAuthor } = await import("@/lib/x/retention");

    // Missing operatorContext throws OperatorApprovalRequiredError
    await expect(deleteRedditPost("p_fake", {} as never)).rejects.toThrow(
      /Destructive operation 'delete_reddit_post' requires explicit operator approval confirmation/,
    );
    await expect(eraseRedditAuthor("u_fake", {} as never)).rejects.toThrow(
      /Destructive operation 'erase_reddit_author' requires explicit operator approval confirmation/,
    );
    await expect(deleteXPost("tweet_fake", {} as never)).rejects.toThrow(
      /Destructive operation 'delete_x_post' requires explicit operator approval confirmation/,
    );
    await expect(eraseXAuthor("x_fake", {} as never)).rejects.toThrow(
      /Destructive operation 'erase_x_author' requires explicit operator approval confirmation/,
    );
  });

  it("executes targeted post deletion with cascade and author pruning when authorized by operator, and records append-only audit event", async () => {
    setupAdminCredential();
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

    const dryResult = await deleteRedditPost(post.id, { operatorContext: adminContext, dryRun: true });
    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.deleted).toBe(false);

    const realResult = await deleteRedditPost(post.id, { operatorContext: adminContext });
    expect(realResult.deleted).toBe(true);

    const postCheck = await db().select().from(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
    expect(postCheck).toHaveLength(0);

    const leadCheck = await db().select().from(schema.leads).where(eq(schema.leads.postId, post.id));
    expect(leadCheck).toHaveLength(0);

    const authorCheck = await db().select().from(schema.redditAuthors).where(eq(schema.redditAuthors.username, authorName));
    expect(authorCheck).toHaveLength(0);

    // Verify append-only audit record exists without deleted post text
    const [auditEntry] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(eq(schema.deletionAuditLog.targetId, post.id));
    expect(auditEntry).toBeDefined();
    expect(auditEntry.action).toBe("DELETE_REDDIT_POST");
    expect(auditEntry.actor).toBe(adminContext.operatorId);
    expect(auditEntry.actorRole).toBe(adminContext.role);
    expect(auditEntry.targetType).toBe("reddit_post");
    expect(auditEntry.outcome).toBe("SUCCESS");
    expect(JSON.stringify(auditEntry.details)).not.toContain("Body to delete");

    const repeatResult = await deleteRedditPost(post.id, { operatorContext: adminContext });
    expect(repeatResult.deleted).toBe(false);
    expect(repeatResult.notFound).toBe(true);

    await db().delete(schema.projects).where(eq(schema.projects.id, project.id));
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("erases an author by anonymizing posts and comments and deleting author profile when authorized, and records audit event", async () => {
    setupAdminCredential();
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { eraseRedditAuthor } = await import("@/lib/retention");
    const { and, desc, eq } = await import("drizzle-orm");

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

    const eraseResult = await eraseRedditAuthor(authorName, { operatorContext: adminContext });
    expect(eraseResult.erased).toBe(true);

    const [updatedPost] = await db().select().from(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
    expect(updatedPost.author).toBe("[deleted]");

    const [updatedComment] = await db().select().from(schema.redditComments).where(eq(schema.redditComments.id, comment.id));
    expect(updatedComment.author).toBe("[deleted]");

    const authorCheck = await db().select().from(schema.redditAuthors).where(eq(schema.redditAuthors.username, authorName));
    expect(authorCheck).toHaveLength(0);

    // Verify append-only audit record exists with opaque non-identifying reference and no username
    const [auditEntry] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "ERASE_REDDIT_AUTHOR"), eq(schema.deletionAuditLog.actor, adminContext.operatorId)))
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);
    expect(auditEntry).toBeDefined();
    expect(auditEntry.action).toBe("ERASE_REDDIT_AUTHOR");
    expect(auditEntry.actor).toBe(adminContext.operatorId);
    expect(auditEntry.outcome).toBe("SUCCESS");
    expect(auditEntry.targetId).toMatch(/^anon-author-[a-f0-9-]+$/);
    expect(auditEntry.targetId).not.toContain(authorName.toLowerCase());
    expect(JSON.stringify(auditEntry)).not.toContain(authorName);
    expect(JSON.stringify(auditEntry)).not.toContain(authorName.toLowerCase());

    const repeatResult = await eraseRedditAuthor(authorName, { operatorContext: adminContext });
    expect(repeatResult.erased).toBe(false);
    expect(repeatResult.notFound).toBe(true);

    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, post.id));
  });

  it("executes targeted X post and X author deletion when authorized, recording audit events without text", async () => {
    setupAdminCredential();
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteXPost, eraseXAuthor } = await import("@/lib/x/retention");
    const { and, desc, eq } = await import("drizzle-orm");

    const tweetId = `tweet_${randomUUID().slice(0, 8)}`;
    const xAuthorUser = `x_author_${randomUUID().slice(0, 6)}`;

    await db().insert(schema.xPosts).values({
      id: tweetId,
      text: "Sensitive confidential tweet message",
      authorUsername: xAuthorUser,
      createdAt: new Date(),
    });

    await db().insert(schema.xAuthors).values({
      username: xAuthorUser,
      name: "X User Name",
      bio: "Confidential Bio",
    });

    const tweetDel = await deleteXPost(tweetId, { operatorContext: adminContext });
    expect(tweetDel.deleted).toBe(true);

    const postCheck = await db().select().from(schema.xPosts).where(eq(schema.xPosts.id, tweetId));
    expect(postCheck).toHaveLength(0);

    const authorDel = await eraseXAuthor(xAuthorUser, { operatorContext: adminContext });
    expect(authorDel.erased).toBe(true);

    const authorCheck = await db().select().from(schema.xAuthors).where(eq(schema.xAuthors.username, xAuthorUser));
    expect(authorCheck).toHaveLength(0);

    // Verify audit logs record actions without retaining tweet text or author bio
    const [tweetAudit] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(eq(schema.deletionAuditLog.targetId, tweetId));
    expect(tweetAudit).toBeDefined();
    expect(tweetAudit.action).toBe("DELETE_X_POST");
    expect(JSON.stringify(tweetAudit)).not.toContain("Sensitive confidential tweet message");

    const [authorAudit] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "ERASE_X_AUTHOR"), eq(schema.deletionAuditLog.actor, adminContext.operatorId)))
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);
    expect(authorAudit).toBeDefined();
    expect(authorAudit.action).toBe("ERASE_X_AUTHOR");
    expect(authorAudit.targetId).toMatch(/^anon-author-[a-f0-9-]+$/);
    expect(authorAudit.targetId).not.toContain(xAuthorUser.toLowerCase());
    expect(JSON.stringify(authorAudit)).not.toContain("Confidential Bio");
    expect(JSON.stringify(authorAudit)).not.toContain(xAuthorUser);
    expect(JSON.stringify(authorAudit)).not.toContain(xAuthorUser.toLowerCase());
  });

  it("deletes a project cleanly while isolating multi-tenant shared records and recording deletion audit log", async () => {
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

    // Verify deletionAuditLog has an entry for project1
    const [projectAudit] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(eq(schema.deletionAuditLog.targetId, project1.id));
    expect(projectAudit).toBeDefined();
    expect(projectAudit.action).toBe("DELETE_PROJECT");
    expect(projectAudit.actor).toBe(user1.id);
    expect(projectAudit.actorRole).toBe("project_owner");
    expect(projectAudit.outcome).toBe("SUCCESS");

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

  it("strictly enforces database-level immutability on deletion_audit_log (rejects UPDATE, DELETE, TRUNCATE; permits INSERT)", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { sql } = await import("drizzle-orm");

    const testRowId = `immut_test_${randomUUID().slice(0, 8)}`;
    // 1. Normal INSERT succeeds
    await db().insert(schema.deletionAuditLog).values({
      id: testRowId,
      action: "TEST_ACTION",
      actor: "test_actor",
      actorRole: "system_service",
      targetType: "test_target",
      targetId: "test_id",
      outcome: "SUCCESS",
      reasonCode: "TEST",
    });

    // 2. Prohibit UPDATE (row-level trigger fires when row exists)
    try {
      await db().execute(sql`UPDATE "deletion_audit_log" SET "outcome" = 'MUTATED' WHERE "id" = ${testRowId};`);
      expect.fail("Expected UPDATE on deletion_audit_log to be prohibited");
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
      expect(msg).toContain("append-only audit ledger: UPDATE and DELETE operations are prohibited");
    }

    // 3. Prohibit DELETE (row-level trigger fires when row exists)
    try {
      await db().execute(sql`DELETE FROM "deletion_audit_log" WHERE "id" = ${testRowId};`);
      expect.fail("Expected DELETE on deletion_audit_log to be prohibited");
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
      expect(msg).toContain("append-only audit ledger: UPDATE and DELETE operations are prohibited");
    }

    // 4. Prohibit TRUNCATE (statement-level trigger)
    try {
      await db().execute(sql`TRUNCATE TABLE "deletion_audit_log";`);
      expect.fail("Expected TRUNCATE on deletion_audit_log to be prohibited");
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
      expect(msg).toMatch(/TRUNCATE is prohibited|permission denied/);
    }
  });

  it("ensures all author erasure audit rows in deletion_audit_log have opaque target IDs and no usernames", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");

    const authorErasureAudits = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(inArray(schema.deletionAuditLog.action, ["ERASE_REDDIT_AUTHOR", "ERASE_X_AUTHOR"]));

    for (const audit of authorErasureAudits) {
      expect(audit.targetId).toMatch(/^anon-author-/);
      if (audit.details) {
        expect(audit.details).not.toHaveProperty("username");
        expect(audit.details).not.toHaveProperty("author");
      }
    }
  });

  it("clears profile attributes (avatarUrl, karma, accountCreatedAt, raw) from stale referenced Reddit authors without dropping the row", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { pruneOrphanedAuthors } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const staleAuthorName = `stale_ref_${randomUUID().slice(0, 6)}`;
    await db().insert(schema.redditAuthors).values({
      username: staleAuthorName,
      avatarUrl: "https://reddit.com/avatar.png",
      karma: 420,
      accountCreatedAt: new Date("2020-01-01T00:00:00Z"),
      raw: { bio: "Sensitive profile bio", notes: "VIP" },
      fetchedAt: new Date(LONG_AGO * 1000), // >30 days old
    });

    // Reference this author with an ACTIVE post
    const [activePost] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: staleAuthorName,
        title: "Active recent post",
        url: "https://reddit.com/r/saas/comments/active_author/",
        createdAt: new Date(),
      })
      .returning();

    // Run author pruning
    await pruneOrphanedAuthors(POSTS_NOW);

    // Stale author row MUST remain (because active post references it)
    const [retainedAuthor] = await db()
      .select()
      .from(schema.redditAuthors)
      .where(eq(schema.redditAuthors.username, staleAuthorName));

    expect(retainedAuthor).toBeDefined();
    // BUT all personal profile attributes MUST be scrubbed to null!
    expect(retainedAuthor.avatarUrl).toBeNull();
    expect(retainedAuthor.karma).toBeNull();
    expect(retainedAuthor.accountCreatedAt).toBeNull();
    expect(retainedAuthor.raw).toBeNull();

    // Now delete the active post so author becomes orphaned
    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, activePost.id));

    // Re-run pruning
    await pruneOrphanedAuthors(POSTS_NOW);

    // Author row must now be completely deleted
    const checkDeleted = await db()
      .select()
      .from(schema.redditAuthors)
      .where(eq(schema.redditAuthors.username, staleAuthorName));
    expect(checkDeleted).toHaveLength(0);
  });

  it("preserves comment-level competitor evidence when parent post expires, until comment itself expires", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { redactExpiredProviderContent } = await import("@/lib/retention");
    const { eq } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "CompetitorRetention" });

    const oldDate = new Date("1968-01-01T00:00:00Z"); // >30 days before POSTS_NOW
    const recentDate = new Date("1969-12-25T00:00:00Z"); // <30 days before POSTS_NOW (recent!)

    // Expired parent post
    const [parentPost] = await db()
      .insert(schema.redditPosts)
      .values({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "author_old",
        title: "Old parent post title",
        body: "Old post body",
        url: "https://reddit.com/r/saas/comments/old_parent/",
        createdAt: oldDate,
      })
      .returning();

    // Recent comment on the old post
    const [recentComment] = await db()
      .insert(schema.redditComments)
      .values({
        id: `c${randomUUID().slice(0, 8)}`,
        postId: parentPost.id,
        author: "author_recent",
        body: "Recent comment body discussing competitor",
        createdAt: recentDate,
      })
      .returning();

    // Post-level competitor mention (should be redacted when parent post expires)
    const [postMention] = await db()
      .insert(schema.competitorMentions)
      .values({
        projectId: project.id,
        competitor: "OldCompetitor",
        postId: parentPost.id,
        commentId: null,
        quote: "Parent post competitor quote",
        summary: "Parent post summary",
        switchingEvidence: "Parent switching",
        explanation: "Parent explanation",
      })
      .returning();

    // Comment-level competitor mention (should be PRESERVED because comment is recent!)
    const [commentMention] = await db()
      .insert(schema.competitorMentions)
      .values({
        projectId: project.id,
        competitor: "RecentCompetitor",
        postId: parentPost.id,
        commentId: recentComment.id,
        quote: "Recent comment competitor quote",
        summary: "Recent comment summary",
        switchingEvidence: "Recent switching",
        explanation: "Recent explanation",
      })
      .returning();

    // Run redaction as of POSTS_NOW
    await redactExpiredProviderContent(POSTS_NOW);

    // 1. Post-level mention quote & summaries are redacted
    const [postMentionAfter] = await db()
      .select()
      .from(schema.competitorMentions)
      .where(eq(schema.competitorMentions.id, postMention.id));
    expect(postMentionAfter.quote).toBeNull();
    expect(postMentionAfter.summary).toBeNull();
    expect(postMentionAfter.switchingEvidence).toBeNull();
    expect(postMentionAfter.explanation).toBeNull();

    // 2. Comment-level mention quote & summaries are PRESERVED!
    const [commentMentionAfter] = await db()
      .select()
      .from(schema.competitorMentions)
      .where(eq(schema.competitorMentions.id, commentMention.id));
    expect(commentMentionAfter.quote).toBe("Recent comment competitor quote");
    expect(commentMentionAfter.summary).toBe("Recent comment summary");
    expect(commentMentionAfter.switchingEvidence).toBe("Recent switching");
    expect(commentMentionAfter.explanation).toBe("Recent explanation");

    // 3. Now advance clock past comment's 30-day retention cutoff (e.g. 60 days after recentDate)
    const futureDate = new Date(recentDate.getTime() + 60 * 24 * 3600 * 1000);
    await redactExpiredProviderContent(futureDate);

    // 4. Comment-level mention quote & summaries are now redacted!
    const [commentMentionExpired] = await db()
      .select()
      .from(schema.competitorMentions)
      .where(eq(schema.competitorMentions.id, commentMention.id));
    expect(commentMentionExpired.quote).toBeNull();
    expect(commentMentionExpired.summary).toBeNull();
    expect(commentMentionExpired.switchingEvidence).toBeNull();
    expect(commentMentionExpired.explanation).toBeNull();

    await db().delete(schema.competitorMentions).where(eq(schema.competitorMentions.id, postMention.id));
    await db().delete(schema.competitorMentions).where(eq(schema.competitorMentions.id, commentMention.id));
    await db().delete(schema.redditComments).where(eq(schema.redditComments.id, recentComment.id));
    await db().delete(schema.redditPosts).where(eq(schema.redditPosts.id, parentPost.id));
    await db().delete(schema.projects).where(eq(schema.projects.id, project.id));
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("records batch audit events for scheduled X retention, including zero-deletion and failed runs", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteExpiredXData } = await import("@/lib/x/retention");
    const { and, desc, eq } = await import("drizzle-orm");

    const testClock = new Date("2015-06-01T00:00:00Z");

    // 1. Zero-deletion run on empty / fresh DB
    const resultZero = await deleteExpiredXData(testClock);
    expect(resultZero.posts).toBe(0);
    expect(resultZero.authors).toBe(0);

    const [auditZero] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(
        and(
          eq(schema.deletionAuditLog.action, "TTL_BATCH_CLEANUP"),
          eq(schema.deletionAuditLog.targetType, "x_retention_batch"),
          eq(schema.deletionAuditLog.targetId, testClock.toISOString()),
        ),
      )
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(auditZero).toBeDefined();
    expect(auditZero.outcome).toBe("SUCCESS");
    expect(auditZero.reasonCode).toBe("ROUTINE_TTL_EXPIRY");
    expect(auditZero.details).toMatchObject({
      source: "x",
      deletedPosts: 0,
      deletedAuthors: 0,
    });
    // Ensure no handles, tweets, or profile text logged
    expect(JSON.stringify(auditZero)).not.toContain("username");
    expect(JSON.stringify(auditZero)).not.toContain("text");

    // 2. Positive-deletion run
    const oldTime = new Date("2015-01-01T00:00:00Z");
    const tweetId = `xpost_${randomUUID().slice(0, 8)}`;
    const authorName = `xuser_${randomUUID().slice(0, 6)}`;
    await db().insert(schema.xPosts).values({
      id: tweetId,
      text: "Old tweet text",
      authorUsername: authorName,
      createdAt: oldTime,
      fetchedAt: oldTime,
    });
    await db().insert(schema.xAuthors).values({
      username: authorName,
      name: "Old X Name",
      fetchedAt: oldTime,
    });

    const positiveClock = new Date("2015-06-02T00:00:00Z");
    const resultPositive = await deleteExpiredXData(positiveClock);
    expect(resultPositive.posts).toBeGreaterThanOrEqual(1);
    expect(resultPositive.authors).toBeGreaterThanOrEqual(1);

    const [auditPositive] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(
        and(
          eq(schema.deletionAuditLog.action, "TTL_BATCH_CLEANUP"),
          eq(schema.deletionAuditLog.targetType, "x_retention_batch"),
          eq(schema.deletionAuditLog.targetId, positiveClock.toISOString()),
        ),
      )
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(auditPositive).toBeDefined();
    expect(auditPositive.outcome).toBe("SUCCESS");
    expect(auditPositive.details).toMatchObject({
      source: "x",
    });
    expect(Number((auditPositive.details as Record<string, unknown>).deletedPosts)).toBeGreaterThanOrEqual(1);
    expect(Number((auditPositive.details as Record<string, unknown>).deletedAuthors)).toBeGreaterThanOrEqual(1);
    // Prove tweet text and author handles are absent
    expect(JSON.stringify(auditPositive)).not.toContain("Old tweet text");
    expect(JSON.stringify(auditPositive)).not.toContain(authorName);

    // 3. Failed run handling
    // Force RangeError by passing invalid Date (toISOString throws RangeError)
    const invalidDate = new Date(NaN);
    await expect(deleteExpiredXData(invalidDate)).rejects.toThrow();

    // Verify a FAILURE audit event was recorded representing the failed run
    const [failedAudit] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(
        and(
          eq(schema.deletionAuditLog.action, "TTL_BATCH_CLEANUP"),
          eq(schema.deletionAuditLog.targetType, "x_retention_batch"),
          eq(schema.deletionAuditLog.outcome, "FAILURE"),
        ),
      )
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(failedAudit).toBeDefined();
    expect(failedAudit.outcome).toBe("FAILURE");
    expect(failedAudit.reasonCode).toBe("ROUTINE_TTL_FAILURE");
    expect(failedAudit.details).toMatchObject({
      source: "x",
    });
    expect((failedAudit.details as Record<string, unknown>).failureCategory).toBeDefined();
    expect((failedAudit.details as Record<string, unknown>).errorCode).toBeDefined();
    expect((failedAudit.details as Record<string, unknown>).errorMessage).toBeUndefined();
  });

  it("rejects arbitrary free-form text, usernames, and provider quotes in reasonCode across deletion workflows", async () => {
    setupAdminCredential();
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteRedditPost, eraseRedditAuthor } = await import("@/lib/retention");
    const { deleteXPost, eraseXAuthor } = await import("@/lib/x/retention");
    const { deleteProject } = await import("@/lib/projects");
    const { and, desc, eq } = await import("drizzle-orm");

    const authorName = `leaky_author_${randomUUID().slice(0, 6)}`;
    const postId = `p${randomUUID().slice(0, 8)}`;
    const tweetId = `tweet_${randomUUID().slice(0, 8)}`;
    const xUser = `x_leaker_${randomUUID().slice(0, 6)}`;

    const user = await makeUser();
    const project = await makeProject(user.id);

    await db().insert(schema.redditPosts).values({
      id: postId,
      subreddit: "saas",
      author: authorName,
      title: "Confidential post content",
      url: "https://reddit.com/r/saas/comments/leaky/",
      createdAt: new Date(),
    });
    await db().insert(schema.redditAuthors).values({ username: authorName, karma: 10 });
    await db().insert(schema.xPosts).values({
      id: tweetId,
      text: "Confidential sensitive tweet text",
      authorUsername: xUser,
      createdAt: new Date(),
    });
    await db().insert(schema.xAuthors).values({ username: xUser, name: "Leaky X" });

    // 1. eraseRedditAuthor with malicious/leaky reason
    const leakyReasonAuthor = `User ${authorName} requested immediate removal of quote: 'buy my tool now!'`;
    await eraseRedditAuthor(authorName, {
      operatorContext: adminContext,
      reason: leakyReasonAuthor,
    });

    const [auditAuthor] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "ERASE_REDDIT_AUTHOR"), eq(schema.deletionAuditLog.actor, adminContext.operatorId)))
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(auditAuthor.reasonCode).toBe("AUTHOR_ERASURE_REQUEST");
    expect(auditAuthor.reasonCode).not.toContain(authorName);
    expect(auditAuthor.reasonCode).not.toContain("buy my tool now");
    expect(JSON.stringify(auditAuthor)).not.toContain(authorName);
    expect(JSON.stringify(auditAuthor)).not.toContain("buy my tool now");

    // 2. deleteRedditPost with leaky reason
    const leakyReasonPost = `Deleted because post ${postId} by author ${authorName} contained illegal quote`;
    await deleteRedditPost(postId, {
      operatorContext: adminContext,
      reason: leakyReasonPost,
    });

    const [auditPost] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "DELETE_REDDIT_POST"), eq(schema.deletionAuditLog.targetId, postId)))
      .limit(1);

    expect(auditPost.reasonCode).toBe("OPERATOR_DELETION");
    expect(auditPost.reasonCode).not.toContain(authorName);
    expect(auditPost.reasonCode).not.toContain("illegal quote");
    expect(JSON.stringify(auditPost)).not.toContain(authorName);
    expect(JSON.stringify(auditPost)).not.toContain("illegal quote");

    // 3. eraseXAuthor with leaky reason
    await eraseXAuthor(xUser, {
      operatorContext: adminContext,
      reason: `Remove @${xUser} because bio said 'confidential'`,
    });

    const [auditXAuthor] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "ERASE_X_AUTHOR"), eq(schema.deletionAuditLog.actor, adminContext.operatorId)))
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(auditXAuthor.reasonCode).toBe("AUTHOR_ERASURE_REQUEST");
    expect(auditXAuthor.reasonCode).not.toContain(xUser);
    expect(JSON.stringify(auditXAuthor)).not.toContain(xUser);
    expect(JSON.stringify(auditXAuthor)).not.toContain("confidential");

    // 4. deleteXPost with leaky reason
    await deleteXPost(tweetId, {
      operatorContext: adminContext,
      reason: `Takedown tweet ${tweetId} text: 'sensitive confidential'`,
    });

    const [auditXPost] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "DELETE_X_POST"), eq(schema.deletionAuditLog.targetId, tweetId)))
      .limit(1);

    expect(auditXPost.reasonCode).toBe("OPERATOR_DELETION");
    expect(auditXPost.reasonCode).not.toContain("sensitive confidential");
    expect(JSON.stringify(auditXPost)).not.toContain("sensitive confidential");

    // 5. deleteProject with leaky reason
    await deleteProject(user.id, project.id, {
      reason: `Delete project for customer notes: 'private company strategy'`,
    });

    const [auditProject] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(and(eq(schema.deletionAuditLog.action, "DELETE_PROJECT"), eq(schema.deletionAuditLog.targetId, project.id)))
      .limit(1);

    expect(auditProject.reasonCode).toBe("USER_REQUEST");
    expect(auditProject.reasonCode).not.toContain("private company strategy");
    expect(JSON.stringify(auditProject)).not.toContain("private company strategy");

    await db().delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it("prevents simulated cleanup exceptions containing usernames, bios, or provider text from leaking into audit details", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { deleteExpiredXData } = await import("@/lib/x/retention");
    const { and, desc, eq } = await import("drizzle-orm");

    const sensitiveAuthor = `leak_user_${randomUUID().slice(0, 6)}`;
    const sensitiveBio = "SuperSecretPersonalBio123";
    const sensitiveTweet = "ConfidentialTweetPayloadText999";

    // Simulate an error thrown during cleanup that embeds raw PII and provider text
    const leakError = new Error(
      `PostgreSQL fatal error processing author @${sensitiveAuthor} with bio '${sensitiveBio}' and tweet '${sensitiveTweet}'`,
    );
    leakError.name = "DatabaseConnectionError";

    const originalSelect = db().select;
    try {
      db().select = (() => {
        throw leakError;
      }) as never;

      await expect(deleteExpiredXData(new Date())).rejects.toThrow();
    } finally {
      db().select = originalSelect;
    }

    // Verify the failure audit record was written
    const [failedAudit] = await db()
      .select()
      .from(schema.deletionAuditLog)
      .where(
        and(
          eq(schema.deletionAuditLog.action, "TTL_BATCH_CLEANUP"),
          eq(schema.deletionAuditLog.targetType, "x_retention_batch"),
          eq(schema.deletionAuditLog.outcome, "FAILURE"),
        ),
      )
      .orderBy(desc(schema.deletionAuditLog.createdAt))
      .limit(1);

    expect(failedAudit).toBeDefined();
    expect(failedAudit.outcome).toBe("FAILURE");
    expect(failedAudit.reasonCode).toBe("ROUTINE_TTL_FAILURE");
    // Verify allowlisted failure category and error code are set
    expect((failedAudit.details as Record<string, unknown>).failureCategory).toBe("CONNECTION_ERROR");
    expect((failedAudit.details as Record<string, unknown>).errorCode).toBe("ERR_TTL_CONNECTION");

    // ABSOLUTE PRIVACY GUARANTEE: neither username, bio, nor tweet text is stored in audit ledger
    const auditStr = JSON.stringify(failedAudit);
    expect(auditStr).not.toContain(sensitiveAuthor);
    expect(auditStr).not.toContain(sensitiveBio);
    expect(auditStr).not.toContain(sensitiveTweet);
    expect(auditStr).not.toContain("PostgreSQL fatal error");
  });
});
