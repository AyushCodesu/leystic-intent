import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makePost, makeProject, makeUser } from "./fixtures/db";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(() => {
  process.env.APP_URL ??= "http://localhost:3000";
});

describe("the words a mute is stored as", () => {
  it("folds a keyword to lowercase words and a subreddit to its bare name", async () => {
    const { muteValue } = await import("@/lib/mutes");
    expect(muteValue("keyword", "  No-Code  Tools ")).toBe("no code tools");
    expect(muteValue("keyword", "!!!")).toBeNull();
    expect(muteValue("subreddit", "r/SaaS")).toBe("saas");
    expect(muteValue("subreddit", "https://www.reddit.com/r/forhire/")).toBe("forhire");
    expect(muteValue("subreddit", "not a subreddit")).toBeNull();
  });
});

describe("an alert's act links", () => {
  it("round-trips a token and refuses one that was altered", async () => {
    const { actForToken, actToken } = await import("@/lib/alerts/act");
    const replied = { act: "replied", projectId: "p1", platform: "reddit", threadId: "t1" } as const;
    const mute = { act: "mute", projectId: "p1", subreddit: "SaaS" } as const;
    expect(actForToken(actToken(replied))).toEqual(replied);
    expect(actForToken(actToken(mute))).toEqual(mute);
    const token = actToken(replied);
    const forged = Buffer.from("replied\np2\nreddit\nt1").toString("base64url");
    expect(actForToken(`${forged}.${token.split(".")[1]}`)).toBeNull();
    expect(actForToken("nonsense")).toBeNull();
  });

  it("puts Mark replied and the mute in the email, Slack and Discord", async () => {
    const { withActLinks } = await import("@/lib/alerts/act");
    const { renderDigestHtml, renderDigestText } = await import("@/lib/alerts/digest");
    const { discordPayload, genericPayload, slackPayload } = await import("@/lib/alerts/webhooks");
    const leads = withActLinks(
      [
        {
          id: "l1",
          platform: "reddit",
          title: "Need a form builder",
          url: "https://www.reddit.com/r/SaaS/comments/abc/",
          subreddit: "SaaS",
          author: "asker",
          avatarUrl: null,
          score: 80,
          reason: null,
          matchedPhrase: null,
          excerpt: "Looking for one",
          isComment: false,
          threadId: "abc",
          numComments: 3,
          createdAt: new Date(),
        },
      ],
      "project-1",
      "https://lurk.example",
    );
    expect(leads[0].repliedUrl).toMatch(/^https:\/\/lurk\.example\/alerts\/act\?t=/);
    const digest = {
      projectName: "Formcraft",
      generatedAt: new Date(),
      since: new Date(Date.now() - DAY_MS),
      cadence: "daily" as const,
      leads,
      appUrl: "https://lurk.example",
    };
    expect(renderDigestHtml(digest)).toContain("Mark replied");
    expect(renderDigestHtml(digest)).toContain("Mute r/SaaS");
    expect(renderDigestText(digest)).toContain(`Mark replied: ${leads[0].repliedUrl}`);
    expect(JSON.stringify(slackPayload(digest))).toContain(`<${leads[0].repliedUrl}|Mark replied>`);
    expect(JSON.stringify(discordPayload(digest))).toContain(`[Mute r/SaaS](${leads[0].muteUrl})`);
    expect(genericPayload(digest).leads[0].repliedUrl).toBe(leads[0].repliedUrl);
  });
});

