import { and, count, eq, exists, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  leadEvaluations,
  leads,
  postReadings,
  redditAuthors,
  redditComments,
  redditPosts,
  searchRuns,
  seoOpportunities,
  xAuthors,
  xPosts,
} from "@/db/schema";
export { deleteProject } from "./projects";
export { deleteXPost, eraseXAuthor } from "./x/retention";
import { competitorMentions } from "@/db/schema/competitors";
import { assertAuthorizedOperator, ensureSourcePolicyFresh, type OperatorContext } from "./sourcePolicy";
import { daysAgo } from "./time";
import { RETENTION_DAYS } from "./tiers";

/** Rows dropped per statement, so no one delete holds its row locks for long. */
export const RETENTION_BATCH = 500;

/**
 * Runs a delete of at most one batch again and again, until a pass takes
 * fewer than a batch, and says how many rows went in all. `pass` deletes one
 * batch and says how many it took.
 */
export async function deleteInBatches(
  pass: () => Promise<number>,
  batch = RETENTION_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await pass();
    total += deleted;
    if (deleted < batch) {
      return total;
    }
  }
}

export type RetentionOptions = {
  dryRun?: boolean;
};

/**
 * Redacts raw provider content from expired posts and comments, and clears
 * verbatim excerpts from downstream tables (leads, lead_evaluations, competitor_mentions, post_readings).
 *
 * This ensures that when a post is referenced by active leads, SEO opportunities, or competitor mentions,
 * the minimum necessary lead metadata is preserved while raw provider text and excerpts are scrubbed
 * past the 30-day retention window.
 */
export async function redactExpiredProviderContent(
  now = new Date(),
  batch = RETENTION_BATCH,
  options: RetentionOptions = {},
): Promise<{ redactedPosts: number; redactedComments: number }> {
  const cutoff = daysAgo(RETENTION_DAYS, now);

  const expiredPostFilter = and(
    lt(redditPosts.createdAt, cutoff),
    sql`(${redditPosts.body} is not null or ${redditPosts.raw} is not null)`,
  );

  if (options.dryRun) {
    const postCountRow = await db()
      .select({ total: count() })
      .from(redditPosts)
      .where(expiredPostFilter);
    const commentCountRow = await db()
      .select({ total: count() })
      .from(redditComments)
      .where(
        and(
          lt(redditComments.createdAt, cutoff),
          sql`(${redditComments.body} is not null or ${redditComments.raw} is not null)`,
        ),
      );
    return {
      redactedPosts: Number(postCountRow[0]?.total ?? 0),
      redactedComments: Number(commentCountRow[0]?.total ?? 0),
    };
  }

  // 1. Scrub raw body and raw payload from expired posts
  const redactedPosts = await deleteInBatches(async () => {
    const targets = await db()
      .select({ id: redditPosts.id })
      .from(redditPosts)
      .where(expiredPostFilter)
      .limit(batch);

    if (targets.length === 0) return 0;

    await db()
      .update(redditPosts)
      .set({ body: null, raw: null })
      .where(inArray(redditPosts.id, targets.map((t) => t.id)));

    return targets.length;
  }, batch);

  // 2. Scrub raw body and raw payload from expired comments
  const redactedComments = await deleteInBatches(async () => {
    const targets = await db()
      .select({ id: redditComments.id })
      .from(redditComments)
      .where(
        and(
          lt(redditComments.createdAt, cutoff),
          sql`(${redditComments.body} is not null or ${redditComments.raw} is not null)`,
        ),
      )
      .limit(batch);

    if (targets.length === 0) return 0;

    await db()
      .update(redditComments)
      .set({ body: null, raw: null })
      .where(inArray(redditComments.id, targets.map((t) => t.id)));

    return targets.length;
  }, batch);

  // 3. Scrub downstream verbatim excerpts
  const expiredPostIdsSubquery = db()
    .select({ id: redditPosts.id })
    .from(redditPosts)
    .where(lt(redditPosts.createdAt, cutoff));

  await db()
    .update(leads)
    .set({ matchedPhrase: null })
    .where(and(isNotNull(leads.matchedPhrase), inArray(leads.postId, expiredPostIdsSubquery)));

  await db()
    .update(leadEvaluations)
    .set({ evidenceQuote: null })
    .where(
      and(isNotNull(leadEvaluations.evidenceQuote), inArray(leadEvaluations.postId, expiredPostIdsSubquery)),
    );

  await db()
    .update(competitorMentions)
    .set({ quote: null, switchingEvidence: null })
    .where(
      and(
        sql`(${competitorMentions.quote} is not null or ${competitorMentions.switchingEvidence} is not null)`,
        inArray(competitorMentions.postId, expiredPostIdsSubquery),
      ),
    );

  await db()
    .update(postReadings)
    .set({ quote: null })
    .where(and(isNotNull(postReadings.quote), inArray(postReadings.postId, expiredPostIdsSubquery)));

  return { redactedPosts, redactedComments };
}

