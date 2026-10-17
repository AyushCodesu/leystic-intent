import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { competitorMentions } from "@/db/schema/competitors";
import { enqueueJob, writeProgress } from "@/jobs/enqueue";
import { clientForUser } from "@/lib/anyapi";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchPost, fetchSearch } from "@/lib/reddit/skus";
import type { StoredPost } from "@/lib/reddit/store";
import { inFlight } from "@/lib/inFlight";
import { requireScanProject } from "@/lib/scan/project";
import { cadenceFor } from "@/lib/settings/cadence";
import { capped, tierForUser } from "@/lib/tier";
import { RETENTION_DAYS } from "@/lib/tiers";
import { classifyMentions, type MentionCandidate, type Verdict } from "./classify";

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * 24 * HOUR_MS;

/** How many of the week's newest posts about one competitor are read in full. */
export const MENTION_POSTS_PER_COMPETITOR = 10;

export type CompetitorScanOutcome = {
  competitors: number;
  read: number;
  mentions: number;
  skipped: number;
  costUsd: number;
};

/** Posts this project already holds a mention of, for this competitor. */
async function knownMentionPosts(projectId: string, competitor: string): Promise<Set<string>> {
  const rows = await db()
    .select({ postId: competitorMentions.postId })
    .from(competitorMentions)
    .where(
      and(
        eq(competitorMentions.projectId, projectId),
        eq(competitorMentions.competitor, competitor),
      ),
    );
  return new Set(rows.map((row) => row.postId));
}

function toCandidate(post: StoredPost): MentionCandidate {
  return {
    id: post.id,
    title: post.title,
    subreddit: post.subreddit,
    body: post.body ?? "",
  };
}

/**
 * A post the writer only linked to, embedded, or named without a view is not a
 * mention worth storing, so only the_product verdicts reach the table.
 */
export function keepMentions(verdicts: Map<string, Verdict>): Map<string, Verdict> {
  const kept = new Map<string, Verdict>();
  for (const [id, verdict] of verdicts) {
    if (verdict.about === "the_product") {
      kept.set(id, verdict);
    }
  }
  return kept;
}

async function writeMentions(
  projectId: string,
  competitor: string,
  posts: StoredPost[],
  kept: Map<string, Verdict>,
): Promise<number> {
  const rows = posts
    .map((post) => ({ post, verdict: kept.get(post.id) }))
    .filter((entry): entry is { post: StoredPost; verdict: Verdict } => entry.verdict !== undefined)
    .map((entry) => ({
      projectId,
      competitor,
      postId: entry.post.id,
      sentiment: entry.verdict.sentiment,
      summary: entry.verdict.summary,
      reasonCategory: entry.verdict.reasonCategory,
      switchingEvidence: entry.verdict.switchingEvidence,
      explanation: entry.verdict.explanation,
      foundAt: new Date(),
    }));
  if (rows.length === 0) {
    return 0;
  }
  const written = await db()
    .insert(competitorMentions)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: competitorMentions.id });
  return written.length;
}

async function scanOne(
  ctx: FetchContext,
  jobId: string,
  competitor: string,
): Promise<{ read: number; mentions: number; skipped: number; costUsd: number }> {
  await writeProgress(jobId, `Searching Reddit for ${competitor}`);
  const found = await fetchSearch(ctx, competitor, { timeframe: "week" });
  let costUsd = found.costUsd;
  const known = await knownMentionPosts(ctx.projectId, competitor);
  const fresh = [...found.value.posts]
    .filter((post) => !known.has(post.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MENTION_POSTS_PER_COMPETITOR);

  await writeProgress(jobId, `Reading ${fresh.length} posts about ${competitor}`);
  // Opened together, as a scan opens its shortlist, and kept newest first, the
  // order `fresh` holds, however the posts come back. A post Reddit will not
  // hand back is judged on the text the search carried, so one failure costs
  // that post its full text rather than stranding the posts beside it.
  const opened = await inFlight(fresh, async (post) => {
    try {
      const result = await fetchPost(ctx, post.url, RETENTION_MS);
      return { post: result.value[0] ?? post, costUsd: result.costUsd };
    } catch {
      return { post, costUsd: 0 };
    }
  });
  const full = opened.map((one) => one.post);
  costUsd += opened.reduce((sum, one) => sum + one.costUsd, 0);
  if (full.length === 0) {
    return { read: 0, mentions: 0, skipped: 0, costUsd };
  }
  const verdicts = await classifyMentions(ctx.projectId, competitor, full.map(toCandidate));
  const kept = keepMentions(verdicts);
  const mentions = await writeMentions(ctx.projectId, competitor, full, kept);
  return { read: full.length, mentions, skipped: verdicts.size - kept.size, costUsd };
}

/**
 * One pass over the competitors a project watches: this week's newest Reddit
 * posts naming each, read in full, then judged in one call per competitor. Only
 * a post about the competitor is stored, and the rest are counted as skipped.
 * Every pass books the next on the way out, at its tier's scan interval.
 */
export async function runCompetitorScan(
  projectId: string,
  jobId: string,
): Promise<CompetitorScanOutcome> {
  const project = await requireScanProject(projectId);
  const { limits, settings } = await tierForUser(project.userId);
  const cadence = cadenceFor(settings.settings.cadence);
  // The tier decides how many competitors a project may watch.
  const names = capped(project.competitors, limits?.competitors);
  if (names.length === 0) {
    await writeProgress(jobId, "No competitors to watch yet");
    // The next pass is booked all the same. Without one waiting, every boot
    // found a project that had run this kind and had nothing queued, and ran it
    // again: five projects, twelve empty passes each, on 2026-09-19. A pass
    // that finds no competitor buys nothing, and this one finds any added since.
    await enqueueJob("competitor_scan", projectId, cadence.nextRunAt(new Date()));
    return { competitors: 0, read: 0, mentions: 0, skipped: 0, costUsd: 0 };
  }
  const ctx: FetchContext = {
    projectId,
    funded: await clientForUser(project.userId),
    maxAgeMs: cadence.intervalHours() * HOUR_MS,
  };
  const outcome: CompetitorScanOutcome = {
    competitors: names.length,
    read: 0,
    mentions: 0,
    skipped: 0,
    costUsd: 0,
  };
  // One competitor at a time: its own posts already fill the job's share of
  // Reddit calls, and each writes progress lines of its own.
  for (const name of names) {
    const one = await scanOne(ctx, jobId, name);
    outcome.read += one.read;
    outcome.mentions += one.mentions;
    outcome.skipped += one.skipped;
    outcome.costUsd += one.costUsd;
  }
  await writeProgress(jobId, "Finished");
  await enqueueJob("competitor_scan", projectId, cadence.nextRunAt(new Date()));
  return outcome;
}
