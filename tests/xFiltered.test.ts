import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { filteredPointer, filteredSentence, filteredSummary, filteredWord } from "@/components/x/filtered";
import type { XFiltered, XFilteredCard } from "@/lib/x/read";
import { describeDb, makeProject, makeUser, newId } from "./fixtures/db";

/**
 * What the X tab shows of the posts it left out: those the judge passed but
 * lurk never finished, the judged ones with the gates' reason (close calls
 * first), then what the free screen set aside, with counts over the whole
 * window so the group reads as the work done.
 */

const HOUR = 3_600_000;

describe("the filtered-out words", () => {
  it("names a screened post by its rule, a judged one by the gates' code, and an unfinished one as such", () => {
    expect(filteredWord({ kind: "screened", code: "listicle" })).toBe("list");
    expect(filteredWord({ kind: "screened", code: "something_new" })).toBe("screened");
    expect(filteredWord({ kind: "judged", code: "automated_account" })).toBe("automated");
    expect(filteredWord({ kind: "judged", code: null })).toBe("not a lead");
    expect(filteredWord({ kind: "unfinished", code: "supported_open_need" })).toBe("unfinished");
  });

  it("says a screened post was never read by the judge, and names both ways a search's words can be missing", () => {
    const screened = filteredSentence({ kind: "screened", code: "no_visible_term", reason: null, replyChecked: false, closeCall: false });
    expect(screened).toMatch(/^The words lurk searched for are not together in one sentence the author wrote: X matched it on words sentences apart, or on something the author did not write/u);
    expect(screened).toMatch(/before the judge reads anything\.$/u);
  });

  it("adds the close call and a reply check the model answered to a judged post's reason", () => {
    const judged = filteredSentence({
      kind: "judged",
      code: "automated_account",
      reason: "Looks like an automated account (80% yes).",
      replyChecked: true,
      closeCall: true,
    });
    expect(judged).toBe(
      "Looks like an automated account (80% yes). It still reads as someone needing this kind of product and close to acting, so check it yourself. lurk also checked whether it was worth a reply, and it was not.",
    );
  });

  it("does not say a close call turned away as the wrong job still reads as needing this kind of product", () => {
    const sentence = filteredSentence({
      kind: "judged",
      code: "wrong_job",
      reason: "Wants a different kind of thing than this product (44% yes same kind).",
      replyChecked: false,
      closeCall: true,
    });
    expect(sentence).toBe(
      "Wants a different kind of thing than this product (44% yes same kind). That answer was near the line, and they read as close to acting, so check it yourself.",
    );
  });

  const listed = (count: number) => Array.from({ length: count }, () => ({}) as XFilteredCard);
  const none: XFiltered = { items: [], judged: 0, screened: 0, unfinished: 0, closeCalls: 0, worth: 0, pending: 0 };

  it("says the rows are set aside, and notes what is still being read and what is not listed", () => {
    expect(filteredSummary({ ...none, items: listed(1), judged: 1 })).toBe(
      "Read and set aside. Each row says why; the bar is the judge's score.",
    );
    expect(filteredSummary({ ...none, items: listed(100), judged: 40, screened: 120, unfinished: 1, closeCalls: 2, pending: 3 })).toBe(
      "Read and set aside. Each row says why; the bar is the judge's score. lurk is still reading 3 more. The first 100 are listed.",
    );
  });

  it("points the empty list at Maybe when it has posts, or else at Left out", () => {
    expect(filteredPointer(none)).toBeNull();
    expect(filteredPointer({ ...none, items: listed(3), screened: 3 })).toBe("What lurk read and set aside, and why, is under Left out below.");
    expect(filteredPointer({ ...none, items: listed(3), judged: 3, closeCalls: 1, worth: 1 })).toBe(
      "One post under Maybe below is worth checking yourself.",
    );
    expect(filteredPointer(none, 2)).toBe("2 posts under Maybe below are worth checking yourself.");
  });
});

