import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const sent = vi.fn();
vi.mock("@/lib/alerts/email", () => ({ sendEmail: (mail: unknown) => sent(mail) }));

describe("invite tokens", () => {
  it("names the person it was issued for and refuses an altered one", async () => {
    const { inviteToken, userForToken } = await import("@/lib/alerts/invite");
    const token = inviteToken("user-1");
    expect(userForToken(token)).toBe("user-1");
    expect(userForToken(token.replace("user-1", "user-2"))).toBeNull();
    expect(userForToken(`${token}x`)).toBeNull();
    expect(userForToken("nonsense")).toBeNull();
  });
});

/**
 * Who gets asked, and that nobody is asked twice. Proven against a real
 * database, because the eligibility query is the claim.
 */
describeDb("alert invites", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
    sent.mockReset();
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });

  async function person(opts: { leads: number; alert?: boolean; ageMs?: number; postedDaysAgo?: number }) {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const email = `invite-${randomUUID()}@example.com`;
    const user = await makeUser({ email });
    const project = await makeProject(user.id, {
      name: `Proj ${randomUUID().slice(0, 6)}`,
      createdAt: new Date(Date.now() - (opts.ageMs ?? 3 * 24 * 3600 * 1000)),
    });
    if (opts.leads > 0) {
      const posts = await upsertPosts(
        Array.from({ length: opts.leads }, (_, i) => ({
          id: `p${randomUUID().slice(0, 8)}`,
          subreddit: "saas",
          author: "asker",
          title: `Looking for a tool ${i}`,
          body: "Anyone know one?",
          permalink: `/r/saas/comments/${randomUUID().slice(0, 6)}/x/`,
          createdUtc: Math.floor(Date.now() / 1000) - (opts.postedDaysAgo ?? 0) * 24 * 3600,
        })),
      );
      await db()
        .insert(schema.leads)
        .values(posts.map((post) => ({ projectId: project.id, postId: post.id, score: 80 })));
    }
    if (opts.alert) {
      await db()
        .insert(schema.alerts)
        .values({ projectId: project.id, channel: "email", target: email, cadence: "daily" });
    }
    return { user, project, email };
  }

  it("asks a person with leads and no channel once, and skips everyone else", async () => {
    const { invitees, sendAlertInvites } = await import("@/lib/alerts/invite");
    const asked = await person({ leads: 2 });
    const hasAlert = await person({ leads: 2, alert: true });
    const noLeads = await person({ leads: 0 });
    const tooNew = await person({ leads: 2, ageMs: 60 * 1000 });
    const onlyOld = await person({ leads: 2, postedDaysAgo: 90 });

    const ids = (await invitees(new Date(), 10_000)).map((one) => one.userId);
    expect(ids).toContain(asked.user.id);
    for (const skipped of [hasAlert, noLeads, tooNew, onlyOld]) {
      expect(ids).not.toContain(skipped.user.id);
    }
    const found = (await invitees(new Date(), 10_000)).find((one) => one.userId === asked.user.id);
    expect(found?.leadCount).toBe(2);
    expect(found?.recentCount).toBe(2);

    await sendAlertInvites(new Date(), 10_000);
    const mails = sent.mock.calls.map(([mail]) => mail as { to: string; subject: string; html: string });
    const mine = mails.filter((mail) => mail.to === asked.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe(`2 new Reddit leads for ${asked.project.name}. Get the new ones daily?`);
    expect(mine[0].html).toContain("/alerts/on?t=");
    expect(mine[0].html).toContain("Looking for a tool");
    expect(mine[0].html).toContain(`/app/settings/alerts?project=${asked.project.id}`);

    sent.mockReset();
    await sendAlertInvites(new Date(), 10_000);
    expect(sent.mock.calls.some(([mail]) => (mail as { to: string }).to === asked.email)).toBe(false);
  });

  it("shows the best of the last week, filled from the month, never older", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { sampleLeads } = await import("@/lib/alerts/invite");
    const { project } = await person({ leads: 0 });
    const day = 24 * 3600;
    const cases = [
      { role: "fresh", daysAgo: 2, score: 60 },
      { role: "month", daysAgo: 20, score: 95 },
      { role: "ancient", daysAgo: 200, score: 99 },
    ];
    const posts = await upsertPosts(
      cases.map((one) => ({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "asker",
        title: one.role,
        body: "Anyone know one?",
        permalink: `/r/saas/comments/${randomUUID().slice(0, 6)}/x/`,
        createdUtc: Math.floor(Date.now() / 1000) - one.daysAgo * day,
      })),
    );
    await db()
      .insert(schema.leads)
      .values(posts.map((post, i) => ({ projectId: project.id, postId: post.id, score: cases[i].score })));

    // The week's best is picked first, then the three are listed best first.
    expect((await sampleLeads(project.id)).map((lead) => lead.title)).toEqual(["month", "fresh"]);
  });

  it("shows one lead per thread, the thread's best, and fills from other threads", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertComments, upsertPosts } = await import("@/lib/reddit/store");
    const { sampleLeads } = await import("@/lib/alerts/invite");
    const { project } = await person({ leads: 0 });
    const now = Math.floor(Date.now() / 1000);
    const [busy, other] = await upsertPosts(
      ["busy", "other"].map((title) => ({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "saas",
        author: "asker",
        title,
        body: "Anyone know one?",
        permalink: `/r/saas/comments/${randomUUID().slice(0, 6)}/x/`,
        createdUtc: now - 3600,
      })),
    );
    const replies = await upsertComments(
      busy.id,
      ["first reply", "second reply"].map((body) => ({ id: `c${randomUUID().slice(0, 8)}`, body, createdUtc: now - 60 })),
    );
    await db()
      .insert(schema.leads)
      .values([
        { projectId: project.id, postId: busy.id, commentId: replies[0].id, score: 90 },
        { projectId: project.id, postId: busy.id, commentId: replies[1].id, score: 85 },
        { projectId: project.id, postId: other.id, score: 60 },
      ]);

    const shown = await sampleLeads(project.id);
    expect(shown.map((lead) => [lead.title, lead.score])).toEqual([
      ["busy", 90],
      ["other", 60],
    ]);
  });

  it("turns on a daily email to their own address for every project, once", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { acceptInvite } = await import("@/lib/alerts/invite");
    const { user, project, email } = await person({ leads: 1 });
    const second = await makeProject(user.id, { name: "Second" });

    await acceptInvite(user.id);
    await acceptInvite(user.id);

    for (const projectId of [project.id, second.id]) {
      const rows = await db().select().from(schema.alerts).where(eq(schema.alerts.projectId, projectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: "email", target: email, cadence: "daily" });
    }
  });
});

