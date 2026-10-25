import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { renderDigestHtml, renderDigestText } from "@/lib/alerts/digest";
import { xAskLead } from "@/lib/alerts/leads";
import { payloadFor } from "@/lib/alerts/send";
import { ALERT_SCORE_FLOOR } from "@/lib/leadFilters";
import {
  CADENCE_MS,
  CHAT_LEAD_CAP,
  EMAIL_LEAD_CAP,
  alertable,
  messageLeads,
  type SelectableLead,
} from "@/lib/alerts/select";
import type { ScheduledChannel } from "@/lib/alerts/channels";
import type { Digest, DigestLead } from "@/lib/alerts/types";
import type { xLeads, xPosts } from "@/db/schema";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * X asks reach the user through the alerts they already have: the same
 * digest, email, Slack, Discord and webhook, with each lead saying where it
 * was posted. Reddit's own output is unchanged, which tests/alerts.test.ts
 * keeps proving.
 */

const NOW = new Date(2026, 8, 5, 9, 0, 0);
const SINCE = new Date(2026, 8, 5, 6, 0, 0);
const APP = "https://leads.example.com";

function xPost(overrides: Partial<typeof xPosts.$inferSelect> = {}): typeof xPosts.$inferSelect {
  return {
    id: "1830000000000000001",
    text: "@calendly @someone Is there a Calendly alternative that doesn't cost $12 a seat? Need one for a team of 8.",
    lang: "en",
    createdAt: new Date(2026, 8, 5, 7, 0, 0),
    authorUsername: "Asker_Jo",
    authorName: "Jo",
    authorId: "42",
    authorImage: null,
    authorFollowers: 300,
    authorVerified: false,
    isReply: true,
    inReplyToId: "1829999999999999999",
    conversationId: "1829999999999999990",
    likeCount: 4,
    replyCount: 3,
    retweetCount: 0,
    quoteCount: 0,
    viewCount: 900,
    bookmarkCount: 0,
    mediaCount: 0,
    unavailableAt: null,
    fetchedAt: new Date(2026, 8, 5, 8, 0, 0),
    ...overrides,
  };
}

function xLead(overrides: Partial<typeof xLeads.$inferSelect> = {}): typeof xLeads.$inferSelect {
  return {
    id: "x-lead-1",
    projectId: "p1",
    tweetId: "1830000000000000001",
    kind: "ask",
    moment: null,
    // fit 1, intent 2, engagement 3: a qualified ask, well under Reddit's floor.
    score: 45,
    fit: 1,
    intent: 2,
    engagement: 3,
    reason: "Wants what this product does, in their own words.",
    matchedPhrase: "Is there a Calendly alternative that doesn't cost $12 a seat?",
    authorUsername: "Asker_Jo",
    conversationId: null,
    status: "new",
    notFitReason: null,
    foundAt: new Date(2026, 8, 5, 8, 30, 0),
    scoredAt: new Date(2026, 8, 5, 8, 30, 0),
    ...overrides,
  };
}

function reddit(overrides: Partial<SelectableLead> & { id: string }): SelectableLead {
  return {
    postId: overrides.id,
    platform: "reddit",
    title: "Paying too much for a scraper",
    url: "https://www.reddit.com/r/SaaS/comments/x/",
    subreddit: "SaaS",
    author: "ella_builds",
    avatarUrl: null,
    score: 70,
    reason: "Names the tool and the price.",
    matchedPhrase: "paying too much",
    body: "We are paying too much for a scraper that breaks. What are people switching to?",
    isComment: false,
    numComments: 12,
    createdAt: new Date(2026, 8, 5, 7, 0, 0),
    status: "new",
    kind: "buyer",
    foundAt: new Date(2026, 8, 5, 8, 0, 0),
    ...overrides,
  };
}

function digestOf(leads: DigestLead[], more = 0, morePlatforms?: Digest["morePlatforms"]): Digest {
  return { projectName: "Acme", generatedAt: NOW, since: SINCE, cadence: "daily", leads, more, morePlatforms, appUrl: APP };
}