describeDb("the filtered-out list against a database", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("x");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  async function seed(rows: Record<string, Row>) {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Clipy", url: "https://clipy.example", pain: "Recording demos", solution: "A screen recorder" });
    const ids: Record<string, string> = {};
    const evaluations: Record<string, string> = {};
    for (const [name, row] of Object.entries(rows)) {
      const id = newId("8");
      ids[name] = id;
      await db()
        .insert(schema.xPosts)
        .values({
          id,
          text: `${name} post`,
          createdAt: new Date(Date.now() - (row.hoursAgo ?? 5) * HOUR),
          authorUsername: `a${id.slice(-8)}`,
          unavailableAt: row.gone ? new Date() : null,
        });
      const judged = row.stage !== "free_rejected" && row.fit !== undefined;
      const [evaluation] = await db()
        .insert(schema.xEvaluations)
        .values({
          projectId: project.id,
          tweetId: id,
          stage: row.stage,
          freeReject: row.freeReject ?? null,
          decision: row.decision ?? (judged ? "reject" : null),
          reasonCode: judged ? (row.code ?? "automated_account") : null,
          reason: judged ? "Looks like an automated account (80% yes)." : null,
          fit: row.fit ?? null,
          intent: row.intent ?? null,
          engagement: judged ? 3 : null,
          score: row.score ?? null,
          signals: row.reply ? { reply: { code: row.reply } } : null,
        })
        .returning();
      evaluations[name] = evaluation.id;
      if (row.stage === "lead") {
        await db().insert(schema.xLeads).values({ projectId: project.id, tweetId: id, kind: "ask", score: row.score ?? 0, authorUsername: `a${id.slice(-8)}` });
      }
    }
    return { project, ids, evaluations };
  }

  type Row = {
    stage: string;
    hoursAgo?: number;
    fit?: number;
    intent?: number;
    score?: number;
    code?: string;
    decision?: string;
    freeReject?: string;
    reply?: string;
    gone?: boolean;
  };

  it("bands what was left out: unfinished, close calls and high scorers first, then the rest judged by score, then screened posts by rule, and counts the whole window", async () => {
    const { listXFiltered } = await import("@/lib/x/read");
    const { project, ids } = await seed({
      plainReject: { stage: "rejected", fit: 1, intent: 3, score: 80 },
      // Both edges of a close call, beating a higher fit that is not one.
      closeCall: { stage: "rejected", fit: 2, intent: 2, score: 55, reply: "not_reply_worthy" },
      highFitNoIntent: { stage: "rejected", fit: 4, intent: 1, score: 60, reply: "reply_stale" },
      unfinished: { stage: "expired", fit: 3, intent: 3, score: 70, decision: "qualify", code: "supported_open_need" },
      neverJudged: { stage: "expired" },
      screenedOld: { stage: "free_rejected", hoursAgo: 50, freeReject: "listicle" },
      screenedNew: { stage: "free_rejected", hoursAgo: 2, freeReject: "no_visible_term:loom" },
      // The newest screened post, but a rule that almost never catches a real person.
      screenedFarm: { stage: "free_rejected", hoursAgo: 1, freeReject: "reply_farm" },
      lowReject: { stage: "rejected", fit: 1, intent: 1, score: 20 },
      held: { stage: "review", fit: 3, intent: 3, score: 70 },
      lead: { stage: "lead", fit: 4, intent: 4, score: 90 },
      waiting: { stage: "pending_llm" },
      waitingReply: { stage: "pending_reply", fit: 2, intent: 1 },
      outsideWindow: { stage: "rejected", hoursAgo: 24 * 9, fit: 4, intent: 4, score: 95 },
      deleted: { stage: "rejected", fit: 4, intent: 4, score: 95, gone: true },
    });

    const filtered = await listXFiltered(project.id, { days: 7, status: "new" });
    expect(filtered.items.map((item) => item.tweetId)).toEqual([
      ids.unfinished,
      ids.closeCall,
      ids.plainReject,
      ids.highFitNoIntent,
      ids.lowReject,
      ids.screenedNew,
      ids.screenedOld,
      ids.screenedFarm,
    ]);
    expect(filtered.items.map((item) => item.band)).toEqual(["worth", "worth", "worth", "worth", "judged", "rule", "rule", "rule"]);
    expect(filtered).toMatchObject({ judged: 4, screened: 3, unfinished: 1, closeCalls: 1, worth: 4, pending: 2 });
    expect(filtered.items.find((item) => item.tweetId === ids.screenedNew)?.score).toBeNull();
    const [unfinished, close, , stale, , screened] = filtered.items;
    expect(unfinished).toMatchObject({ kind: "unfinished", closeCall: false, replyChecked: false, fit: 3 });
    expect(close).toMatchObject({ entryId: `filtered-${close.evaluationId}`, kind: "judged", closeCall: true, replyChecked: true, fit: 2, engagement: 3 });
    expect(close.reason).toMatch(/automated/u);
    // Settled unchecked, too late to answer: no reply check was made.
    expect(stale).toMatchObject({ closeCall: false, replyChecked: false });
    expect(screened).toMatchObject({ kind: "screened", code: "no_visible_term", closeCall: false, replyChecked: false, reason: null, engagement: null });

    const wider = await listXFiltered(project.id, { days: 30, status: "new" });
    expect(wider.items[1]?.tweetId).toBe(ids.outsideWindow);
    expect(wider.closeCalls).toBe(2);
  });

  it("opens a held or filtered-out post by id outside the list, and one since made a lead as that lead", async () => {
    const { xEvaluationEntry } = await import("@/lib/x/read");
    const { project, ids, evaluations } = await seed({
      old: { stage: "rejected", hoursAgo: 24 * 40, fit: 1, intent: 1, score: 10 },
      held: { stage: "review", fit: 3, intent: 3, score: 70 },
      lead: { stage: "lead", fit: 4, intent: 4, score: 90 },
      gone: { stage: "rejected", fit: 1, intent: 1, gone: true },
      waiting: { stage: "pending_llm" },
    });
    expect(await xEvaluationEntry(project.id, evaluations.old)).toMatchObject({ kind: "filtered", item: { tweetId: ids.old, kind: "judged" } });
    expect(await xEvaluationEntry(project.id, evaluations.held)).toMatchObject({ kind: "held", item: { tweetId: ids.held } });
    expect(await xEvaluationEntry(project.id, evaluations.lead)).toMatchObject({ kind: "lead", lead: { tweetId: ids.lead } });
    expect(await xEvaluationEntry(project.id, evaluations.gone)).toBeNull();
    expect(await xEvaluationEntry(project.id, evaluations.waiting)).toBeNull();
    expect(await xEvaluationEntry(randomUUID(), evaluations.old)).toBeNull();
  });
});