/**
 * Each pass books the next, so the switch has to stop that too: a pass that
 * finds the invites off must book no successor, or every instance without them
 * wakes hourly to do nothing.
 */
describeDb("the hourly invite pass", () => {
  async function queued() {
    const { db } = await import("@/db");
    const { jobs } = await import("@/db/schema");
    const { and, eq, isNull } = await import("drizzle-orm");
    const waiting = and(eq(jobs.kind, "alert_invites"), isNull(jobs.projectId), isNull(jobs.startedAt));
    return {
      rows: () => db().select().from(jobs).where(waiting),
      clear: () => db().delete(jobs).where(waiting),
    };
  }

  beforeEach(async () => {
    sent.mockReset();
    vi.stubEnv("ALERTS_FROM_EMAIL", "alerts@lurk.so");
    vi.stubEnv("SMTP_URL", "smtp://localhost:25");
    vi.stubEnv("AZURE_EMAIL_CONNECTION_STRING", "");
    await (await queued()).clear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await (await queued()).clear();
  });

  it.each([
    ["ALERT_INVITES is off", { ALERT_INVITES: "false" }],
    ["there is no email service", { ALERT_INVITES: "true", SMTP_URL: "" }],
  ])("books no next pass when %s", async (_, env) => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    const { JOB_HANDLERS } = await import("@/jobs/registry");

    await JOB_HANDLERS.alert_invites({} as never);

    expect(await (await queued()).rows()).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("books exactly one next pass an hour out when invites can go out", async () => {
    vi.stubEnv("ALERT_INVITES", "true");
    const { JOB_HANDLERS } = await import("@/jobs/registry");
    const before = Date.now();

    await JOB_HANDLERS.alert_invites({} as never);

    const rows = await (await queued()).rows();
    expect(rows).toHaveLength(1);
    const hour = 60 * 60 * 1000;
    expect(rows[0].runAt.getTime()).toBeGreaterThanOrEqual(before + hour);
    expect(rows[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + hour);
  });
});