const mixed = () => messageLeads([reddit({ id: "r1" }), xAskLead(xLead(), xPost())], SINCE, EMAIL_LEAD_CAP).leads;

describe("an X ask as the digest reads it", () => {
  it("is headed by its quote, quotes the post's own words and links the post", () => {
    const row = xAskLead(xLead(), xPost());
    expect(row).toMatchObject({
      id: "x-lead-1",
      platform: "x",
      kind: "buyer",
      status: "new",
      postId: "1829999999999999990",
      title: "Is there a Calendly alternative that doesn't cost $12 a seat?",
      body: "Is there a Calendly alternative that doesn't cost $12 a seat? Need one for a team of 8.",
      url: "https://x.com/Asker_Jo/status/1830000000000000001",
      subreddit: null,
      author: "Asker_Jo",
      avatarUrl: null,
      isComment: false,
      numComments: 3,
      score: 45,
    });
    expect(row.createdAt).toEqual(new Date(2026, 8, 5, 7, 0, 0));
    expect(row.foundAt).toEqual(new Date(2026, 8, 5, 8, 30, 0));
  });

  it("falls back to the post's first sentence, and to the post itself for its conversation", () => {
    const row = xAskLead(
      xLead({ matchedPhrase: null, conversationId: null }),
      xPost({ isReply: false, conversationId: null, text: "Anyone moved off Calendly? It keeps double booking https://t.co/abc" }),
    );
    expect(row.title).toBe("Anyone moved off Calendly?");
    expect(row.postId).toBe("1830000000000000001");
    expect(xAskLead(xLead({ conversationId: "c-lead" }), xPost()).postId).toBe("c-lead");
  });

  it("is sent whatever its score, because the X gates already qualified it", () => {
    const rows = [xAskLead(xLead({ score: 30 }), xPost()), reddit({ id: "weak", score: 30 })];
    expect(ALERT_SCORE_FLOOR).toBeGreaterThan(30);
    expect(alertable(rows, SINCE).map((one) => one.id)).toEqual(["x-lead-1"]);
  });

  it("is still held to the window and to a fresh post, so a first look at a month is never sent", () => {
    const stale = xAskLead(xLead(), xPost({ createdAt: new Date(2026, 7, 6) }));
    const before = xAskLead(xLead({ foundAt: new Date(2026, 8, 5, 5, 0, 0) }), xPost());
    expect(alertable([stale, before], SINCE)).toEqual([]);
  });

  it("is held fresh from one cadence before now too, however long ago the channel last sent", () => {
    const longAgo = new Date(NOW.getTime() - 20 * CADENCE_MS.daily);
    const floor = new Date(NOW.getTime() - CADENCE_MS.daily);
    const weeksOld = new Date(NOW.getTime() - 15 * CADENCE_MS.daily);
    const rows = [
      xAskLead(xLead({ id: "x-old" }), xPost({ createdAt: weeksOld })),
      xAskLead(xLead({ id: "x-new" }), xPost()),
      reddit({ id: "r-old", createdAt: weeksOld }),
    ];
    // Reddit keeps the window alone, so what a quiet channel missed still goes out.
    expect(alertable(rows, longAgo, floor).map((one) => one.id)).toEqual(["r-old", "x-new"]);
    expect(alertable(rows, longAgo).map((one) => one.id)).toEqual(["r-old", "x-new", "x-old"]);
  });

  it("takes turns with Reddit, each ordered by its own score, so a chat message has room for it", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => reddit({ id: `r${index}`, score: 60 - index })),
      xAskLead(xLead({ score: 50 }), xPost()),
      xAskLead(xLead({ id: "x-lead-2", score: 90 }), xPost({ id: "1830000000000000002" })),
    ];
    expect(messageLeads(rows, SINCE, CHAT_LEAD_CAP).leads.map((one) => one.id)).toEqual([
      "r0",
      "x-lead-2",
      "r1",
      "x-lead-1",
      "r2",
    ]);
    expect(alertable(rows, SINCE)).toHaveLength(7);
  });
});

