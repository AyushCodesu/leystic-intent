import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Insights read every new or hidden lead scored in the last 30 days, so it
 * paid the model to group context threads, leads under the project's floor,
 * leads its words keep out and muted ones, and a card counted leads its own
 * link then did not show. It now groups what the feed shows on its New and
 * Hidden tabs, and a card counts what its link opens.
 */
describeDb("the leads Insights groups and counts", () => {
  async function fixture() {
    const user = await makeUser({ clerkUserId: `user_${randomUUID()}` });
    const project = await makeProject(user.id, { leadFilters: { mustMention: ["form"] } });
    await db().insert(schema.leadMutes).values({ projectId: project.id, kind: "subreddit", value: "forhire" });

    async function lead(
      values: Partial<typeof schema.leads.$inferInsert> & { title?: string; subreddit?: string; postedDaysAgo?: number },
    ) {
      const { title = "Need a form builder", subreddit = "SaaS", postedDaysAgo = 1, ...rest } = values;
      const postId = `p${randomUUID().slice(0, 8)}`;
      await db()
        .insert(schema.redditPosts)
        .values({
          id: postId,
          subreddit,
          author: `asker_${postId}`,
          title,
          url: `https://www.reddit.com/r/${subreddit}/comments/${postId}/`,
          createdAt: new Date(Date.now() - postedDaysAgo * DAY_MS),
        });
      const [row] = await db()
        .insert(schema.leads)
        .values({ projectId: project.id, postId, score: 80, matchedPhrase: title, ...rest })
        .returning();
      return row.id;
    }

    const ids = {
      shown: await lead({}),
      hidden: await lead({ status: "hidden" }),
      belowFloor: await lead({ score: 20 }),
      context: await lead({ kind: "context" }),
      muted: await lead({ subreddit: "forhire" }),
      unwanted: await lead({ title: "Need a bookkeeper" }),
      // Judged today by a backfill, but asked two months ago: the feed shows it
      // when its 30 days hold nothing, so it is grouped.
      old: await lead({ postedDaysAgo: 60 }),
    };
    return { projectId: project.id, ids };
  }

  it("groups only the leads the feed shows on its New and Hidden tabs", async () => {
    const { clusterableLeads } = await import("@/lib/insights/themes");
    const { projectId, ids } = await fixture();

    const grouped = await clusterableLeads(projectId);

    expect(grouped.map((one) => one.id).sort()).toEqual([ids.shown, ids.hidden, ids.old].sort());
  });

  it("counts and shows on a card only the leads its link opens", async () => {
    const { listThemes } = await import("@/lib/insights/read");
    const { listLeads } = await import("@/lib/leads");
    const { projectId, ids } = await fixture();
    const [theme] = await db()
      .insert(schema.painThemes)
      .values({ projectId, label: "Form Builders", summary: "Wants one", leadIds: Object.values(ids) })
      .returning();

    const [card] = await listThemes(projectId);
    const linked = await listLeads(projectId, { status: "new", days: 30, theme: theme.id });

    expect(linked.map((one) => one.id)).toEqual([ids.shown]);
    expect(card.count).toBe(1);
    expect(card.faces.map((face) => face.name)).toEqual([linked[0].postAuthor]);
    expect(card.quotes).toEqual(["Need a form builder"]);
    expect(card.communities.map((community) => community.name)).toEqual(["SaaS"]);

    // Triaged after the grouping, it leaves the card as it leaves the feed.
    // With nothing in the 30 days the feed opens on all time, and so does
    // the card; with nothing there either, there is no card.
    await db().update(schema.leads).set({ status: "replied" }).where(eq(schema.leads.id, ids.shown));
    const [fallen] = await listThemes(projectId);
    const allTime = await listLeads(projectId, { status: "new", days: "all", theme: theme.id });
    expect(allTime.map((one) => one.id)).toEqual([ids.old]);
    expect(fallen.count).toBe(1);
    expect(fallen.faces.map((face) => face.name)).toEqual([allTime[0].postAuthor]);

    await db().update(schema.leads).set({ status: "hidden" }).where(eq(schema.leads.id, ids.old));
    expect(await listThemes(projectId)).toEqual([]);
  });
});