/**
 * Prunes orphaned author profiles from reddit_authors that are no longer referenced
 * by any stored post or comment, and scrubs raw API payloads on authors older than 30 days.
 */
export async function pruneOrphanedAuthors(
  now = new Date(),
  batch = RETENTION_BATCH,
  options: RetentionOptions = {},
): Promise<number> {
  const cutoff = daysAgo(RETENTION_DAYS, now);

  const orphanedCondition = and(
    notExists(
      db()
        .select({ one: sql`1` })
        .from(redditPosts)
        .where(eq(sql`lower(${redditPosts.author})`, sql`lower(${redditAuthors.username})`)),
    ),
    notExists(
      db()
        .select({ one: sql`1` })
        .from(redditComments)
        .where(eq(sql`lower(${redditComments.author})`, sql`lower(${redditAuthors.username})`)),
    ),
  );

  if (options.dryRun) {
    const rows = await db()
      .select({ total: count() })
      .from(redditAuthors)
      .where(orphanedCondition);
    return Number(rows[0]?.total ?? 0);
  }

  // Scrub raw API payloads on authors fetched past the 30-day retention window
  await db()
    .update(redditAuthors)
    .set({ raw: null })
    .where(and(lt(redditAuthors.fetchedAt, cutoff), isNotNull(redditAuthors.raw)));

  // Delete orphaned author rows in bounded batches
  return deleteInBatches(async () => {
    const targets = await db()
      .select({ username: redditAuthors.username })
      .from(redditAuthors)
      .where(orphanedCondition)
      .limit(batch);

    if (targets.length === 0) return 0;

    const deleted = await db()
      .delete(redditAuthors)
      .where(inArray(redditAuthors.username, targets.map((t) => t.username)))
      .returning({ username: redditAuthors.username });

    return deleted.length;
  }, batch);
}

/**
 * Drops shared Reddit posts past the retention window.
 *
 * Retention policy:
 * - A post referenced by an active lead, SEO opportunity, or competitor intelligence retains
 *   its minimum necessary metadata row, while its raw provider content (body, raw, comments,
 *   and downstream excerpts) is redacted under redactExpiredProviderContent.
 * - Eligible expired posts without active references are deleted in bounded batches.
 * - Orphaned authors with no remaining posts or comments are pruned.
 * - If options.dryRun is true, reports count of eligible unreferenced posts without deleting.
 */
export async function deleteExpiredPosts(
  now = new Date(),
  batch = RETENTION_BATCH,
  options: RetentionOptions = {},
): Promise<number> {
  const cutoff = daysAgo(RETENTION_DAYS, now);

  const retentionConditions = and(
    lt(redditPosts.createdAt, cutoff),
    notExists(
      db().select({ one: sql`1` }).from(leads).where(eq(leads.postId, redditPosts.id)),
    ),
    notExists(
      db()
        .select({ one: sql`1` })
        .from(seoOpportunities)
        .where(eq(seoOpportunities.postId, redditPosts.id)),
    ),
    notExists(
      db()
        .select({ one: sql`1` })
        .from(competitorMentions)
        .where(eq(competitorMentions.postId, redditPosts.id)),
    ),
  );

  if (options.dryRun) {
    const rows = await db()
      .select({ total: count() })
      .from(redditPosts)
      .where(retentionConditions);
    return Number(rows[0]?.total ?? 0);
  }

  // 1. Redact raw provider content from expired referenced posts and downstream tables
  await redactExpiredProviderContent(now, batch, options);

  // 2. Delete unreferenced expired posts in bounded batches
  const expired = db()
    .select({ id: redditPosts.id })
    .from(redditPosts)
    .where(retentionConditions)
    .limit(batch);

  const deletedTotal = await deleteInBatches(async () => {
    const deleted = await db()
      .delete(redditPosts)
      .where(inArray(redditPosts.id, expired))
      .returning({ id: redditPosts.id });
    return deleted.length;
  }, batch);

  // 3. Prune orphaned author profiles
  await pruneOrphanedAuthors(now, batch, options);

  return deletedTotal;
}

