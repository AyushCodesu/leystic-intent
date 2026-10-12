import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { handledThreads, xEvaluations, xLeads } from "@/db/schema";
import { xAskScore, type ScoringSettings } from "@/lib/scoring/weights";
import { X_SCORER_VERSION } from "./constants";
import type { XAssessment } from "./judge";
import type { StoredXPost } from "./store";

/** Writes X verdicts and the leads they make. Nothing here touches a Reddit table. */

export type XEvaluation = typeof xEvaluations.$inferSelect;

/**
 * A first sighting: one row per project and post, so nothing is screened or
 * judged twice. Returns null when another lane of the same run got there
 * first, which is how two lanes finding one post settle who owns it.
 */
export async function insertSighting(row: {
  projectId: string;
  tweetId: string;
  laneId: string | null;
  matchedPhrase: string | null;
  stage: string;
  freeReject: string | null;
  /** What it was found with, for a post found through a reply in its thread (run.ts judgeThread). */
  context?: unknown;
}): Promise<XEvaluation | null> {
  const [inserted] = await db()
    .insert(xEvaluations)
    .values({
      projectId: row.projectId,
      tweetId: row.tweetId,
      laneId: row.laneId,
      matchedPhrase: row.matchedPhrase,
      stage: row.stage,
      freeReject: row.freeReject,
      ...(row.context ? { context: row.context } : {}),
    })
    .onConflictDoNothing()
    .returning();
  return inserted ?? null;
}

/**
 * Hands a post to a venue lane when the lane that saw it first was a buyer
 * lane (rival or request) whose screen dropped it: that screen asks for its
 * words in one sentence and treats numbered steps as a listicle, and a
 * workflow post is both. Only a post nothing was paid for moves. Returns the row to judge, or
 * null when it is not the venue lane's to take.
 */
export async function claimForVenue(row: LaneClaim): Promise<XEvaluation | null> {
  // A thread's walk screens by the rule of the reply's lane, whichever family that was.
  return claimForLaneIf(
    row,
    sql`(${xEvaluations.laneId} is null or ${xEvaluations.laneId} in (select id from x_lanes where family in ('rival', 'request')) or ${xEvaluations.context} ? 'via')`,
  );
}

/**
 * Hands a post to a buyer lane (rival or request) whose screen keeps it when
 * the lane that saw it first dropped it only for not showing its words: which
 * words those are is each lane's own, so "Our booking page keeps breaking. Is
 * there an alternative to Calendly?" fails a category lane's one-sentence rule
 * and passes the rival lane's. A post dropped for who wrote it, its age or its
 * shape stays dropped, and only a post nothing was paid for moves. Returns the
 * row to judge, or null when it is not this lane's to take.
 */
export async function claimForBuyerLane(row: LaneClaim): Promise<XEvaluation | null> {
  return claimForLaneIf(row, eq(xEvaluations.freeReject, "no_visible_term"));
}

type LaneClaim = { projectId: string; tweetId: string; laneId: string; stage: string; matchedPhrase: string | null };

async function claimForLaneIf(row: LaneClaim, condition: SQL): Promise<XEvaluation | null> {
  const [claimed] = await db()
    .update(xEvaluations)
    // Its wait starts now: the pending and reply clocks read createdAt.
    .set({ laneId: row.laneId, stage: row.stage, freeReject: null, matchedPhrase: row.matchedPhrase, createdAt: new Date() })
    .where(
      and(
        eq(xEvaluations.projectId, row.projectId),
        eq(xEvaluations.tweetId, row.tweetId),
        eq(xEvaluations.stage, "free_rejected"),
        condition,
      ),
    )
    .returning();
  return claimed ?? null;
}

/**
 * Takes a post into a thread's judging when a search already returned it and
 * the screen dropped it only because the searched words were not in it: a
 * reply in its thread used them, which is what that rule asks for. Only a
 * post nothing was paid for moves. Returns the row to judge, or null.
 */
