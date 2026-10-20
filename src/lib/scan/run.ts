import { enqueueJob, writeProgress } from "@/jobs/enqueue";
import { clientForUser } from "@/lib/anyapi";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchPost } from "@/lib/reddit/skus";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import { cadenceFor } from "@/lib/settings/cadence";
import { threadPolicyFor } from "@/lib/settings/threadPolicy";
import { tierForUser } from "@/lib/tier";
import { RETENTION_DAYS } from "@/lib/tiers";
import { writeThreadMentions } from "@/lib/competitors/threads";
import { inFlight } from "@/lib/inFlight";
import { judgeThreads, readLeadThreads } from "./comments";
import { retrievalBudgets } from "./constants";
import { loadEvaluations, writeEvaluations } from "./evaluations";
import {
  evaluationsFor,
  fetchAvatars,
  judgePosts,
  toLead,
  triagedOrder,
  unjudged,
} from "./judging";
import { demoteLeads, leadKey, markThreadsRead, threadsToRead, writeLeads } from "./leads";
import { requireScanProject } from "./project";
import { retrieve } from "./retrieve";
import { creditSources, markCovered, type CandidateSource } from "./sources";

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * 24 * HOUR_MS;

export type ScanOutcome = {
  candidates: number;
  read: number;
  leads: number;
  /** Windows this scan could not finish covering, said in plain words. */
  gaps: string[];
};

/**
 * One scan: run the retrieval plan, triage the titles, read the shortlist in
 * full, take the shared reading of each one, judge whatever that reading left,
 * and write what qualified. Only then are comment threads read, once per
 * lead and again only when the reply count moves, for two purposes: naming
 * the competitors being recommended in the thread, and finding the other
 * people in it who have a need of their own. Leads are already committed by
 * that point, so a thread we cannot read costs a scan nothing.
 */
export async function runScan(projectId: string, jobId: string): Promise<ScanOutcome> {
  const project = await requireScanProject(projectId);
  const { limits, settings } = await tierForUser(project.userId);
  const cadence = cadenceFor(settings.settings.cadence);
  const funded = await clientForUser(project.userId);
  const ctx: FetchContext = {
    projectId,
    funded,
    maxAgeMs: cadence.intervalHours() * HOUR_MS,
  };
  const windowMs = (limits?.feedWindowDays ?? RETENTION_DAYS) * 24 * HOUR_MS;
  const hydration = retrievalBudgets(limits).hydration;

  await writeProgress(jobId, "Looking for new posts");
  const stored = await loadEvaluations(projectId);
  const retrieval = await retrieve({
    project,
    ctx,
    limits,
    windowMs,
    intervalHours: cadence.intervalHours(),
    hydration,
  });
  const sourcesByPost = new Map<string, CandidateSource[]>(
    retrieval.candidates.map((candidate) => [candidate.post.id, candidate.sources]),
  );
  const candidates = await unjudged(
    project,
    stored,
    retrieval.candidates.map((candidate) => candidate.post),
  );

  await writeProgress(jobId, `Reading ${candidates.length} titles`);
  const ordered = await triagedOrder(projectId, project.product, candidates);
  const left = hydration === null ? candidates.length : Math.max(hydration - retrieval.hydrated, 0);
  /**
   * A post whose text a search already carried needs no `reddit.post` call, so
   * it is read for free and the hydration budget is spent only on the posts we
   * still have to open.
   */
  let budget = left;
  const shortlist = ordered.filter((post) => {
    if (post.bodyObservedAt) {
      return true;
    }
    if (budget === 0) {
      return false;
    }
    budget -= 1;
    return true;
  });
  const opening = shortlist.filter((post) => !post.bodyObservedAt);

  await writeProgress(jobId, `Opening ${opening.length} posts`);
  const full = await inFlight(shortlist, async (post) => {
    if (post.bodyObservedAt) {
      return post;
    }
    const result = await fetchPost(ctx, post.url, RETENTION_MS, {
      operation: ACQUISITION_OPERATIONS.lead_post,
    });
    return result.value[0] ?? post;
  });

  await writeProgress(jobId, `Checking who is asking in ${full.length} posts`);
  const unjudgedPosts = unjudged(project, stored, full);
  const judgements = await judgePosts(project, unjudgedPosts, [], (judging, read) =>
    writeProgress(jobId, `Scoring ${judging} of ${read} posts`),
  );
  const fullById = new Map(unjudgedPosts.map((post) => [post.id, post]));
  /**
   * Only a qualified judgement reaches the feed. The gates in gates.ts settled
   * that; the project's own minimum score is applied when the feed is read, so
   * moving it never has to mean scanning again.
   */
  const postLeads = judgements
    .filter((judgement) => judgement.decision === "qualify")
    .map((judgement) => toLead(project, judgement, judgement.id, null));
  await writeLeads(postLeads);
  /**
   * A post this run judged again and no longer routes anywhere loses its lead.
   * The feed is what the current verdict says, so a lead a profile edit turned
   * into a review belongs in the held pile, not in front of a person as a
   * buyer we no longer believe in.
   */
  const kept = new Set(postLeads.map((lead) => lead.postId));
  await demoteLeads(
    projectId,
    judgements
      .filter((judgement) => !kept.has(judgement.id))
      .map((judgement) => ({ postId: judgement.id, commentId: null })),
  );
  /**
   * The verdicts are recorded only once the feed agrees with them. A stored
   * verdict is what stops a post being judged again, so a scan that died with
   * the verdict written and the lead not would never offer that lead again;
   * this way round it costs one repeated judgement instead.
   */
  await writeEvaluations(evaluationsFor(project, unjudgedPosts, judgements));
  await markCovered(retrieval.covered);

  await writeProgress(jobId, "Reading comment threads");
  const threadPosts = await threadsToRead(projectId, threadPolicyFor(settings.settings.threads));
  const threads = await readLeadThreads(ctx, threadPosts);
  await writeThreadMentions(projectId, project.competitors, threads);
  const judged = await judgeThreads(project, threads, stored);
  const askers = judged.discovery.filter((item) => item.judgement.decision === "qualify");
  const commentLeads = askers.map((item) =>
    toLead(project, item.judgement, item.postId, item.comment.id),
  );
  await writeLeads(commentLeads);
  await writeEvaluations(judged.records);
  await markThreadsRead(
    projectId,
    threads.map((thread) => thread.post),
  );
  const committed = new Set(
    [...postLeads, ...commentLeads].map((lead) => leadKey(lead.postId, lead.commentId)),
  );

  await writeProgress(jobId, "Looking up who posted");
  await fetchAvatars(ctx, [
    ...postLeads.map((lead) => fullById.get(lead.postId)?.author ?? ""),
    ...askers.map((item) => item.comment.author ?? ""),
  ]);

  await creditSources(
    sourcesByPost,
    unjudgedPosts.map((post) => post.id),
    postLeads.map((lead) => lead.postId),
  );

  await writeProgress(
    jobId,
    retrieval.gaps.length === 0 ? "Finished" : `Finished. ${retrieval.gaps.join(" ")}`,
  );
  await enqueueJob("scan", projectId, cadence.nextRunAt(new Date()));
  return {
    candidates: candidates.length,
    read: full.length,
    leads: committed.size,
    gaps: retrieval.gaps,
  };
}