describe("a digest carrying X asks beside Reddit leads", () => {
  it("names each lead the way its platform does in the email", () => {
    const html = renderDigestHtml(digestOf(mixed()));
    expect(html).toContain("u/ella_builds &middot; r/SaaS &middot; 2h &middot; 12 comments");
    expect(html).toContain("@Asker_Jo &middot; X &middot; 2h &middot; 3 replies");
    expect(html).toContain(`src="${APP}/email/reddit.png" width="14" height="14" alt="Reddit"`);
    expect(html).toContain(`src="${APP}/email/x.png" width="14" height="14" alt="X"`);
    expect(html).toContain('title="@Asker_Jo"');
    expect(html).toContain("Is there a Calendly alternative that doesn&#39;t cost $12 a seat?");
    expect(html).toContain("Need one for a team of 8.");
    expect(html).toContain('<a href="https://x.com/Asker_Jo/status/1830000000000000001"');
  });

  it("draws an X author with no picture by initials, never as a Reddit Snoo", () => {
    const html = renderDigestHtml(digestOf(messageLeads([xAskLead(xLead(), xPost())], SINCE, EMAIL_LEAD_CAP).leads));
    expect(html).not.toContain("redditstatic.com");
    expect(html).toContain(">AS</div>");
    const withFace = renderDigestHtml(
      digestOf(messageLeads([xAskLead(xLead(), xPost({ authorImage: "https://pbs.twimg.com/a.jpg" }))], SINCE, EMAIL_LEAD_CAP).leads),
    );
    expect(withFace).toContain('<img src="https://pbs.twimg.com/a.jpg"');
  });

  it("links the X tab beside the feed, and only the X tab when X is all it carries", () => {
    const both = renderDigestHtml(digestOf(mixed()));
    expect(both).toContain(`<a href="${APP}/app/leads" style="color:#636363">Open the feed</a>`);
    expect(both).toContain(`<a href="${APP}/app/x" style="color:#636363">Open X leads</a>`);
    const onlyX = digestOf(messageLeads([xAskLead(xLead(), xPost())], SINCE, EMAIL_LEAD_CAP).leads, 2);
    const html = renderDigestHtml(onlyX);
    expect(html).not.toContain(`${APP}/app/leads`);
    expect(html).toContain(`And 2 more <a href="${APP}/app/x"`);
    const text = renderDigestText(onlyX);
    expect(text).toContain(`${APP}/app/x`);
    expect(text).not.toContain(`${APP}/app/leads`);
  });

  it("links where the leads it left out are, not only where the listed ones are", () => {
    const listed = messageLeads(
      Array.from({ length: EMAIL_LEAD_CAP }, (_, index) => reddit({ id: `r${index}`, score: 90 - index })),
      SINCE,
      EMAIL_LEAD_CAP,
    ).leads;
    const html = renderDigestHtml(digestOf(listed, 6, ["x"]));
    expect(html).toContain(
      `And 6 more <a href="${APP}/app/x" style="color:#181818;text-decoration:underline">in X leads</a>.`,
    );
    expect(html).toContain(`<a href="${APP}/app/leads" style="color:#636363">Open the feed</a>`);
    expect(html).toContain(`<a href="${APP}/app/x" style="color:#636363">Open X leads</a>`);
    const text = renderDigestText(digestOf(listed, 6, ["x"]));
    expect(text).toContain("And 6 more in X leads.");
    expect(text).toContain(`${APP}/app/leads\n\n${APP}/app/x`);

    const both = renderDigestHtml(digestOf(mixed(), 3, ["reddit", "x"]));
    expect(both).toContain(
      `And 3 more <a href="${APP}/app/leads" style="color:#181818;text-decoration:underline">in the feed</a> and <a href="${APP}/app/x"`,
    );
    expect(renderDigestText(digestOf(mixed(), 3, ["reddit", "x"]))).toContain("And 3 more in the feed and in X leads.");
  });

  it("says where each lead is in the plain text", () => {
    const text = renderDigestText(digestOf(mixed()));
    expect(text).toContain("Paying too much for a scraper (r/SaaS, u/ella_builds, 2h)");
    expect(text).toContain("Is there a Calendly alternative that doesn't cost $12 a seat? (X, @Asker_Jo, 2h)");
    expect(text).toContain(`${APP}/app/leads\n\n${APP}/app/x`);
  });

  it("prints no score on an X card, whose score is not on Reddit's scale", () => {
    const html = renderDigestHtml(digestOf(messageLeads([xAskLead(xLead({ score: 45 }), xPost())], SINCE, EMAIL_LEAD_CAP).leads));
    expect(html).not.toContain(">45<");
    expect(html).toContain(`<td valign="top" align="right" width="72" style="padding:16px 16px 16px 0">\n<a href="https://x.com/Asker_Jo/status/1830000000000000001"`);
    const text = renderDigestText(digestOf(mixed()));
    expect(text).toContain("70 - Paying too much for a scraper");
    expect(text).toContain("\n\nIs there a Calendly alternative that doesn't cost $12 a seat? (X, @Asker_Jo, 2h)");
  });

  it("keeps two asks in one conversation on one card, the second set beneath the first", () => {
    const rows = [
      xAskLead(xLead({ score: 70 }), xPost()),
      xAskLead(
        xLead({ id: "x-lead-2", score: 60, matchedPhrase: "Same, what are people using?" }),
        xPost({ id: "1830000000000000002", authorUsername: "second_one", text: "@Asker_Jo Same, what are people using?" }),
      ),
    ];
    const html = renderDigestHtml(digestOf(messageLeads(rows, SINCE, EMAIL_LEAD_CAP).leads));
    // One card: one platform badge on one face.
    expect(html.match(/\/email\/x\.png/g)).toHaveLength(1);
    expect(html).toContain("@Asker_Jo &middot; X");
    expect(html).toContain("@second_one also asked &middot; 2h &middot; <a href=");
    expect(html).toContain("Same, what are people using?");
    expect(html).toContain("https://x.com/second_one/status/1830000000000000002");
  });

  it("gives Slack the platform's words and keeps Reddit's as they were", () => {
    const payload = payloadFor("slack", digestOf(mixed())) as {
      attachments: Array<{ color?: string; fallback?: string; blocks: unknown[] }>;
    };
    const [redditLead, xAsk] = payload.attachments;
    expect(JSON.stringify(redditLead.blocks)).toContain("*Score 70*  ·  r/SaaS  ·  u/ella_builds  ·  2h ago  ·  12 comments");
    expect(redditLead.color).toBe("#e49e22");
    // An ask's score only orders asks, so it says what it is in the score's place, in no score's colour.
    expect(JSON.stringify(xAsk.blocks)).toContain("*X ask*  ·  @Asker_Jo  ·  2h ago  ·  3 replies");
    expect(JSON.stringify(xAsk.blocks)).not.toContain("Score");
    expect(xAsk.color).toBe("#181818");
    expect(xAsk.fallback).toBe("X ask - Is there a Calendly alternative that doesn't cost $12 a seat?");
    expect(JSON.stringify(xAsk.blocks)).toContain(
      "*<https://x.com/Asker_Jo/status/1830000000000000001|Is there a Calendly alternative that doesn't cost $12 a seat?>*\\nIs there a Calendly alternative",
    );
  });

  it("gives Discord an X field and footer in place of the score and subreddit", () => {
    const payload = payloadFor("discord", digestOf(mixed()));
    expect(payload).toMatchObject({
      embeds: [
        {
          author: { name: "u/ella_builds" },
          fields: [{ name: "Score" }, { name: "Subreddit", value: "r/SaaS" }],
          footer: { text: "12 comments" },
        },
        {
          author: { name: "@Asker_Jo" },
          url: "https://x.com/Asker_Jo/status/1830000000000000001",
          color: 0x181818,
          fields: [{ name: "Lead", value: "X ask" }],
          footer: { text: "3 replies" },
        },
        { description: expect.stringContaining("utm_medium=discord") },
      ],
    });
    const noCount = payloadFor("discord", digestOf(messageLeads([xAskLead(xLead(), xPost({ replyCount: null }))], SINCE, EMAIL_LEAD_CAP).leads));
    expect(noCount).toMatchObject({ embeds: [{ footer: { text: "X" } }, {}] });
  });

  it("keeps the generic payload's leads Reddit's, and sends X asks in their own list", () => {
    type Payload = { leads: Array<Record<string, unknown>>; xLeads?: Array<Record<string, unknown>> };
    const { leads, xLeads } = payloadFor("webhook", digestOf(mixed())) as Payload;
    expect(leads).toHaveLength(1);
    expect(leads[0]).not.toHaveProperty("platform");
    expect(leads[0]).toMatchObject({ id: "r1", subreddit: "SaaS", score: 70, numComments: 12 });
    expect(xLeads).toEqual([
      {
        id: "x-lead-1",
        platform: "x",
        title: "Is there a Calendly alternative that doesn't cost $12 a seat?",
        url: "https://x.com/Asker_Jo/status/1830000000000000001",
        author: "Asker_Jo",
        reason: "Wants what this product does, in their own words.",
        matchedPhrase: "Is there a Calendly alternative that doesn't cost $12 a seat?",
        excerpt: "Is there a Calendly alternative that doesn't cost $12 a seat? Need one for a team of 8.",
        numReplies: 3,
        createdAt: new Date(2026, 8, 5, 7, 0, 0).toISOString(),
      },
    ]);
    const redditOnly = payloadFor("webhook", digestOf(messageLeads([reddit({ id: "r1" })], SINCE, EMAIL_LEAD_CAP).leads));
    expect(redditOnly).not.toHaveProperty("xLeads");
    const xOnly = payloadFor("webhook", digestOf(messageLeads([xAskLead(xLead(), xPost())], SINCE, EMAIL_LEAD_CAP).leads)) as Payload;
    expect(xOnly.leads).toEqual([]);
    expect(xOnly.xLeads).toHaveLength(1);
  });
});