/**
 * Targeted deletion of a single Reddit post and associated raw content.
 * PostgreSQL foreign keys cascade to reddit_comments, post_readings, search_run_posts,
 * lead_evaluations, competitor_mentions, and leads, while setting seo_opportunities.postId to null.
 * Author profiles are pruned if left orphaned.
 * Idempotent, transaction-safe, and does not retain deleted post body in the audit log.
 */
export async function deleteRedditPost(
  postId: string,
  options: { operatorContext?: OperatorContext; dryRun?: boolean } = {},
): Promise<{ deleted: boolean; notFound?: boolean; dryRun?: boolean; postId: string }> {
  if (options.operatorContext) {
    await ensureSourcePolicyFresh();
    assertAuthorizedOperator(options.operatorContext);
  }

  const existing = await db()
    .select({ id: redditPosts.id, author: redditPosts.author })
    .from(redditPosts)
    .where(eq(redditPosts.id, postId));

  if (existing.length === 0) {
    return { deleted: false, notFound: true, postId };
  }

  if (options.dryRun) {
    return { deleted: false, dryRun: true, postId };
  }

  return db().transaction(async (tx) => {
    await tx.delete(redditPosts).where(eq(redditPosts.id, postId));

    const postAuthor = existing[0].author;
    if (postAuthor) {
      const remainingPosts = await tx
        .select({ id: redditPosts.id })
        .from(redditPosts)
        .where(eq(sql`lower(${redditPosts.author})`, postAuthor.toLowerCase()))
        .limit(1);
      const remainingComments = await tx
        .select({ id: redditComments.id })
        .from(redditComments)
        .where(eq(sql`lower(${redditComments.author})`, postAuthor.toLowerCase()))
        .limit(1);

      if (remainingPosts.length === 0 && remainingComments.length === 0) {
        await tx
          .delete(redditAuthors)
          .where(eq(sql`lower(${redditAuthors.username})`, postAuthor.toLowerCase()));
      }
    }

    return { deleted: true, postId };
  });
}

/**
 * Targeted anonymization/erasure of a Reddit author.
 * Replaces author username with '[deleted]' on posts and comments,
 * and deletes the author's row in reddit_authors.
 * Idempotent, transaction-safe, and does not retain author details in the audit log.
 */
export async function eraseRedditAuthor(
  username: string,
  options: { operatorContext?: OperatorContext; dryRun?: boolean } = {},
): Promise<{ erased: boolean; notFound?: boolean; dryRun?: boolean; username: string }> {
  if (options.operatorContext) {
    await ensureSourcePolicyFresh();
    assertAuthorizedOperator(options.operatorContext);
  }

  const existing = await db()
    .select({ username: redditAuthors.username })
    .from(redditAuthors)
    .where(eq(sql`lower(${redditAuthors.username})`, username.toLowerCase()));

  const matchingPosts = await db()
    .select({ id: redditPosts.id })
    .from(redditPosts)
    .where(eq(sql`lower(${redditPosts.author})`, username.toLowerCase()));

  const matchingComments = await db()
    .select({ id: redditComments.id })
    .from(redditComments)
    .where(eq(sql`lower(${redditComments.author})`, username.toLowerCase()));

  if (existing.length === 0 && matchingPosts.length === 0 && matchingComments.length === 0) {
    return { erased: false, notFound: true, username };
  }

  if (options.dryRun) {
    return { erased: false, dryRun: true, username };
  }

  return db().transaction(async (tx) => {
    await tx
      .update(redditPosts)
      .set({ author: "[deleted]" })
      .where(eq(sql`lower(${redditPosts.author})`, username.toLowerCase()));

    await tx
      .update(redditComments)
      .set({ author: "[deleted]" })
      .where(eq(sql`lower(${redditComments.author})`, username.toLowerCase()));

    await tx
      .delete(redditAuthors)
      .where(eq(sql`lower(${redditAuthors.username})`, username.toLowerCase()));

    return { erased: true, username };
  });
}

/** How long the queue keeps a finished job, unless it is the newest of its kind. */
export const JOB_HISTORY_DAYS = 30;

