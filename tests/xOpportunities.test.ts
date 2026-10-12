import { expect, it } from "vitest";
import { db } from "@/db";
import { handledThreads, leadMutes, llmUsage, xEvaluations, xLeads, xPosts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  listXOpportunities, xEvaluationEntry, xEvaluationReplied, xOpportunityCard, type XFilteredCard, type XOpportunityFeed,
} from "@/lib/x/read";
import { markXEvaluationReplied } from "@/lib/x/write";
import { describeDb, makeProject, makeUser, newId } from "./fixtures/db";

const good = {
  own_need: { type: "noul", noul: 0.95 }, same_kind: { type: "noul", noul: 0.9 },
  intent: { type: "score", score: 3 }, rival_vendor: { type: "noul", noul: 0.05 }, promoting: { type: "noul", noul: 0.05 }, resolved: { type: "noul", noul: 0.05 },
  hard_requirement: { type: "choice", choice: "unknown" },
};

describeDb("the ranked X window", () => {
  async function fixture() {
    const user = await makeUser();
    return makeProject(user.id, { leadFilters: { mustMention: ["recorder"], xMinScore: 80 } });
  }
  async function add(projectId: string, name: string, options: {
    stage?: string; level?: string; ageDays?: number; gone?: boolean; signals?: unknown; text?: string;
    status?: string; leadScore?: number; conversationId?: string; author?: string; reasonCode?: string; kind?: string;
  } = {}) {
    const id = newId("8");
    await db().insert(xPosts).values({ id, text: options.text ?? `${name} recorder`, createdAt: new Date(Date.now() - (options.ageDays ?? 1) * 86_400_000),
      authorUsername: options.author ?? `author${id}`, unavailableAt: options.gone ? new Date() : null, conversationId: options.conversationId });
    await db().insert(xEvaluations).values({ projectId, tweetId: id, stage: options.stage ?? "free_rejected", freeReject: "no_visible_term", score: 65,
      level: options.level ?? "search", reasonCode: options.reasonCode, signals: options.signals === undefined ? good : options.signals, engagement: 3 });
    if (options.status) await db().insert(xLeads).values({ projectId, tweetId: id, status: options.status, kind: options.kind ?? "ask", score: options.leadScore ?? 90,
      authorUsername: options.author ?? `author${id}`, conversationId: options.conversationId ?? id });
    return id;
  }

  it("can surface screened and pending-context requests without promoting, alerting or buying anything", async () => {
    const project = await fixture();
    const screened = await add(project.id, "older strong", { ageDays: 5 });
    const pending = await add(project.id, "pending", { stage: "pending_context", author: "another" });
    await add(project.id, "new seller", { ageDays: 0, signals: { ...good, rival_vendor: { type: "noul", noul: 0.99 } } });
    const feed = await listXOpportunities(project.id, { days: 7, status: "new" });
    expect(feed.items.slice(0, 2).map((x) => xOpportunityCard(x.entry).tweetId)).toEqual([pending, screened]);
    expect(feed.items[0].entry.kind).toBe("held");
    expect(feed.items[1]).toMatchObject({ entry: { kind: "filtered", item: { kind: "screened" } }, checks: ["Check author and context", "Check requirements"] });
    const [stored] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, screened)));
    expect(stored).toMatchObject({ stage: "free_rejected", score: 65 });
    expect(await db().select().from(xLeads).where(eq(xLeads.projectId, project.id))).toHaveLength(0);
    expect(await db().select().from(llmUsage).where(eq(llmUsage.projectId, project.id))).toHaveLength(0);
  });

  it("honours project/date filters, mutes, deletions and handled threads; hidden leads cannot return through evaluations", async () => {
    const project = await fixture();
    const wanted = await add(project.id, "wanted");
    const hidden = await add(project.id, "hidden", { stage: "lead", status: "hidden" });
    await add(project.id, "low legacy score", { stage: "lead", status: "new", leadScore: 70 });
    await add(project.id, "gone", { gone: true });
    await add(project.id, "old", { ageDays: 9 });
    await add(project.id, "missing keyword", { text: "unrelated form request" });
    await add(project.id, "muted", { text: "muteme recorder" });
    await db().insert(leadMutes).values({ projectId: project.id, kind: "keyword", value: "muteme" });
    await add(project.id, "answered sibling", { conversationId: "answered" });
    await db().insert(handledThreads).values({ projectId: project.id, platform: "x", threadId: "answered" });
    const other = await fixture(); await add(other.id, "other project");
    const feed = await listXOpportunities(project.id, { days: 7, status: "new" });
    expect(feed.items.map((x) => xOpportunityCard(x.entry).tweetId)).toEqual([wanted]);
    const history = await listXOpportunities(project.id, { days: 7, status: "hidden" });
    expect(history.items.map((x) => xOpportunityCard(x.entry).tweetId)).toEqual([hidden]);
  });

  it("does not cap by recency or pipeline bucket before ranking", async () => {
    const project = await fixture();
    const strong = await add(project.id, "old strong", { ageDays: 5 });
    const ids = Array.from({ length: 205 }, () => newId("8"));
    await db().insert(xPosts).values(ids.map((id) => ({ id, text: "recorder promotion", createdAt: new Date(), authorUsername: `p${id}` })));
    await db().insert(xEvaluations).values(ids.map((id) => ({ projectId: project.id, tweetId: id, stage: "review", level: "complete",
      signals: { ...good, promoting: { type: "noul", noul: 0.99 } }, engagement: 3 })));
    // Unscored, so last: below the cap, on a day no listed card is from.
    const unlisted = await add(project.id, "unscored", { ageDays: 3, signals: null });
    const feed = await listXOpportunities(project.id, { days: 7, status: "new" });
    expect(feed.items).toHaveLength(200);
    expect(feed.total).toBe(207);
    expect(xOpportunityCard(feed.items[0].entry).tweetId).toBe(strong);
    // The date strip is drawn from the whole ranked window, not the listed 200.
    expect(feed.faces).toHaveLength(207);
    const [evaluation] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, unlisted)));
    expect(feed.items.some((item) => xOpportunityCard(item.entry).tweetId === unlisted)).toBe(false);
    expect(feed.faces.find((face) => face.id === `filtered-${evaluation.id}`)?.at.getTime()).toBeLessThan(Date.now() - 2 * 86_400_000);
  });

  it("ranks the evidence of a post the legacy score merged away, one card per author, unless their lead there was acted on", async () => {
    const project = await fixture();
    const weak = { ...good, own_need: { type: "noul", noul: 0.1 } };
    const lead = await add(project.id, "legacy winner", { stage: "lead", status: "new", author: "dup", conversationId: "c1", signals: weak, ageDays: 0 });
    const merged = await add(project.id, "merged sibling", { stage: "merged", level: "complete", author: "dup", conversationId: "c1", ageDays: 2 });
    let feed = await listXOpportunities(project.id, { days: 7, status: "new" });
    expect(feed.items.map((x) => xOpportunityCard(x.entry).tweetId)).toEqual([merged]);
    expect(feed.items[0].entry.kind).toBe("held");
    expect(feed.total).toBe(1);
    const [evaluation] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, merged)));
    expect((await xEvaluationEntry(project.id, evaluation.id))?.kind).toBe("held");
    // A merged post stays merged: ranking writes nothing.
    expect(evaluation.stage).toBe("merged");
    for (const status of ["hidden", "not_fit", "replied"]) {
      await db().update(xLeads).set({ status }).where(and(eq(xLeads.projectId, project.id), eq(xLeads.tweetId, lead)));
      feed = await listXOpportunities(project.id, { days: 7, status: "new" });
      expect(feed.items).toEqual([]);
    }
  });

  it("marks a ranked post that is not a lead replied by its conversation, without writing a lead", async () => {
    const project = await fixture();
    const screened = await add(project.id, "screened", { conversationId: "c2" });
    const [evaluation] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, screened)));
    expect(await xEvaluationReplied(project.id, evaluation.id)).toBe(false);
    expect(await markXEvaluationReplied(project.id, evaluation.id, true)).toBe(true);
    expect(await db().select({ thread: handledThreads.threadId }).from(handledThreads).where(eq(handledThreads.projectId, project.id))).toEqual([{ thread: "c2" }]);
    expect(await xEvaluationReplied(project.id, evaluation.id)).toBe(true);
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items).toEqual([]);
    expect(await db().select().from(xLeads).where(eq(xLeads.projectId, project.id))).toHaveLength(0);
    await markXEvaluationReplied(project.id, evaluation.id, false);
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items).toHaveLength(1);
    const other = await fixture();
    expect(await markXEvaluationReplied(other.id, evaluation.id, true)).toBe(false);
  });

  it("finds an auto-opened card marked Replied under Replied history, where Not replied returns it to New", async () => {
    const project = await fixture();
    const screened = await add(project.id, "strongest", { conversationId: "c6" });
    await add(project.id, "weaker", { signals: { ...good, own_need: { type: "noul", noul: 0.5 } } });
    const opened = (await listXOpportunities(project.id, { days: 7, status: "new" })).items[0];
    // With no lead= in the URL the pane opens the strongest card: this one, a post with no lead row.
    expect(opened.entry.kind).toBe("filtered");
    const card = xOpportunityCard(opened.entry) as XFilteredCard;
    expect(card.tweetId).toBe(screened);
    await markXEvaluationReplied(project.id, card.evaluationId, true);
    const fresh = await listXOpportunities(project.id, { days: 7, status: "new" });
    expect(fresh.items.map((item) => xOpportunityCard(item.entry).tweetId)).not.toContain(screened);
    const replied = await listXOpportunities(project.id, { days: 7, status: "replied" });
    expect(replied.items.map((item) => xOpportunityCard(item.entry).entryId)).toEqual([card.entryId]);
    expect(replied.total).toBe(1);
    expect(replied.faces.map((face) => face.id)).toEqual([card.entryId]);
    expect(await xEvaluationReplied(project.id, card.evaluationId)).toBe(true);
    // Hidden and Not a fit hold only leads.
    expect((await listXOpportunities(project.id, { days: 7, status: "hidden" })).items).toEqual([]);
    await markXEvaluationReplied(project.id, card.evaluationId, false);
    expect((await listXOpportunities(project.id, { days: 7, status: "replied" })).items).toEqual([]);
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items[0].entry).toEqual(opened.entry);
    expect(await db().select().from(xLeads).where(eq(xLeads.projectId, project.id))).toHaveLength(0);
  });

  it("keeps a replied post with no lead row in History unless History lists its author's lead in that conversation", async () => {
    const project = await fixture();
    // Under the project's ask-score floor, so no list shows this lead.
    await add(project.id, "unlisted lead", { stage: "lead", status: "new", leadScore: 70, author: "bob", conversationId: "c7" });
    const sibling = await add(project.id, "sibling", { stage: "review", level: "complete", author: "Bob", conversationId: "c7" });
    const [evaluation] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, sibling)));
    await markXEvaluationReplied(project.id, evaluation.id, true);
    const replied = await listXOpportunities(project.id, { days: 7, status: "replied" });
    expect(replied.items.map((item) => xOpportunityCard(item.entry).tweetId)).toEqual([sibling]);
    expect(replied.total).toBe(1);
    // A listed lead by the same author there stands for them instead.
    const listed = await add(project.id, "listed lead", { stage: "lead", status: "replied", author: "bob", conversationId: "c7" });
    expect((await listXOpportunities(project.id, { days: 7, status: "replied" })).items.map((item) => xOpportunityCard(item.entry).tweetId)).toEqual([listed]);
  });

  it("counts and dates every History lead, not only the listed 200", async () => {
    const project = await fixture();
    const ids = Array.from({ length: 205 }, () => newId("8"));
    await db().insert(xPosts).values(ids.map((id, index) => ({ id, text: "recorder request", authorUsername: `h${id}`,
      createdAt: new Date(Date.now() - (index < 200 ? 1 : 4) * 86_400_000) })));
    await db().insert(xLeads).values(ids.map((id) => ({ projectId: project.id, tweetId: id, status: "replied", kind: "ask", score: 90, authorUsername: `h${id}`, conversationId: id })));
    const replied = await listXOpportunities(project.id, { days: 7, status: "replied" });
    expect(replied.items).toHaveLength(200);
    expect(replied.total).toBe(205);
    expect(replied.faces).toHaveLength(205);
    expect(replied.faces.filter((face) => face.at.getTime() < Date.now() - 3 * 86_400_000)).toHaveLength(5);
  });

  it("agrees on Replied whether the mark sits under the conversation or the post, for hiding, showing and undoing", async () => {
    const project = await fixture();
    const loose = await add(project.id, "no conversation yet");
    const [evaluation] = await db().select().from(xEvaluations).where(and(eq(xEvaluations.projectId, project.id), eq(xEvaluations.tweetId, loose)));
    await markXEvaluationReplied(project.id, evaluation.id, true);
    // A later fetch fills in the conversation; the mark stays under the post's own id.
    await db().update(xPosts).set({ conversationId: "c5" }).where(eq(xPosts.id, loose));
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items).toEqual([]);
    expect(await xEvaluationReplied(project.id, evaluation.id)).toBe(true);
    await markXEvaluationReplied(project.id, evaluation.id, false);
    expect(await xEvaluationReplied(project.id, evaluation.id)).toBe(false);
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items).toHaveLength(1);
  });

  it("keeps an author's posts out after their lead there was acted on, whatever case X gives the handle in", async () => {
    const project = await fixture();
    await add(project.id, "hidden lead", { stage: "lead", status: "hidden", author: "Alice", conversationId: "c4" });
    await add(project.id, "held sibling", { stage: "review", level: "complete", author: "alice", conversationId: "c4" });
    expect((await listXOpportunities(project.id, { days: 7, status: "new" })).items).toEqual([]);
  });

  it("ranks and lists from one snapshot, so a lead hidden between the two reads is not listed half-changed", async () => {
    const project = await fixture();
    const lead = await add(project.id, "lead", { stage: "lead", status: "new", level: "complete" });
    const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let listing: Promise<XOpportunityFeed> | undefined;
      await other.begin(async (t) => {
        // Only the read of the listed cards joins x_authors, so it waits here
        // after the ranking read has run.
        await t`lock table x_authors in access exclusive mode`;
        const [{ pid }] = await t`select pg_backend_pid() as pid`;
        listing = listXOpportunities(project.id, { days: 7, status: "new" });
        let blocked = false;
        for (let tries = 0; tries < 500 && !blocked; tries += 1) {
          // The listing's own backend: blocked by this lock, after it read handled_threads in its transaction.
          const [{ waiting }] = await t`select count(*)::int as waiting from pg_locks w where w.relation = 'x_authors'::regclass and not w.granted
            and ${pid} = any(pg_blocking_pids(w.pid))
            and exists (select 1 from pg_locks h where h.pid = w.pid and h.granted and h.relation = 'handled_threads'::regclass)`;
          blocked = waiting > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await t`update x_leads set status = 'hidden' where project_id = ${project.id} and tweet_id = ${lead}`;
      });
      const feed = await listing!;
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].entry).toMatchObject({ kind: "lead", lead: { tweetId: lead, status: "new" } });
    } finally {
      await other.end();
    }
  });

  it("uses the persisted final reply verdict, not a raw positive, independently of buyer-only signals", async () => {
    const project = await fixture();
    const signals = { ...good, own_need: null, intent: null, promoting: null, resolved: null,
      founder_would_reply: { type: "noul", noul: 0.98 }, reply: { worth_reply: true } };
    const stored = { stage: "reply", status: "new", kind: "reply", signals };
    const positive = await add(project.id, "checked venue", { ...stored, reasonCode: "worth_reply" });
    const rawOnly = await add(project.id, "raw model positive", stored);
    const failed = await add(project.id, "failed quote check", { ...stored, reasonCode: "worth_reply",
      signals: { ...signals, reply: { worth_reply: true, code: "not_reply_worthy" } } });
    const feed = await listXOpportunities(project.id, { days: 7, status: "new" });
    const cards = new Map(feed.items.map((item) => [xOpportunityCard(item.entry).tweetId, item]));
    expect(cards.get(positive)?.priority).toBeCloseTo(0.5 * 0.98 * 0.9 * 0.95);
    expect(cards.get(positive)?.checks).toEqual(["Check requirements", "Adoption assessment incomplete"]);
    expect(cards.get(rawOnly)?.priority).toBeNull();
    expect(cards.get(failed)?.priority).toBeNull();
    expect(cards.get(failed)?.checks).toContain("Public reply not recommended");
    expect(await db().select().from(llmUsage).where(eq(llmUsage.projectId, project.id))).toHaveLength(0);
  });
});
