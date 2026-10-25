import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A comment lead is as old as its comment and lives at its comment. The app's
 * feed reads it that way, and the API and the alerts must agree with the feed.
 */
describeDb("a fresh comment on an old thread", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  it("is listed by the API inside the window and links to the comment", async () => {
    const { db } = await import("@/db");
    const { leads, redditComments, redditPosts, users } = await import("@/db/schema");
    const { listLeads } = await import("@/lib/leads");
    const { getApiLead, listApiLeads } = await import("@/lib/api/leadsRead");
    const { parseLeadQuery } = await import("@/lib/api/leadsQuery");
    const { newLeadsSince } = await import("@/lib/alerts/leads");
    const { eq } = await import("drizzle-orm");

    const id = randomUUID();
    const postUrl = "https://www.reddit.com/r/test/comments/old/";
    const commentUrl = "https://www.reddit.com/r/test/comments/old/comment/new/";
    const commented = new Date();
    const user = await makeUser();
    try {
      const project = await makeProject(user.id, { name: "Audit" });
      await db().insert(redditPosts).values({
        id,
        subreddit: "test",
        title: "Older thread",
        url: postUrl,
        createdAt: new Date(Date.now() - 60 * DAY_MS),
      });
      await db().insert(redditComments).values({
        id,
        postId: id,
        body: "New buyer asking today",
        author: "buyer",
        permalink: commentUrl,
        createdAt: commented,
      });
      const [lead] = await db()
        .insert(leads)
        .values({ projectId: project.id, postId: id, commentId: id, score: 90 })
        .returning();

      expect(await listLeads(project.id, { status: "new", days: 30 })).toHaveLength(1);
      const listed = await listApiLeads(project.id, parseLeadQuery(new URLSearchParams()), 30);
      expect(listed.leads.map((one) => one.url)).toEqual([commentUrl]);
      expect((await getApiLead(user.id, lead.id))?.url).toBe(commentUrl);
      // The shape callers parse: a list read leaves the body key out entirely,
      // and asking for bodies, or for the one lead, adds only the comment's.
      expect(Object.keys(listed.leads[0])).toEqual([
        "id",
        "postId",
        "commentId",
        "title",
        "subreddit",
        "author",
        "url",
        "score",
        "stage",
        "reason",
        "matchedPhrase",
        "sellerSide",
        "status",
        "postedAt",
        "scoredAt",
        "costUsd",
      ]);
      expect(listed.leads[0]).toMatchObject({ author: "buyer", postedAt: commented.toISOString() });
      const withBodies = await listApiLeads(project.id, parseLeadQuery(new URLSearchParams("include=body")), 30);
      expect(withBodies.leads).toEqual([{ ...listed.leads[0], body: "New buyer asking today" }]);
      expect(await getApiLead(user.id, lead.id)).toEqual(withBodies.leads[0]);
      expect(await getApiLead(randomUUID(), lead.id)).toBeNull();
      const alerted = await newLeadsSince(project.id, new Date(Date.now() - DAY_MS));
      expect(alerted.map((one) => one.url)).toEqual([commentUrl]);
    } finally {
      await db().delete(users).where(eq(users.id, user.id));
      await db().delete(redditPosts).where(eq(redditPosts.id, id));
    }
  });
});
