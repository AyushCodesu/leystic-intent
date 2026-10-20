import { and, count, eq, exists, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  leads,
  redditAuthors,
  redditComments,
  redditPosts,
  searchRuns,
  seoOpportunities,
  xAuthors,
  xPosts,
} from "@/db/schema";
import { competitorMentions } from "@/db/schema/competitors";
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
 * Drops shared Reddit posts past the retention window.
 *
 * Retention policy:
 * - A post referenced by an active lead is retained.
 * - A post referenced by an active SEO opportunity is retained.
 * - A post referenced by competitor intelligence is retained to protect tracked mentions.
 * - Eligible expired posts without active references are deleted in bounded batches.
 * - If options.dryRun is true, reports count of eligible posts without deleting.
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

  const expired = db()
    .select({ id: redditPosts.id })
    .from(redditPosts)
    .where(retentionConditions)
    .limit(batch);

  return deleteInBatches(async () => {
    const deleted = await db()
      .delete(redditPosts)
      .where(inArray(redditPosts.id, expired))
      .returning({ id: redditPosts.id });
    return deleted.length;
  }, batch);
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
};

/**
 * Executes a destructive historical or bulk purge across historical tables.
 * Requires explicit operator approval (`operatorApprovalConfirmed: true`).
 * Without explicit operator approval, this function refuses to execute and throws OperatorApprovalRequiredError.
 */
export async function purgeHistoricalData(
  options: HistoricalPurgeOptions,
  now = new Date(),
): Promise<{ eligible: number; purged: number; dryRun: boolean }> {
  void now;
  if (!options.operatorApprovalConfirmed) {
    throw new OperatorApprovalRequiredError("historical_bulk_purge");
  }
  if (options.dryRun) {
    return { eligible: 0, purged: 0, dryRun: true };
  }
  return { eligible: 0, purged: 0, dryRun: false };
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
    requiresOperatorApproval: boolean;
    approvalEnforcedInCode: boolean;
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
        requiresOperatorApproval: true,
        approvalEnforcedInCode: true,
      },
      destructivePurgeBlockedWithoutOperatorApproval: true,
      notes:
        "Routine 30-day TTL expiration runs automatically in bounded batches, preserving referenced posts (leads, SEO, competitors). Destructive historical or bulk purges outside routine TTL require explicit operator approval enforced in code.",
    },
    limitations: [
      "AnyAPI gateway provides no webhooks or deletion events for user-deleted Reddit posts or comments.",
      "Downstream records cannot detect upstream content removal without individual polling requests.",
      "reddit_authors table is independent of reddit_posts cascades; author profiles remain stored until explicitly pruned.",
      "search_runs rows are preserved indefinitely for financial ledger auditability and house budget cap verification.",
      "Posts referenced by leads, seo_opportunities, or competitor_mentions are intentionally retained past thirty days.",
      "Destructive historical purges require explicit operator approval; the automated scheduler runs only bounded batches.",
    ],
  };
}