describeDb("replied threads and mutes, read from the database", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  async function fixture() {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, { scoreThreshold: 0 });
    async function post(subreddit: string, title: string, body: string | null = null) {
      const id = `p${randomUUID().slice(0, 8)}`;
      await makePost({
        id,
        subreddit,
        title,
        body,
        url: `https://www.reddit.com/r/${subreddit}/comments/${id}/`,
        createdAt: new Date(Date.now() - DAY_MS / 2),
      });
      return id;
    }
    return { db, schema, projectId: project.id, post };
  }

  const since = () => new Date(Date.now() - DAY_MS);

  it("keeps a replied thread out of New and the alerts, the comments found later included", async () => {
    const { db, schema, projectId, post } = await fixture();
    const { markThreadReplied, reopenThread } = await import("@/lib/handled");
    const { newLeadsSince } = await import("@/lib/alerts/leads");
    const { listLeads, newLeadCount } = await import("@/lib/leads");
    const { writeLeads } = await import("@/lib/scan/leads");
    const threadId = await post("SaaS", "Need a form builder");
    const otherId = await post("SaaS", "Anyone tried Typeform?");
    await db().insert(schema.leads).values([
      { projectId, postId: threadId, score: 80 },
      { projectId, postId: otherId, score: 70 },
    ]);

    await markThreadReplied(projectId, "reddit", threadId);
    expect((await newLeadsSince(projectId, since())).map((one) => one.postId)).toEqual([otherId]);
    expect((await listLeads(projectId, { status: "new", days: 30 })).map((one) => one.postId)).toEqual([
      otherId,
    ]);
    expect((await listLeads(projectId, { status: "replied", days: 30 })).map((one) => one.postId)).toEqual([
      threadId,
    ]);
    expect(await newLeadCount(projectId)).toBe(1);

    // A buyer in the replies, found by next week's scan, is the conversation already joined.
    const commentId = `c${randomUUID().slice(0, 8)}`;
    await db().insert(schema.redditComments).values({
      id: commentId,
      postId: threadId,
      body: "Same question here",
      author: "second",
      permalink: `https://www.reddit.com/r/SaaS/comments/${threadId}/c/${commentId}/`,
      createdAt: new Date(),
    });
    await writeLeads([
      {
        projectId,
        postId: threadId,
        commentId,
        kind: "buyer",
        score: 75,
        quality: 0.75,
        fit: 3,
        intent: 3,
        engagement: 1,
        stage: "solution_seeking",
        reason: "asks",
        matchedPhrase: "Same question here",
      },
    ]);
    expect((await newLeadsSince(projectId, since())).map((one) => one.postId)).toEqual([otherId]);

    await reopenThread(projectId, "reddit", threadId);
    expect((await newLeadsSince(projectId, since())).map((one) => one.postId).sort()).toEqual(
      [threadId, threadId, otherId].sort(),
    );
  });

  it("marks an X conversation replied and takes it back, every lead in it alike", async () => {
    const { db, schema, projectId } = await fixture();
    const { eq } = await import("drizzle-orm");
    const { markThreadReplied, reopenThread } = await import("@/lib/handled");
    const conversation = `9${Date.now()}`;
    const ids = [conversation, `${conversation}1`, `8${Date.now()}`];
    await db()
      .insert(schema.xPosts)
      .values(ids.map((id) => ({ id, text: "any good typeform alternative?", createdAt: new Date(), authorUsername: `a${id.slice(-6)}` })));
    await db()
      .insert(schema.xLeads)
      .values([
        { projectId, tweetId: ids[0], score: 80, authorUsername: "a", conversationId: conversation },
        { projectId, tweetId: ids[1], score: 70, authorUsername: "b", conversationId: conversation },
        { projectId, tweetId: ids[2], score: 60, authorUsername: "c", conversationId: ids[2] },
      ]);
    const statuses = async () =>
      (await db().select().from(schema.xLeads).where(eq(schema.xLeads.projectId, projectId)))
        .sort((a, b) => b.score - a.score)
        .map((lead) => lead.status);

    await markThreadReplied(projectId, "x", conversation);
    expect(await statuses()).toEqual(["replied", "replied", "new"]);
    await reopenThread(projectId, "x", conversation);
    expect(await statuses()).toEqual(["new", "new", "new"]);
    expect(
      await db().select().from(schema.handledThreads).where(eq(schema.handledThreads.projectId, projectId)),
    ).toEqual([]);
  });

  it("mutes a whole word or phrase and a whole subreddit, and unmuting brings them back", async () => {
    const { db, schema, projectId, post } = await fixture();
    const { addMute, listMutes, removeMute } = await import("@/lib/mutes");
    const { newLeadsSince } = await import("@/lib/alerts/leads");
    const { listLeads } = await import("@/lib/leads");
    const hiring = await post("SaaS", "[Hiring] form developer");
    const inBody = await post("SaaS", "Form builder advice", "We are no-code only, any tips?");
    const partial = await post("SaaS", "Rehiring after layoffs, need forms");
    const forHire = await post("forhire", "Need a form built");
    await db()
      .insert(schema.leads)
      .values([hiring, inBody, partial, forHire].map((postId) => ({ projectId, postId, score: 80 })));

    await addMute(projectId, "keyword", "Hiring");
    await addMute(projectId, "keyword", "no code");
    await addMute(projectId, "subreddit", "r/ForHire");
    expect((await newLeadsSince(projectId, since())).map((one) => one.postId)).toEqual([partial]);
    expect((await listLeads(projectId, { status: "new", days: 30 })).map((one) => one.postId)).toEqual([
      partial,
    ]);

    for (const mute of await listMutes(projectId)) {
      await removeMute(projectId, mute.id);
    }
    expect((await newLeadsSince(projectId, since())).map((one) => one.postId).sort()).toEqual(
      [hiring, inBody, partial, forHire].sort(),
    );
  });
});