export async function claimForThread(row: {
  projectId: string;
  tweetId: string;
  stage: string;
  context: unknown;
}): Promise<XEvaluation | null> {
  const [claimed] = await db()
    .update(xEvaluations)
    // Its wait starts now: a post screened out days ago would otherwise expire, or be too late to answer, the moment it is claimed.
    .set({ stage: row.stage, freeReject: null, context: row.context, createdAt: new Date() })
    .where(
      and(
        eq(xEvaluations.projectId, row.projectId),
        eq(xEvaluations.tweetId, row.tweetId),
        eq(xEvaluations.stage, "free_rejected"),
        eq(xEvaluations.freeReject, "no_visible_term"),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Records the words a search matched on a post another path wrote first, when it has none. */
export async function fillMatchedPhrase(projectId: string, tweetId: string, matchedPhrase: string) {
  await db()
    .update(xEvaluations)
    .set({ matchedPhrase })
    .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.tweetId, tweetId), isNull(xEvaluations.matchedPhrase)));
}

export async function updateEvaluation(id: string, set: Partial<typeof xEvaluations.$inferInsert>) {
  await db().update(xEvaluations).set(set).where(eq(xEvaluations.id, id));
}

/**
 * Stores a verdict. The raw answers go in `signals`, so the gates can be
 * replayed at no cost. `stage` overrides the verdict's own, for a lead that
 * lost to the same author's better post in the conversation ("merged").
 */
export async function recordAssessment(evaluation: XEvaluation, assessment: XAssessment, stage: string = assessment.stage) {
  await updateEvaluation(evaluation.id, {
    stage,
    level: assessment.level,
    decision: assessment.decision,
    reasonCode: assessment.code,
    reason: assessment.reason,
    signals: assessment.signals,
    fit: assessment.fit,
    intent: assessment.intent,
    engagement: assessment.engagement,
    score: assessment.score,
    needQuote: assessment.needQuote,
    scorerVersion: X_SCORER_VERSION,
  });
}

/** What one shown post holds, whichever kind it is. */
export type XLeadWrite = {
  kind: "ask" | "reply";
  score: number;
  fit: number | null;
  intent: number | null;
  engagement: number | null;
  reason: string;
  /** The author's own sentence the verdict rests on, verbatim. */
  quote: string | null;
  /** For a reply: what kind of place it is (reply.ts REPLY_MOMENTS). Null for an ask. */
  moment?: string | null;
};

/**
 * A complete-level buyer verdict as the ask it shows, ranked by the owner's
 * weights when they chose any (lib/scoring/weights.ts) and by the judge's own
 * fold when they did not.
 */
export function askFrom(assessment: XAssessment, scoring: ScoringSettings | null = null): XLeadWrite {
  return {
    kind: "ask",
    score: xAskScore(assessment, scoring) ?? assessment.score,
    fit: assessment.fit,
    intent: assessment.intent,
    engagement: assessment.engagement,
    reason: assessment.reason,
    quote: assessment.needQuote,
  };
}

/**
 * What a new post of this author's in the conversation does to the one already
 * there: an ask always beats a reply, even one somebody hid (the ask shows and
 * the hidden reply stays hidden); otherwise the higher score of a kind stands,
 * and a lead somebody hid or marked not a fit is never replaced.
 */
function against(existing: { kind: string; score: number; status: string }, next: XLeadWrite): "replace" | "beside" | "lose" {
  if (existing.kind === "reply" && next.kind === "ask") {
    return existing.status === "new" ? "replace" : "beside";
  }
  if (existing.status !== "new" || existing.kind !== next.kind) {
    return "lose";
  }
  return next.score > existing.score ? "replace" : "lose";
}

/**
 * Makes a lead visible, keeping the moment it was first found. One per author
 * per conversation: someone posting twice in one thread is one person to
 * answer, so an ask beats a reply, the higher score stands between two of a
 * kind, and the other is merged. A lead somebody already hid or marked not a
 * fit is never replaced. The check and the write hold a lock on that author
 * and conversation, so two of their posts judged at once cannot both show.
 * Returns whether this post is now the one shown; the caller stores the
 * verdict after, so a crash in between leaves the post pending and the next
 * run writes the same lead again.
 */
