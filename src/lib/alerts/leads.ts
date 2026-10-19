import { and, eq, gte, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { leads, projects, redditAuthors, redditPosts, xLeads, xPosts, xProjects } from "@/db/schema";
import {
  ALERT_FLOOR_SQL,
  ALERT_SCORE_FLOOR,
  redditWordsWhere,
  X_FLOOR_SQL,
  xWordsWhere,
} from "@/lib/leadFilters";
import { LEAD_AUTHOR, LEAD_AUTHOR_JOIN, LEAD_BODY, LEAD_URL, NEED_AT, leadsBase } from "@/lib/leadSql";
import { redditLeadNotMuted, xLeadNotMuted } from "@/lib/mutes";
import { canonicalUrl, ownWords } from "@/lib/x/map";
import { headlineOf } from "@/lib/x/read";
import { isSourceAuthorized } from "@/lib/sourcePolicy";
import { FRESH_SLACK_MS, type SelectableLead } from "./select";

/**
 * Leads a project first found since a moment, with the author's face attached,
 * that pass the project's own word lists. Only what a message could carry is
 * read: a buyer at the project's alert floor, on a post or comment fresh for
 * the window. A quiet channel's window grows by the hour, and reading every new
 * lead in it, bodies and all, to drop most of them here was the cost of every
 * pass. `alertable` still applies the same rules, with the ordering and the
 * thread's own title, so a live send and a test agree.
 */
export async function newLeadsSince(projectId: string, since: Date): Promise<SelectableLead[]> {
  if (!isSourceAuthorized("reddit")) {
    return [];
  }
  const freshFrom = new Date(since.getTime() - FRESH_SLACK_MS);
  const rows = await leadsBase({
    id: leads.id,
    postId: redditPosts.id,
    score: leads.score,
    reason: leads.reason,
    matchedPhrase: leads.matchedPhrase,
    status: leads.status,
    kind: leads.kind,
    foundAt: leads.foundAt,
    title: redditPosts.title,
    body: LEAD_BODY,
    isComment: sql<boolean>`${leads.commentId} is not null`,
    numComments: redditPosts.numComments,
    url: LEAD_URL,
    subreddit: redditPosts.subreddit,
    author: LEAD_AUTHOR,
    avatarUrl: redditAuthors.avatarUrl,
    createdAt: NEED_AT,
    floor: ALERT_FLOOR_SQL.mapWith(Number),
  })
    .leftJoin(redditAuthors, LEAD_AUTHOR_JOIN)
    .where(
      and(
        eq(leads.projectId, projectId),
        eq(leads.status, "new"),
        eq(leads.kind, "buyer"),
        gte(leads.foundAt, since),
        sql`${leads.score} >= ${ALERT_FLOOR_SQL}`,
        sql`${NEED_AT} >= ${freshFrom.toISOString()}::timestamptz`,
        redditLeadNotMuted(),
        redditWordsWhere(),
      ),
    );
  return rows.map((row) => ({
    ...row,
    platform: "reddit" as const,
    createdAt: new Date(row.createdAt),
  }));
}

/**
 * The new buyer leads at the house floor, on a post or comment from `since` on,
 * of the project `projectId` names: the "new" an invite counts, and what a
 * project owed wider searches lacks. A from-and-where to select from; its
 * tables are unaliased, so it reads the same inside any query that names its
 * own project row under an alias.
 */
export function recentAlertableLeads(projectId: SQL, since: Date): SQL {
  if (!isSourceAuthorized("reddit")) {
    return sql`leads where false`;
  }
  return sql`leads
    join reddit_posts on reddit_posts.id = leads.post_id
    left join reddit_comments on reddit_comments.id = leads.comment_id
    where leads.project_id = ${projectId} and leads.kind = 'buyer' and leads.status = 'new'
      and leads.score >= ${ALERT_SCORE_FLOOR}
      and coalesce(reddit_comments.created_at, reddit_posts.created_at) >= ${since.toISOString()}::timestamptz`;
}

/** Whether the project holds any of those. */
export function recentAlertableLeadSql(projectId: SQL, since: Date): SQL {
  return sql`exists (select 1 from ${recentAlertableLeads(projectId, since)})`;
}

/**
 * One X ask as the digest reads it: headed the way the X tab heads it, quoting
 * the post's own words, grouped by its conversation. The face is the one the
 * post was fetched with; x_authors holds no picture.
 */
export function xAskLead(
  lead: typeof xLeads.$inferSelect,
  post: typeof xPosts.$inferSelect,
  floor?: number,
): SelectableLead {
  return {
    id: lead.id,
    platform: "x",
    postId: lead.conversationId ?? post.conversationId ?? post.id,
    title: headlineOf(post.text, post.isReply, lead.matchedPhrase),
    url: canonicalUrl(post.authorUsername, post.id),
    subreddit: null,
    author: post.authorUsername,
    avatarUrl: post.authorImage,
    score: lead.score,
    reason: lead.reason,
    matchedPhrase: lead.matchedPhrase,
    body: ownWords(post),
    isComment: false,
    numComments: post.replyCount,
    createdAt: post.createdAt,
    status: lead.status,
    // `alertable` sends buyers only, and an ask is X's buyer.
    kind: "buyer",
    foundAt: lead.foundAt,
    floor,
  };
}

/**
 * The X asks a project first found since a moment. Replies are never alerted:
 * they are worth answering for about five hours, which a digest cannot keep.
 * A post X no longer shows is left out, as the tab leaves it out.
 */
export async function newXLeadsSince(projectId: string, since: Date): Promise<SelectableLead[]> {
  const rows = await db()
    .select({ lead: xLeads, post: xPosts, floor: X_FLOOR_SQL.mapWith(Number) })
    .from(xLeads)
    .innerJoin(projects, eq(projects.id, xLeads.projectId))
    .innerJoin(xPosts, eq(xPosts.id, xLeads.tweetId))
    // The owner can keep X asks out of the project's channels (Settings, X).
    .leftJoin(xProjects, eq(xProjects.projectId, xLeads.projectId))
    .where(
      and(
        eq(xLeads.projectId, projectId),
        eq(xLeads.kind, "ask"),
        eq(xLeads.status, "new"),
        or(isNull(xProjects.alerts), eq(xProjects.alerts, true)),
        gte(xLeads.foundAt, since),
        isNull(xPosts.unavailableAt),
        xLeadNotMuted(),
        xWordsWhere(),
      ),
    );
  return rows.map(({ lead, post, floor }) => xAskLead(lead, post, floor));
}
