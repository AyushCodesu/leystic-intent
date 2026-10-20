import { eq } from "drizzle-orm";
import { db } from "@/db";
import { redditPosts } from "@/db/schema";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchPostComments } from "@/lib/reddit/skus";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import { commentsOfPosts, type StoredComment, type StoredPost } from "@/lib/reddit/store";
import { inFlight } from "@/lib/inFlight";
import {
  alreadyJudged,
  contentHash,
  type EvaluationRecord,
  type StoredJudgement,
} from "./evaluations";
import type { Judgement, ScorableItem } from "./judgement";
import { commentItem } from "./judging";
import { leadKey } from "./leads";
import type { ScanProject } from "./project";
import { judgeItems } from "./score";

/**
 * What a thread is read for: which competitors are being recommended in it,
 * and whether anyone else in it has a need of their own. One fetch serves
 * both. The competitor match is a string match over the customer's own list
 * and costs nothing; discovery spends one model call per new commenter.
 */

export type ThreadRead = { post: StoredPost; comments: StoredComment[] };

/**
 * Reads each thread, keeping the ones that answered, and records the reply
 * count the thread was read at so the next scan buys it again only once that
 * count has moved. A failure loses one thread and records nothing.
 */
async function readThreads(ctx: FetchContext, posts: StoredPost[]): Promise<ThreadRead[]> {
  const reads = await inFlight(posts, async (post): Promise<ThreadRead | null> => {
    try {
      const result = await fetchPostComments(ctx, post.id, post.url, {
        operation: ACQUISITION_OPERATIONS.lead_comments,
      });
      await db()
        .update(redditPosts)
        .set({ commentsReadCount: post.numComments ?? 0 })
        .where(eq(redditPosts.id, post.id));
      return { post, comments: result.value };
    } catch {
      return null;
    }
  });
  return reads.filter((read): read is ThreadRead => read !== null);
}

/**
 * Whether the stored comments are the thread as Reddit last reported it, so
 * reading them from the store misses nobody. A scan and the SEO refresh both
 * buy a thread's replies again only once this stops being true, so a thread
 * both hold is bought once between them.
 */
export function commentsAreCurrent(post: StoredPost): boolean {
  return post.commentsObservedAt !== null && (post.numComments ?? 0) === post.commentsReadCount;
}

/** Each post with whatever comments the store holds for it, in one query. */
export async function storedThreads(posts: StoredPost[]): Promise<ThreadRead[]> {
  const comments = await commentsOfPosts(posts.map((post) => post.id));
  return posts.map((post) => ({ post, comments: comments.get(post.id) ?? [] }));
}

/**
 * A project's own read of these threads. The ones `shouldBuy` picks are
 * bought, by default every thread whose stored comments are behind, and the
 * rest are read from the store for nothing, so a thread somebody else already
 * bought at this reply count costs this project nothing and it still has every
 * comment to judge. A thread whose purchase failed is left out.
 */
export async function readLeadThreads(
  ctx: FetchContext,
  posts: StoredPost[],
  shouldBuy: (post: StoredPost) => boolean = (post) => !commentsAreCurrent(post),
): Promise<ThreadRead[]> {
  const held = await storedThreads(posts.filter((post) => !shouldBuy(post)));
  const bought = await readThreads(ctx, posts.filter(shouldBuy));
  return [...held, ...bought];
}

/**
 * One buyer per author per thread, from the comments that answer the post. A
 * reply to another comment is answering that comment, and read against the
 * post alone it looks like a need it is not, so it is never judged; nor is a
 * comment whose parent the response did not give. A person who wrote four
 * comments is one opportunity, and the comment carrying the most of their own
 * words is the one with the evidence, so that is the one judged.
 */
export function representativeComments(thread: ThreadRead): StoredComment[] {
  const best = new Map<string, StoredComment>();
  for (const comment of thread.comments) {
    if (
      comment.parentId !== thread.post.id ||
      !comment.author ||
      comment.author === thread.post.author ||
      !comment.body
    ) {
      continue;
    }
    const held = best.get(comment.author);
    if (!held || (held.body ?? "").length < comment.body.length) {
      best.set(comment.author, comment);
    }
  }
  return [...best.values()];
}

export type ThreadJudgements = {
  discovery: { postId: string; comment: StoredComment; judgement: Judgement }[];
  records: EvaluationRecord[];
};

const EMPTY: ThreadJudgements = { discovery: [], records: [] };

/**
 * Judges every other participant's own need. A comment whose text and product
 * profile have not changed is skipped.
 *
 * A comment is judged once per scan however many threads carry it. Two threads
 * can carry one comment: a comment keeps the post it was first stored under, so
 * an upstream that answers a crosspost with the original thread's replies hands
 * the same comment back under a second post. Judging it twice would spend a
 * second model call on the same text and give one comment two verdicts, which
 * is one row too many for the verdict a project holds per comment.
 */
export async function judgeThreads(
  project: ScanProject,
  threads: ThreadRead[],
  stored: Map<string, StoredJudgement>,
): Promise<ThreadJudgements> {
  if (threads.length === 0) {
    return EMPTY;
  }
  const items: ScorableItem[] = [];
  const hashes = new Map<string, string>();
  const commentOf = new Map<string, { postId: string; comment: StoredComment }>();

  for (const thread of threads) {
    for (const comment of representativeComments(thread)) {
      const own = commentItem(thread.post, comment);
      const hash = contentHash([own.title, own.parentBody, own.body]);
      if (
        commentOf.has(comment.id) ||
        alreadyJudged(stored, leadKey(thread.post.id, comment.id), project.profileVersion, hash)
      ) {
        continue;
      }
      items.push(own);
      hashes.set(comment.id, hash);
      commentOf.set(comment.id, { postId: thread.post.id, comment });
    }
  }

  const discovered = await judgeItems(project.id, project.product, items);
  return {
    discovery: discovered.map((judgement) => ({
      postId: commentOf.get(judgement.id)?.postId as string,
      comment: commentOf.get(judgement.id)?.comment as StoredComment,
      judgement,
    })),
    records: discovered.map((judgement) => ({
      projectId: project.id,
      postId: commentOf.get(judgement.id)?.postId as string,
      commentId: judgement.id,
      judgement,
      profileVersion: project.profileVersion,
      contentHash: hashes.get(judgement.id) as string,
    })),
  };
}