/**
 * Drops the queue's finished jobs once they are a month old.
 */
export async function pruneFinishedJobs(
  now = new Date(),
  batch = RETENTION_BATCH,
  options: RetentionOptions = {},
): Promise<number> {
  const cutoff = daysAgo(JOB_HISTORY_DAYS, now).toISOString();

  if (options.dryRun) {
    const rows = await db().execute<{ count: string }>(sql`
      select count(*) as count from (
        select id from (
          select id, finished_at,
            row_number() over (
              partition by project_id, kind order by started_at desc nulls last
            ) as by_start,
            row_number() over (partition by project_id, kind order by finished_at desc) as by_finish
          from jobs
          where finished_at is not null
        ) ranked
        where finished_at < ${cutoff}::timestamptz and by_start > 1 and by_finish > 1
      ) eligible
    `);
    return Number(rows[0]?.count ?? 0);
  }

  return deleteInBatches(async () => {
    const deleted = await db().execute<{ id: string }>(sql`
      delete from jobs where id in (
        select id from (
          select id, finished_at,
            row_number() over (
              partition by project_id, kind order by started_at desc nulls last
            ) as by_start,
            row_number() over (partition by project_id, kind order by finished_at desc) as by_finish
          from jobs
          where finished_at is not null
        ) ranked
        where finished_at < ${cutoff}::timestamptz and by_start > 1 and by_finish > 1
        limit ${batch}
      )
      returning id
    `);
    return deleted.length;
  }, batch);
}

export class OperatorApprovalRequiredError extends Error {
  constructor(operation: string) {
    super(
      `[Retention Policy] Destructive operation '${operation}' requires explicit operator approval confirmation.`,
    );
    this.name = "OperatorApprovalRequiredError";
  }
}

export type HistoricalPurgeOptions = {
  operatorApprovalConfirmed: boolean;
  operatorNote?: string;
  dryRun?: boolean;
  operatorContext?: OperatorContext;
};

export type HistoricalPurgePlan = {
  isImplemented: false;
  status: "deferred_not_implemented";
  message: string;
  eligible: number;
  purged: number;
  dryRun: boolean;
  requiresOperatorApproval: true;
  operatorApprovalConfirmed: boolean;
};

/**
 * Approval guard and planning placeholder for deferred historical bulk purging.
 * Real historical purge functionality is intentionally deferred and not implemented in code.
 * Requires explicit operator approval (`operatorApprovalConfirmed: true`); throws OperatorApprovalRequiredError otherwise.
 */
export async function planHistoricalPurge(
  options: HistoricalPurgeOptions,
  now = new Date(),
): Promise<HistoricalPurgePlan> {
  void now;
  if (!options.operatorApprovalConfirmed) {
    throw new OperatorApprovalRequiredError("historical_bulk_purge");
  }
  if (options.operatorContext) {
    await ensureSourcePolicyFresh();
    assertAuthorizedOperator(options.operatorContext);
  }
  return {
    isImplemented: false,
    status: "deferred_not_implemented",
    message:
      "Historical purge execution is intentionally deferred and not implemented in code. Calling this function acts solely as an approval guard placeholder.",
    eligible: 0,
    purged: 0,
    dryRun: options.dryRun ?? false,
    requiresOperatorApproval: true,
    operatorApprovalConfirmed: true,
  };
}

/**
 * Executes a destructive historical or bulk purge across historical tables.
 * Preserved as an alias for planHistoricalPurge, enforcing operator approval while
 * truthfully reporting that execution is deferred.
 */
export async function purgeHistoricalData(
  options: HistoricalPurgeOptions,
  now = new Date(),
): Promise<HistoricalPurgePlan> {
  return planHistoricalPurge(options, now);
}

export type RetentionBreakdown = {
  total: number;
  unexpired: number;
  expired: number;
  retainedByLeads: number;
  retainedBySeo: number;
  retainedByCompetitorMentions: number;
  eligibleForDeletion: number;
};

export type RetentionDryRunPlan = {
  cutoffDate: string;
  eligiblePostsToDelete: number;
  preservedReferencedPosts: {
    byLeads: number;
    bySeo: number;
    byCompetitorMentions: number;
    totalPreserved: number;
  };
  routineTtlCleanup: {
    isAutomatic: boolean;
    windowDays: number;
    batchSize: number;
    preservesReferencedRows: boolean;
  };
  historicalBulkPurge: {
    isImplemented: boolean;
    requiresOperatorApproval: boolean;
    approvalEnforcedInCode: boolean;
    status: string;
    message: string;
  };
  destructivePurgeBlockedWithoutOperatorApproval: boolean;
  notes: string;
};