export async function writeLead(projectId: string, post: StoredXPost, lead: XLeadWrite): Promise<boolean> {
  return db().transaction(async (tx) => {
    const conversation = post.conversationId ?? post.id;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`xlead:${projectId}:${post.authorUsername.toLowerCase()}:${conversation}`}))`,
    );
    const [rival] = await tx
      .select()
      .from(xLeads)
      .where(
        and(
          eq(xLeads.projectId, projectId),
          eq(xLeads.authorUsername, post.authorUsername),
          eq(xLeads.conversationId, conversation),
          ne(xLeads.tweetId, post.id),
        ),
      )
      .orderBy(sql`(${xLeads.status} = 'new') desc`, sql`(${xLeads.kind} = 'ask') desc`, desc(xLeads.score))
      .limit(1);
    // An ask replacing the same person's ask in the conversation keeps when it
    // was first found: alerts window on foundAt, and one person is one alert.
    let carriedFoundAt: Date | undefined;
    if (rival) {
      const outcome = against(rival, lead);
      if (outcome === "lose") {
        return false;
      }
      if (outcome === "replace") {
        carriedFoundAt = rival.kind === "ask" && lead.kind === "ask" ? rival.foundAt : undefined;
        await tx.delete(xLeads).where(eq(xLeads.id, rival.id));
        await tx
          .update(xEvaluations)
          .set({ stage: "merged" })
          .where(and(eq(xEvaluations.projectId, projectId), eq(xEvaluations.tweetId, rival.tweetId)));
      }
    }
    // A conversation the owner already answered takes its new asks as answered too.
    const [handled] = await tx
      .select({ id: handledThreads.id })
      .from(handledThreads)
      .where(
        and(
          eq(handledThreads.projectId, projectId),
          eq(handledThreads.platform, "x"),
          eq(handledThreads.threadId, conversation),
        ),
      )
      .limit(1);
    const values = {
      projectId,
      tweetId: post.id,
      ...(handled ? { status: "replied" } : {}),
      kind: lead.kind,
      score: lead.score,
      fit: lead.fit,
      intent: lead.intent,
      engagement: lead.engagement,
      reason: lead.reason,
      matchedPhrase: lead.quote,
      moment: lead.moment ?? null,
      authorUsername: post.authorUsername,
      conversationId: conversation,
      ...(carriedFoundAt ? { foundAt: carriedFoundAt } : {}),
    };
    await tx
      .insert(xLeads)
      .values(values)
      .onConflictDoUpdate({
        target: [xLeads.projectId, xLeads.tweetId],
        set: {
          kind: values.kind,
          score: values.score,
          fit: values.fit,
          intent: values.intent,
          engagement: values.engagement,
          reason: values.reason,
          matchedPhrase: values.matchedPhrase,
          moment: values.moment,
          scoredAt: sql`now()`,
        },
      });
    return true;
  });
}

/** A verdict that no longer qualifies takes its lead away, unless somebody already acted on it. */
export async function withdrawLead(projectId: string, tweetId: string) {
  await db()
    .delete(xLeads)
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.tweetId, tweetId), eq(xLeads.status, "new")));
}

/** Hide or not-a-fit, by the project's owner. The reason is recorded, never fed back into what is shown. */
export async function setXLeadStatus(
  projectId: string,
  leadId: string,
  status: "replied" | "hidden" | "not_fit",
  notFitReason: string | null,
) {
  await db()
    .update(xLeads)
    .set({ status, notFitReason })
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.id, leadId)));
}

/** The conversation a lead sits in, which is what Replied marks. Null when it is not this project's. */
export async function xLeadConversation(projectId: string, leadId: string): Promise<string | null> {
  const [row] = await db()
    .select({ conversationId: xLeads.conversationId, tweetId: xLeads.tweetId })
    .from(xLeads)
    .where(and(eq(xLeads.projectId, projectId), eq(xLeads.id, leadId)))
    .limit(1);
  return row ? (row.conversationId ?? row.tweetId) : null;
}
