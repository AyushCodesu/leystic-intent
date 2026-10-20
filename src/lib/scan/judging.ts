import type { ProductFacts } from "@/lib/product";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchAuthorProfile } from "@/lib/reddit/skus";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import type { StoredComment, StoredPost } from "@/lib/reddit/store";
import { inFlight } from "@/lib/inFlight";
import { redditScore } from "@/lib/scoring/weights";
import {
  alreadyJudged,
  postHash,
  type EvaluationRecord,
  type StoredJudgement,
} from "./evaluations";
import { isSentinel } from "./evidence";
import type { Judgement, ScorableItem } from "./judgement";
import { leadKey, type LeadRow } from "./leads";
import type { ScanProject } from "./project";
import { readPosts, splitByReading } from "./reading";
import { judgeItems, readOrder, triageTitles } from "./score";

/**
 * How a post or a comment is judged, whoever is judging it: what the judge is
 * shown, which posts still need a verdict, the order titles are read in, the
 * reading and the judge themselves, and the rows a verdict turns into. A scan,
 * the first sweep, a rescore and the SEO refresh all judge this way, so they
 * share it from here rather than from the scan's own orchestrator.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A Reddit avatar changes rarely, so one lookup covers a whole month. */
const AUTHOR_MAX_AGE_MS = 30 * 24 * HOUR_MS;

export function toLead(
  project: ScanProject,
  judgement: Judgement,
  postId: string,
  commentId: string | null,
): LeadRow {
  return {
    projectId: project.id,
    postId,
    commentId,
    kind: "buyer",
    // The verdict's own score folds the default weights; the lead is ranked
    // by the ones this project's owner chose.
    score: redditScore(judgement, project.scoring),
    quality: judgement.quality,
    fit: judgement.fit,
    intent: judgement.intent,
    engagement: judgement.engagement,
    stage: judgement.stage,
    reason: judgement.reason,
    matchedPhrase: judgement.matchedPhrase,
  };
}

export function postItem(post: StoredPost): ScorableItem {
  return {
    id: post.id,
    title: post.title,
    subreddit: post.subreddit,
    body: post.body ?? "",
    author: post.author,
    ageHours: (Date.now() - post.createdAt.getTime()) / HOUR_MS,
    upvotes: post.score,
    numComments: post.numComments,
    parentBody: null,
  };
}

/**
 * A comment as the judge reads it: its author's own words, with the post it
 * answers for context. A scan judges the people in a lead's thread this way,
 * and a rescore judges a stored comment verdict again the same way.
 */
export function commentItem(post: StoredPost, comment: StoredComment): ScorableItem {
  return {
    id: comment.id,
    title: post.title,
    subreddit: post.subreddit,
    body: comment.body ?? "",
    author: comment.author,
    ageHours: (Date.now() - comment.createdAt.getTime()) / HOUR_MS,
    upvotes: comment.score,
    numComments: post.numComments,
    parentBody: post.body ?? "",
  };
}

/**
 * Faces for the feed, bought once a month per author. A failure here is not a
 * failed scan: the card falls back to the author's initials.
 */
export async function fetchAvatars(ctx: FetchContext, usernames: string[]): Promise<void> {
  await inFlight([...new Set(usernames.filter(Boolean))], async (username) => {
    try {
      await fetchAuthorProfile(ctx, username, AUTHOR_MAX_AGE_MS, {
        operation: ACQUISITION_OPERATIONS.lead_profile,
      });
    } catch {
      // An avatar is decoration; the lead is already written.
    }
  });
}

/**
 * The posts this project has no current verdict on, given what it has read. A
 * post Reddit has taken away is dropped here, before a title is triaged or a
 * body is bought: there is nothing left to read and nobody left to answer.
 */
export function unjudged(
  project: ScanProject,
  stored: Map<string, StoredJudgement>,
  posts: StoredPost[],
): StoredPost[] {
  return posts.filter(
    (post) =>
      !isSentinel(post) &&
      !alreadyJudged(
        stored,
        leadKey(post.id, null),
        project.profileVersion,
        postHash(post.title, post.body),
      ),
  );
}

export function evaluationsFor(
  project: ScanProject,
  posts: StoredPost[],
  judgements: Judgement[],
): EvaluationRecord[] {
  const byId = new Map(posts.map((post) => [post.id, post]));
  return judgements.map((judgement) => {
    const post = byId.get(judgement.id) as StoredPost;
    return {
      projectId: project.id,
      postId: post.id,
      commentId: null,
      judgement,
      profileVersion: project.profileVersion,
      contentHash: postHash(post.title, post.body),
    };
  });
}

/**
 * The posts worth reading, best first: every title triaged against the
 * product, then put in readOrder's one order over all of them. A title the
 * triage rates less likely to be asking than `floor` is left out; a scan keeps
 * every one the triage did not reject, and a first sweep, which finds far more
 * than it can afford to score, sets its own floor.
 */
export async function triagedOrder(
  projectId: string,
  product: ProductFacts,
  posts: StoredPost[],
  floor = 0,
): Promise<StoredPost[]> {
  const now = Date.now();
  const ageHours = (post: StoredPost) => (now - post.createdAt.getTime()) / HOUR_MS;
  const triage = await triageTitles(
    projectId,
    product,
    posts.map((post) => ({
      id: post.id,
      title: post.title,
      subreddit: post.subreddit,
      author: post.author,
      score: post.score,
      ageHours: ageHours(post),
    })),
  );
  const byId = new Map(posts.map((post) => [post.id, post]));
  const facts = new Map(
    posts.map((post) => [post.id, { ageHours: ageHours(post), upvotes: post.score }]),
  );
  return readOrder(
    triage.filter((item) => item.asking >= floor),
    facts,
  )
    .map((id) => byId.get(id))
    .filter((post): post is StoredPost => post !== undefined);
}

/**
 * Judges posts the way a scan does: the shared, product-agnostic reading
 * first, then the judge on whatever that reading left. Items no reading covers
 * can ride in the same judge call as `extra`, which is how a rescore judges its
 * stored comment verdicts again. `onRead` hears how many of the posts reached
 * the judge, once the reading has decided.
 */
export async function judgePosts(
  project: ScanProject,
  posts: StoredPost[],
  extra: ScorableItem[] = [],
  onRead?: (judging: number, read: number) => Promise<void>,
): Promise<Judgement[]> {
  const sources = posts.map(postItem);
  const readings = await readPosts(project.id, sources);
  const { toJudge, cut } = splitByReading(sources, readings);
  await onRead?.(toJudge.length, sources.length);
  return [
    ...cut,
    ...(await judgeItems(project.id, project.product, [...toJudge, ...extra], readings)),
  ];
}