export type RetentionAuditReport = {
  auditTimestamp: string;
  retentionWindowDays: number;
  cutoffDate: string;
  redditPosts: RetentionBreakdown;
  redditComments: {
    total: number;
  };
  redditAuthors: {
    total: number;
  };
  competitorMentions: {
    total: number;
    onExpiredPosts: number;
  };
  searchRuns: {
    total: number;
    completed: number;
  };
  xData: {
    totalPosts: number;
    expiredPosts: number;
    totalAuthors: number;
    expiredAuthors: number;
  };
  dryRunPlan: RetentionDryRunPlan;
  limitations: string[];
};

/**
 * Computes an explicit, read-only retention audit and dry-run report.
 * Does not perform destructive operations.
 */
export async function auditRetention(now = new Date()): Promise<RetentionAuditReport> {
  const cutoff = daysAgo(RETENTION_DAYS, now);

  const [
    totalPostsRow,
    expiredPostsRow,
    retainedByLeadsRow,
    retainedBySeoRow,
    retainedByCompetitorRow,
    eligiblePostsRow,
    totalCommentsRow,
    totalAuthorsRow,
    totalMentionsRow,
    mentionsOnExpiredRow,
    totalRunsRow,
    completedRunsRow,
    totalXPostsRow,
    expiredXPostsRow,
    totalXAuthorsRow,
    expiredXAuthorsRow,
  ] = await Promise.all([
    db().select({ count: count() }).from(redditPosts),
    db().select({ count: count() }).from(redditPosts).where(lt(redditPosts.createdAt, cutoff)),
    db()
      .select({ count: count() })
      .from(redditPosts)
      .where(
        and(
          lt(redditPosts.createdAt, cutoff),
          exists(db().select({ one: sql`1` }).from(leads).where(eq(leads.postId, redditPosts.id))),
        ),
      ),
    db()
      .select({ count: count() })
      .from(redditPosts)
      .where(
        and(
          lt(redditPosts.createdAt, cutoff),
          notExists(db().select({ one: sql`1` }).from(leads).where(eq(leads.postId, redditPosts.id))),
          exists(
            db()
              .select({ one: sql`1` })
              .from(seoOpportunities)
              .where(eq(seoOpportunities.postId, redditPosts.id)),
          ),
        ),
      ),
    db()
      .select({ count: count() })
      .from(redditPosts)
      .where(
        and(
          lt(redditPosts.createdAt, cutoff),
          notExists(db().select({ one: sql`1` }).from(leads).where(eq(leads.postId, redditPosts.id))),
          notExists(
            db()
              .select({ one: sql`1` })
              .from(seoOpportunities)
              .where(eq(seoOpportunities.postId, redditPosts.id)),
          ),
          exists(
            db()
              .select({ one: sql`1` })
              .from(competitorMentions)
              .where(eq(competitorMentions.postId, redditPosts.id)),
          ),
        ),
      ),
    db()
      .select({ count: count() })
      .from(redditPosts)
      .where(
        and(
          lt(redditPosts.createdAt, cutoff),
          notExists(db().select({ one: sql`1` }).from(leads).where(eq(leads.postId, redditPosts.id))),
          notExists(
            db()
              .select({ one: sql`1` })
              .from(seoOpportunities)
              .where(eq(seoOpportunities.postId, redditPosts.id)),
          ),
          notExists(
            db()
              .select({ one: sql`1` })
              .from(competitorMentions)
              .where(eq(competitorMentions.postId, redditPosts.id)),
          ),
        ),
      ),
    db().select({ count: count() }).from(redditComments),
    db().select({ count: count() }).from(redditAuthors),
    db().select({ count: count() }).from(competitorMentions),
    db()
      .select({ count: count() })
      .from(competitorMentions)
      .innerJoin(redditPosts, eq(redditPosts.id, competitorMentions.postId))
      .where(lt(redditPosts.createdAt, cutoff)),
    db().select({ count: count() }).from(searchRuns),
    db().select({ count: count() }).from(searchRuns).where(isNotNull(searchRuns.completedAt)),
    db().select({ count: count() }).from(xPosts),
    db()
      .select({ count: count() })
      .from(xPosts)
      .where(and(lt(xPosts.createdAt, cutoff), lt(xPosts.fetchedAt, cutoff))),
    db().select({ count: count() }).from(xAuthors),
    db().select({ count: count() }).from(xAuthors).where(lt(xAuthors.fetchedAt, cutoff)),
  ]);

  const totalPosts = Number(totalPostsRow[0]?.count ?? 0);
  const expiredPosts = Number(expiredPostsRow[0]?.count ?? 0);
  const unexpiredPosts = Math.max(0, totalPosts - expiredPosts);
  const retainedByLeads = Number(retainedByLeadsRow[0]?.count ?? 0);
  const retainedBySeo = Number(retainedBySeoRow[0]?.count ?? 0);
  const retainedByCompetitorMentions = Number(retainedByCompetitorRow[0]?.count ?? 0);
  const eligibleForDeletion = Number(eligiblePostsRow[0]?.count ?? 0);

  return {
    auditTimestamp: now.toISOString(),
    retentionWindowDays: RETENTION_DAYS,
    cutoffDate: cutoff.toISOString(),
    redditPosts: {
      total: totalPosts,
      unexpired: unexpiredPosts,
      expired: expiredPosts,
      retainedByLeads,
      retainedBySeo,
      retainedByCompetitorMentions,
      eligibleForDeletion,
    },
    redditComments: {
      total: Number(totalCommentsRow[0]?.count ?? 0),
    },
    redditAuthors: {
      total: Number(totalAuthorsRow[0]?.count ?? 0),
    },
    competitorMentions: {
      total: Number(totalMentionsRow[0]?.count ?? 0),
      onExpiredPosts: Number(mentionsOnExpiredRow[0]?.count ?? 0),
    },
    searchRuns: {
      total: Number(totalRunsRow[0]?.count ?? 0),
      completed: Number(completedRunsRow[0]?.count ?? 0),
    },
    xData: {
      totalPosts: Number(totalXPostsRow[0]?.count ?? 0),
      expiredPosts: Number(expiredXPostsRow[0]?.count ?? 0),
      totalAuthors: Number(totalXAuthorsRow[0]?.count ?? 0),
      expiredAuthors: Number(expiredXAuthorsRow[0]?.count ?? 0),
    },
    dryRunPlan: {
      cutoffDate: cutoff.toISOString(),
      eligiblePostsToDelete: eligibleForDeletion,
      preservedReferencedPosts: {
        byLeads: retainedByLeads,
        bySeo: retainedBySeo,
        byCompetitorMentions: retainedByCompetitorMentions,
        totalPreserved: retainedByLeads + retainedBySeo + retainedByCompetitorMentions,
      },
      routineTtlCleanup: {
        isAutomatic: true,
        windowDays: RETENTION_DAYS,
        batchSize: RETENTION_BATCH,
        preservesReferencedRows: true,
      },
      historicalBulkPurge: {
        isImplemented: false,
        requiresOperatorApproval: true,
        approvalEnforcedInCode: true,
        status: "deferred_not_implemented",
        message:
          "No destructive historical bulk purge operation is currently implemented; execution is deferred. Automated routine TTL cleanup is the only active deletion mechanism.",
      },
      destructivePurgeBlockedWithoutOperatorApproval: true,
      notes:
        "Routine 30-day TTL expiration runs automatically in bounded batches, redacting raw provider content from referenced posts and deleting unreferenced rows. Destructive historical or bulk purges outside routine TTL require explicit operator approval enforced in code; execution is currently deferred.",
    },
    limitations: [
      "AnyAPI gateway provides no webhooks or deletion events for user-deleted Reddit posts or comments.",
      "Downstream records cannot detect upstream content removal without individual polling requests.",
      "reddit_authors table is independent of reddit_posts cascades; author profiles are pruned by routine cleanup when left orphaned.",
      "search_runs rows are preserved indefinitely for financial ledger auditability and house budget cap verification.",
      "Posts referenced by leads, seo_opportunities, or competitor_mentions retain minimal metadata past thirty days, while raw post bodies, comments, and excerpts are scrubbed under the retention policy.",
      "Destructive historical purges require explicit operator approval; the automated scheduler runs only bounded batches.",
    ],
  };
}
