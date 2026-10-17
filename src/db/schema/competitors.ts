import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { redditComments, redditPosts } from "./shared";
import { projects } from "./tenant";

/**
 * One place Reddit named a competitor this project tracks. A mention the
 * competitor scan found by searching the name is a post, with what the language
 * model made of it. A mention found inside a thread this project already reads,
 * a lead's or a ranking SEO thread's, is the post or one of its replies, with
 * the sentence that named the competitor and no sentiment. Per tenant, because
 * the competitor list is per project; the post and the reply stay shared.
 */
export const competitorMentions = pgTable(
  "competitor_mentions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    competitor: text("competitor").notNull(),
    postId: text("post_id")
      .notNull()
      .references(() => redditPosts.id, { onDelete: "cascade" }),
    /** Null for a mention found in a thread the project reads, never judged. */
    commentId: text("comment_id").references(() => redditComments.id, { onDelete: "cascade" }),
    sentiment: text("sentiment"),
    summary: text("summary"),
    /** The sentence of the post or reply that named the competitor. */
    quote: text("quote"),
    reasonCategory: text("reason_category"),
    switchingEvidence: text("switching_evidence"),
    explanation: text("explanation"),
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("competitor_mentions_project_found_at_idx").on(t.projectId, t.foundAt),
    index("competitor_mentions_post_idx").on(t.postId),
    index("competitor_mentions_comment_idx").on(t.commentId),
    uniqueIndex("competitor_mentions_project_competitor_post_idx")
      .on(t.projectId, t.competitor, t.postId)
      .where(sql`comment_id is null`),
    uniqueIndex("competitor_mentions_project_competitor_comment_idx")
      .on(t.projectId, t.competitor, t.commentId)
      .where(sql`comment_id is not null`),
  ],
);