/** The query and the switch are the claim, so they are proven against a real database. */
describeDb("reading X asks for a digest", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;
  const saved = { X_LEADS: process.env.X_LEADS };

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("all");
    cleanupAuth = auth.cleanup;
  });
  afterEach(async () => {
    await cleanupAuth?.();
    // Assigning undefined to process.env stores the string "undefined".
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  async function owner() {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, { name: "X alerts" });
    return { db, schema, user, project };
  }

  type Owned = Awaited<ReturnType<typeof owner>>;

  /** A channel as `allChannels` hands it to the digest, with X on for its owner. */
  function channelOf({ user, project }: Owned, overrides: Partial<ScheduledChannel> = {}): ScheduledChannel {
    process.env.X_LEADS = "true";
    return {
      id: randomUUID(),
      projectId: project.id,
      channel: "email",
      target: "you@example.com",
      label: null,
      cadence: "daily",
      lastSentAt: null,
      projectName: project.name,
      userId: user.id,
      ...overrides,
    };
  }

  /** X asks by author, each first found at `foundAt` on a post made at `createdAt`. */
  async function asks({ db, schema, project }: Owned, rows: Array<{ author: string; createdAt: Date; foundAt: Date }>) {
    const ids = rows.map(() => randomUUID().replace(/\D/g, "").slice(0, 18));
    await db()
      .insert(schema.xPosts)
      .values(rows.map((row, index) => ({ id: ids[index], text: "Any Calendly alternative?", authorUsername: row.author, createdAt: row.createdAt })));
    await db()
      .insert(schema.xLeads)
      .values(rows.map((row, index) => ({ projectId: project.id, tweetId: ids[index], score: 60, authorUsername: row.author, foundAt: row.foundAt })));
  }

  /** One Reddit lead by `author`, posted an hour before `foundAt`. */
  async function redditLead({ db, schema, project }: Owned, author: string, foundAt: Date) {
    const { upsertPosts } = await import("@/lib/reddit/store");
    const [post] = await upsertPosts([
      {
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author,
        title: "Looking for a scheduling tool",
        body: "Anyone know one?",
        permalink: `/r/saas/comments/${randomUUID().slice(0, 6)}/x/`,
        createdUtc: Math.floor(foundAt.getTime() / 1000) - 3600,
      },
    ]);
    await db().insert(schema.leads).values({ projectId: project.id, postId: post.id, score: 80, foundAt });
  }

  it("takes new asks only, from posts X still shows, found since the moment", async () => {
    const { db, schema, project } = await owner();
    const { newXLeadsSince } = await import("@/lib/alerts/leads");
    const now = Date.now();
    const id = (n: number) => `7${now}${n}`;
    const at = new Date(now - 2 * 3_600_000);
    const base = { text: "Anyone know a Calendly alternative?", authorUsername: "asker", createdAt: at };
    await db()
      .insert(schema.xPosts)
      .values([
        { ...base, id: id(1), replyCount: 2 },
        { ...base, id: id(2) },
        { ...base, id: id(3) },
        { ...base, id: id(4) },
        { ...base, id: id(5), unavailableAt: new Date() },
      ]);
    const since = new Date(now - 3_600_000);
    const lead = { projectId: project.id, score: 60, authorUsername: "asker" };
    await db()
      .insert(schema.xLeads)
      .values([
        { ...lead, tweetId: id(1), matchedPhrase: "Anyone know a Calendly alternative?" },
        { ...lead, tweetId: id(2), kind: "reply", moment: "has_the_problem" },
        { ...lead, tweetId: id(3), status: "hidden" },
        { ...lead, tweetId: id(4), foundAt: new Date(now - 2 * 3_600_000) },
        { ...lead, tweetId: id(5) },
      ]);

    const rows = await newXLeadsSince(project.id, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: "x",
      kind: "buyer",
      postId: id(1),
      title: "Anyone know a Calendly alternative?",
      url: `https://x.com/asker/status/${id(1)}`,
      numComments: 2,
    });
    expect(rows[0].createdAt).toEqual(at);
  });

  it("keeps a project's asks out of its channels once its owner stops sending X asks", async () => {
    const { db, schema, project } = await owner();
    const { newXLeadsSince } = await import("@/lib/alerts/leads");
    const { eq } = await import("drizzle-orm");
    const now = Date.now();
    const id = `8${now}1`;
    await db().insert(schema.xPosts).values({ id, text: "Anyone know a Calendly alternative?", authorUsername: "asker", createdAt: new Date(now - 3_600_000) });
    await db().insert(schema.xLeads).values({ projectId: project.id, tweetId: id, score: 60, authorUsername: "asker" });
    await db().insert(schema.xProjects).values({ projectId: project.id });
    const since = new Date(now - 2 * 3_600_000);
    expect(await newXLeadsSince(project.id, since)).toHaveLength(1);

    await db().update(schema.xProjects).set({ alerts: false }).where(eq(schema.xProjects.projectId, project.id));
    expect(await newXLeadsSince(project.id, since)).toHaveLength(0);
  });

  it("puts X asks in a channel's digest only while X is on for the project's owner", async () => {
    const { db, schema, user, project } = await owner();
    const { digestFor } = await import("@/jobs/digest");
    const now = new Date();
    const tweet = `6${now.getTime()}1`;
    await db()
      .insert(schema.xPosts)
      .values({ id: tweet, text: "Need a Calendly alternative for my clinic", authorUsername: "clinic", createdAt: new Date(now.getTime() - 3_600_000) });
    await db().insert(schema.xLeads).values({ projectId: project.id, tweetId: tweet, score: 40, authorUsername: "clinic" });
    const channel = {
      id: randomUUID(),
      projectId: project.id,
      channel: "email" as const,
      target: "you@example.com",
      label: null,
      cadence: "daily" as const,
      lastSentAt: null,
      projectName: project.name,
      userId: user.id,
    };
    const later = new Date(now.getTime() + 1000);

    process.env.X_LEADS = "false";
    expect(await digestFor(channel, null, later)).toBeNull();

    process.env.X_LEADS = "true";
    const digest = await digestFor(channel, null, later);
    expect(digest?.leads.map((one) => [one.platform, one.author, one.score])).toEqual([["x", "clinic", 40]]);
  });

  it("knows whether a project has a channel to carry its leads", async () => {
    const { db, schema, user, project } = await owner();
    const { projectHasAlertChannel } = await import("@/lib/alerts/channels");
    const sibling = await makeProject(user.id, { name: "Sibling" });
    await db().insert(schema.alerts).values({ projectId: sibling.id, channel: "email", target: "you@example.com", cadence: "daily" });
    expect(await projectHasAlertChannel(project.id)).toBe(false);
    expect(await projectHasAlertChannel(sibling.id)).toBe(true);
    await db().insert(schema.alerts).values({ projectId: project.id, channel: "slack", target: "https://hooks.slack.com/services/T/B/x", cadence: "hourly" });
    expect(await projectHasAlertChannel(project.id)).toBe(true);
  });

  it("sends none of a first look's weeks-old asks to a channel that last sent weeks ago", async () => {
    const owned = await owner();
    const { digestFor } = await import("@/jobs/digest");
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    // A first look reads a month back and writes every ask it finds as found now.
    await asks(owned, [
      { author: "weeks_ago", createdAt: ago(15 * CADENCE_MS.daily), foundAt: ago(60_000) },
      { author: "this_morning", createdAt: ago(2 * CADENCE_MS.hourly), foundAt: ago(60_000) },
    ]);
    const channel = channelOf(owned, { lastSentAt: ago(20 * CADENCE_MS.daily) });
    const digest = await digestFor(channel, null, now);
    expect(digest?.leads.map((one) => one.author)).toEqual(["this_morning"]);
    expect(digest?.more).toBe(0);
  });

  it("leaves a lead written while the pass runs to the next window, so it goes out once", async () => {
    const owned = await owner();
    const { digestFor } = await import("@/jobs/digest");
    const now = new Date();
    const before = new Date(now.getTime() - 60_000);
    const during = new Date(now.getTime() + 60_000);
    await asks(owned, [
      { author: "before_pass", createdAt: before, foundAt: before },
      { author: "during_pass", createdAt: before, foundAt: during },
    ]);
    await redditLead(owned, "reddit_during", during);
    const channel = channelOf(owned, { channel: "slack", cadence: "hourly" });

    const first = await digestFor(channel, null, now);
    expect(first?.leads.map((one) => one.author)).toEqual(["before_pass"]);
    const next = await digestFor({ ...channel, lastSentAt: now }, null, new Date(now.getTime() + CADENCE_MS.hourly));
    expect(next?.leads.map((one) => one.author)).toEqual(["reddit_during", "during_pass"]);
  });

  it("gives a chat channel's five to both platforms, and tells the email where the rest are", async () => {
    const owned = await owner();
    const { digestFor } = await import("@/jobs/digest");
    const now = new Date();
    const found = new Date(now.getTime() - 60_000);
    await redditLead(owned, "only_redditor", found);
    await asks(
      owned,
      Array.from({ length: 6 }, (_, index) => ({ author: `asker_${index}`, createdAt: found, foundAt: found })),
    );

    const chat = await digestFor(channelOf(owned, { channel: "slack" }), null, now);
    expect(chat?.leads.map((one) => one.platform)).toEqual(["reddit", "x", "x", "x", "x"]);
    expect(chat).toMatchObject({ more: 2, morePlatforms: ["x"] });
    const html = renderDigestHtml(chat!);
    expect(html).toContain(`And 2 more <a href="${chat!.appUrl}/app/x"`);

    const email = await digestFor(channelOf(owned), null, now);
    expect(email).toMatchObject({ more: 0, morePlatforms: undefined });
  });
});
