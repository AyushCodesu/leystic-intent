import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { deletionAuditLog, xAuthors, xLanes, xPosts, xRuns } from "@/db/schema";
import { assertAuthorizedOperator, ensureSourcePolicyFresh, type OperatorContext } from "@/lib/sourcePolicy";
import { deleteInBatches, OperatorApprovalRequiredError, RETENTION_BATCH } from "@/lib/retention";
import { daysAgo } from "@/lib/time";
import { RETENTION_DAYS } from "@/lib/tiers";

const RUN_HISTORY_DAYS = 90;

/**
 * Drops X content past the retention window. Unlike Reddit, a lead does not
 * keep its post: the tab shows seven days and an X lead is stale in hours, so
 * nothing is worth holding past thirty, and lurk keeps no archive of X. A post
 * goes once it was both written and fetched before the cutoff, so a parent
 * bought as context lives thirty days from its purchase. Its evaluations, leads
 * and run links cascade, each found through its own tweet_id index, and the
 * posts go a batch at a time, as Reddit's do (see deleteExpiredPosts).
 *
 * X's search_runs rows stay, as Reddit's do: they hold a query and a cost, no
 * X content. A retired lane goes with the run history, once it last ran (or
 * was made) that long ago; the verdicts that point at it keep their rows and
 * lose the link.
 */
export async function deleteExpiredXData(now = new Date()): Promise<{ posts: number; authors: number }> {
  const cutoff = daysAgo(RETENTION_DAYS, now);
  const history = daysAgo(RUN_HISTORY_DAYS, now);

  let posts = 0;
  let authorsCount = 0;
  let runsCount = 0;
  let lanesCount = 0;

  try {
    const expired = db()
      .select({ id: xPosts.id })
      .from(xPosts)
      .where(and(lt(xPosts.createdAt, cutoff), lt(xPosts.fetchedAt, cutoff)))
      .limit(RETENTION_BATCH);

    posts = await deleteInBatches(async () => {
      const deleted = await db().delete(xPosts).where(inArray(xPosts.id, expired)).returning({ id: xPosts.id });
      return deleted.length;
    });

    const authors = await db()
      .delete(xAuthors)
      .where(lt(xAuthors.fetchedAt, cutoff))
      .returning({ username: xAuthors.username });
    authorsCount = authors.length;

    const deletedRuns = await db().delete(xRuns).where(lt(xRuns.startedAt, history)).returning({ id: xRuns.id });
    runsCount = deletedRuns.length;

    const deletedLanes = await db()
      .delete(xLanes)
      .where(
        and(
          eq(xLanes.state, "retired"),
          sql`coalesce(${xLanes.lastRunAt}, ${xLanes.createdAt}) < ${history.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: xLanes.id });
    lanesCount = deletedLanes.length;

    // Record routine TTL batch audit event in append-only deletion audit log
    await db().insert(deletionAuditLog).values({
      action: "TTL_BATCH_CLEANUP",
      actor: "system:routine_ttl",
      actorRole: "system_service",
      targetType: "x_retention_batch",
      targetId: now.toISOString(),
      outcome: "SUCCESS",
      reasonCode: "ROUTINE_TTL_EXPIRY",
      details: {
        source: "x",
        cutoff: cutoff.toISOString(),
        deletedPosts: posts,
        deletedAuthors: authorsCount,
        deletedRuns: runsCount,
        deletedLanes: lanesCount,
      },
    });

    return { posts, authors: authorsCount };
  } catch (error) {
    try {
      await db().insert(deletionAuditLog).values({
        action: "TTL_BATCH_CLEANUP",
        actor: "system:routine_ttl",
        actorRole: "system_service",
        targetType: "x_retention_batch",
        targetId: now.toISOString(),
        outcome: "FAILURE",
        reasonCode: "ROUTINE_TTL_FAILURE",
        details: {
          source: "x",
          cutoff: cutoff.toISOString(),
          deletedPosts: posts,
          deletedAuthors: authorsCount,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
    } catch {
      // Do not mask original error if audit logging fails
    }
    throw error;
  }
}

/**
 * Targeted deletion of an X tweet and cascading downstream records.
 * Idempotent, transaction-safe, and does not retain tweet text in audit logs.
 */
export async function deleteXPost(
  tweetId: string,
  options: { operatorContext: OperatorContext; dryRun?: boolean; reason?: string },
): Promise<{ deleted: boolean; notFound?: boolean; dryRun?: boolean; tweetId: string }> {
  if (!options?.operatorContext) {
    throw new OperatorApprovalRequiredError("delete_x_post");
  }
  await ensureSourcePolicyFresh();
  const verified = assertAuthorizedOperator(options.operatorContext);

  const existing = await db()
    .select({ id: xPosts.id })
    .from(xPosts)
    .where(eq(xPosts.id, tweetId));

  if (existing.length === 0) {
    return { deleted: false, notFound: true, tweetId };
  }

  if (options.dryRun) {
    return { deleted: false, dryRun: true, tweetId };
  }

  return db().transaction(async (tx) => {
    await tx.delete(xPosts).where(eq(xPosts.id, tweetId));

    await tx.insert(deletionAuditLog).values({
      action: "DELETE_X_POST",
      actor: verified.operatorId,
      actorRole: verified.role,
      targetType: "x_post",
      targetId: tweetId,
      outcome: "SUCCESS",
      reasonCode: options.reason ?? "OPERATOR_DELETION",
      details: {},
    });

    return { deleted: true, tweetId };
  });
}

/**
 * Targeted deletion of an X author profile and facts.
 * Idempotent, transaction-safe, and does not retain author bio/personal text in audit logs.
 */
export async function eraseXAuthor(
  username: string,
  options: { operatorContext: OperatorContext; dryRun?: boolean; reason?: string },
): Promise<{ erased: boolean; notFound?: boolean; dryRun?: boolean; username: string }> {
  if (!options?.operatorContext) {
    throw new OperatorApprovalRequiredError("erase_x_author");
  }
  await ensureSourcePolicyFresh();
  const verified = assertAuthorizedOperator(options.operatorContext);

  const existing = await db()
    .select({ username: xAuthors.username })
    .from(xAuthors)
    .where(eq(sql`lower(${xAuthors.username})`, username.toLowerCase()));

  if (existing.length === 0) {
    return { erased: false, notFound: true, username };
  }

  if (options.dryRun) {
    return { erased: false, dryRun: true, username };
  }

  return db().transaction(async (tx) => {
    await tx.delete(xAuthors).where(eq(sql`lower(${xAuthors.username})`, username.toLowerCase()));

    const opaqueTargetId = `anon-author-${randomUUID()}`;
    await tx.insert(deletionAuditLog).values({
      action: "ERASE_X_AUTHOR",
      actor: verified.operatorId,
      actorRole: verified.role,
      targetType: "x_author",
      targetId: opaqueTargetId,
      outcome: "SUCCESS",
      reasonCode: options.reason ?? "AUTHOR_ERASURE_REQUEST",
      details: {},
    });

    return { erased: true, username };
  });
}
