import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { redditComments, redditPosts, searchRuns } from "./shared";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

/** Per-tenant judgement. Everything here belongs to one user or one project. */

export const users = pgTable("users", {
  id: id(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  /**
   * What this user changed about their scan settings, and only that: the
   * preset owns every value they have not touched. `lib/settings` is the one
   * reader and the one writer.
   */
  settings: jsonb("settings"),
  /**
   * When this person last opened the app, stamped at most every few minutes.
   * The queue reads it: a project nobody looks at and nothing alerts from has
   * its routine jobs held until somebody does (see jobs/runner.ts).
   */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const walletConnections = pgTable("wallet_connections", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url"),
  pain: text("pain"),
  solution: text("solution"),
  targetUsers: text("target_users"),
  geography: text("geography"),
  budgetFit: text("budget_fit"),
  scoreThreshold: integer("score_threshold"),
  /**
   * What the owner says matters most when leads are ranked: a level per
   * factor and the communities to favour (lib/scoring/weights.ts). Null means
   * they never chose, and every scorer keeps its own fold. Like the minimum
   * score it changes no verdict, so saving it re-ranks stored leads in place.
   */
  scoring: jsonb("scoring"),
  /**
   * The owner's own rules on top of the judge: words a lead must or must not
   * mention, and the least score an alert or an X ask needs. Read when leads
   * are read, never when they are scored (lib/leadFilters.ts).
   */
  leadFilters: jsonb("lead_filters"),
  /**
   * Bumped on every edit to the facts a judgement is made against. A stored
   * evaluation is only reusable for the version it was made under, so editing
   * the product makes the next scan judge everything again.
   */
  profileVersion: integer("profile_version").notNull().default(1),
  /** What the product can actually do, one short phrase each. */
  capabilities: jsonb("capabilities"),
  /** What it cannot do, does not cover, or refuses, one short phrase each. */
  exclusions: jsonb("exclusions"),
  /** Who is explicitly not a buyer, one short phrase each. */
  notBuyers: jsonb("not_buyers"),
  /** Places this product serves, each with the page text it was read from. */
  destinations: jsonb("destinations"),
  /** How buyers say the problem, in their words, taken from the product page. */
  problemPhrasings: jsonb("problem_phrasings"),
  /**
   * What the scan's judge reads to tell a buyer of this product from someone
   * asking for its neighbour: the product's precise kind, the kinds it is not,
   * who pays and who only talks, and example asks on both sides of the line.
   * Unlike the facts above it may say what the site does not, so it is kept
   * apart from them and never shown as the profile (lib/brief.ts).
   */
  brief: jsonb("brief"),
  /** The profile version the brief was written against. Behind the profile means it is owed again. */
  briefProfileVersion: integer("brief_profile_version"),
  /**
   * When the first discovery finished and the project's own jobs were queued.
   * Null means the project has been read but not yet set up, so the initial
   * discovery still owes it a plan. It is written in the same transaction as
   * those first jobs, so a crash between the two can never leave a project
   * that looks finished and has nothing queued.
   */
  discoveredAt: timestamp("discovered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What every row of the retrieval plan carries: where it came from (llm, serp,
 * user), whether it is being retrieved (active, pinned, excluded, candidate),
 * how much discovery evidence stands behind it, when its window was last
 * covered, and what it has actually produced since. A model guess and a
 * measured community are the same shape, so ranking can compare them.
 */
const planColumns = () => ({
  source: text("source").notNull().default("llm"),
  state: text("state").notNull().default("active"),
  evidence: integer("evidence").notNull().default(0),
  lastCoveredAt: timestamp("last_covered_at", { withTimezone: true }),
  freshCandidates: integer("fresh_candidates").notNull().default(0),
  freshLeads: integer("fresh_leads").notNull().default(0),
});

export const projectKeywords = pgTable(
  "project_keywords",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    ...planColumns(),
  },
  (t) => [uniqueIndex("project_keywords_project_keyword_idx").on(t.projectId, t.keyword)],
);

export const projectSubreddits = pgTable(
  "project_subreddits",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ...planColumns(),
  },
  (t) => [uniqueIndex("project_subreddits_project_name_idx").on(t.projectId, t.name)],
);

export const projectCompetitors = pgTable(
  "project_competitors",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The site this company sells from, which is where its logo comes from.
     * Null when nothing we read told us, and then the name wears its initials
     * rather than a favicon guessed off the spelling.
     */
    domain: text("domain"),
    /** What this company is to us: direct substitute, alternative, supplier, reference. */
    role: text("role"),
    ...planColumns(),
  },
  (t) => [uniqueIndex("project_competitors_project_name_idx").on(t.projectId, t.name)],
);

/**
 * One Google result that told us where and how this project's buyers ask. The
 * plan is derived from these rows, so a community or a phrase can always be
 * traced back to the thread that argued for it. The post id is Reddit's, not a
 * reddit_posts row: evidence is recorded before any thread is bought.
 */
export const discoveryEvidence = pgTable(
  "discovery_evidence",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: text("post_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    subreddit: text("subreddit").notNull(),
    query: text("query").notNull(),
    family: text("family"),
    destination: text("destination"),
    position: integer("position"),
    title: text("title"),
    snippet: text("snippet"),
    relevance: text("relevance").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("discovery_evidence_project_post_query_idx").on(t.projectId, t.postId, t.query),
    index("discovery_evidence_project_subreddit_idx").on(t.projectId, t.subreddit),
  ],
);

/**
 * Where a candidate came from, one row per way we found it. The same post can
 * arrive from a keyword search, a scoped search, a listing and Google, and the
 * per-source counters are only honest if every one of those is recorded.
 */
export const candidateSources = pgTable(
  "candidate_sources",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: text("post_id")
      .notNull()
      .references(() => redditPosts.id, { onDelete: "cascade" }),
    /** search, scoped, listing or serp. */
    sourceKind: text("source_kind").notNull(),
    /** The query, community or keyword that produced it. */
    sourceKey: text("source_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("candidate_sources_project_post_source_idx").on(
      t.projectId,
      t.postId,
      t.sourceKind,
      t.sourceKey,
    ),
    index("candidate_sources_post_idx").on(t.postId),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: text("post_id").references(() => redditPosts.id, { onDelete: "cascade" }),
    commentId: text("comment_id").references(() => redditComments.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    /**
     * The lead model's verdict, 0-1 with its threshold at 0.5, kept so the
     * owner's ranking weights can re-rank the lead without judging it again.
     */
    quality: doublePrecision("quality"),
    fit: integer("fit"),
    intent: integer("intent"),
    engagement: integer("engagement"),
    stage: text("stage"),
    reason: text("reason"),
    matchedPhrase: text("matched_phrase"),
    /**
     * What this lead is for: `buyer` is someone asking for what the product
     * does, `context` is a thread where nobody asks but a comment belongs.
     */
    kind: text("kind").notNull().default("buyer"),
    status: text("status").notNull().default("new"),
    notFitReason: text("not_fit_reason"),
    /**
     * User-confirmed business outcome: 'replied' | 'meeting_booked' | 'opportunity' | 'customer' | 'not_fit'.
     */
    outcome: text("outcome"),
    outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }),
    outcomeNotes: text("outcome_notes"),
    /**
     * The reply count this project last read the post's thread at. The shared
     * `reddit_posts.comments_read_count` says when the thread was last bought;
     * this says when this project last judged it, which one project's purchase
     * must never settle for another.
     */
    threadReadCount: integer("thread_read_count"),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the project first held this lead. A rescore moves `scoredAt` and
     * never this, so an alert window on it carries each lead exactly once.
     */
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("leads_project_score_idx").on(t.projectId, t.score.desc()),
    index("leads_project_kind_idx").on(t.projectId, t.kind),
    index("leads_post_idx").on(t.postId),
    index("leads_comment_idx").on(t.commentId),
    uniqueIndex("leads_project_post_idx")
      .on(t.projectId, t.postId)
      .where(sql`${t.commentId} is null`),
    uniqueIndex("leads_project_comment_idx")
      .on(t.projectId, t.commentId)
      .where(sql`${t.commentId} is not null`),
  ],
);

/**
 * Every candidate this project has judged, whatever the verdict. The leads
 * table holds only what qualified, so without this a rejection was forgotten
 * and bought again on the next scan, and a review was invisible.
 */
export const leadEvaluations = pgTable(
  "lead_evaluations",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: text("post_id")
      .notNull()
      .references(() => redditPosts.id, { onDelete: "cascade" }),
    commentId: text("comment_id").references(() => redditComments.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    relationship: text("relationship").notNull(),
    needState: text("need_state").notNull(),
    fit: integer("fit"),
    intent: integer("intent"),
    engagement: integer("engagement").notNull(),
    score: integer("score").notNull(),
    reasonCodes: text("reason_codes").array().notNull(),
    evidenceQuote: text("evidence_quote"),
    reason: text("reason").notNull(),
    /** The project profile version and the text hash this verdict was made on. */
    profileVersion: integer("profile_version").notNull(),
    contentHash: text("content_hash").notNull(),
    scorerVersion: text("scorer_version").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_evaluations_project_post_idx")
      .on(t.projectId, t.postId)
      .where(sql`${t.commentId} is null`),
    uniqueIndex("lead_evaluations_project_comment_idx")
      .on(t.projectId, t.commentId)
      .where(sql`${t.commentId} is not null`),
    index("lead_evaluations_project_decision_idx").on(t.projectId, t.decision),
    index("lead_evaluations_post_idx").on(t.postId),
    index("lead_evaluations_comment_idx").on(t.commentId),
  ],
);

export const seoOpportunities = pgTable(
  "seo_opportunities",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    postId: text("post_id").references(() => redditPosts.id, { onDelete: "set null" }),
    position: integer("position"),
    competitorPresent: boolean("competitor_present").notNull().default(false),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("seo_opportunities_post_idx").on(t.postId),
    index("seo_opportunities_project_keyword_idx").on(t.projectId, t.keyword),
  ],
);

export const painThemes = pgTable("pain_themes", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  summary: text("summary"),
  leadIds: text("lead_ids").array(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  target: text("target").notNull(),
  /** How the list names the target when the address itself is a secret, as a Slack webhook is. */
  label: text("label"),
  cadence: text("cadence").notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
});

/**
 * A thread the owner has answered. Every lead in it, the ones held now and any
 * found in it later, is `replied`, so neither the feed nor an alert channel
 * brings the conversation back. Kept per thread rather than per lead because a
 * reply found there next week is the conversation the owner already joined.
 * `thread_id` is the Reddit post id, or the X conversation id.
 */
export const handledThreads = pgTable(
  "handled_threads",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** reddit or x. */
    platform: text("platform").notNull(),
    threadId: text("thread_id").notNull(),
    handledAt: timestamp("handled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("handled_threads_project_thread_idx").on(t.projectId, t.platform, t.threadId)],
);

/**
 * A word, a phrase or a whole community the owner does not want leads from.
 * Applied wherever leads are read (the feed, every alert channel, X) and never
 * written into the leads, so taking a mute off brings everything back as it was.
 * `value` is stored the way `muteValue` writes it: a keyword as lowercase words
 * split by single spaces, a subreddit lowercase without its r/.
 */
export const leadMutes = pgTable(
  "lead_mutes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** keyword or subreddit. */
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lead_mutes_project_kind_value_idx").on(t.projectId, t.kind, t.value)],
);

export const apiKeys = pgTable("api_keys", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hash: text("hash").notNull().unique(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  scopes: text("scopes").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    requestId: text("request_id"),
    searchRunId: text("search_run_id").references(() => searchRuns.id, { onDelete: "set null" }),
    /** Who paid, so a call with no shared run still counts against the cap. */
    fundedBy: text("funded_by").notNull().default("house"),
    reused: boolean("reused").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_ledger_project_at_idx").on(t.projectId, t.at),
    // The house's spend today, as search_runs_funded_by_fetched_at_idx is.
    index("usage_ledger_funded_by_at_idx").on(t.fundedBy, t.at),
    index("usage_ledger_search_run_idx").on(t.searchRunId),
  ],
);

/**
 * Every language model call this instance made: what it cost, how long it took,
 * who served it, and whether it answered. The daily cap reads the cost, and the
 * rest is kept so a question about a bad verdict is answered from a table
 * instead of by running the scan again.
 *
 * The columns after `cost_usd` are null on a row written before 2026-09-13,
 * because those calls really did record nothing else. `schema_failed` is the
 * exception: a failed call used to write no row at all, so false is exactly
 * right for every old one.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: id(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    /** The model asked for, and the upstream OpenRouter routed the call to. */
    model: text("model"),
    provider: text("provider"),
    /** Wall time of the whole call, the retries inside the SDK included. */
    latencyMs: integer("latency_ms"),
    /** How many items a batched call asked for, and how many came back. */
    itemsAsked: integer("items_asked"),
    itemsAnswered: integer("items_answered"),
    finishReason: text("finish_reason"),
    /** True when the answer could not be read as the shape that was asked for. */
    schemaFailed: boolean("schema_failed").notNull().default(false),
    /** Reasoning tokens, where the provider reports them. Billed as output. */
    reasoningTokens: integer("reasoning_tokens"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_usage_at_idx").on(t.at),
    index("llm_usage_project_purpose_at_idx").on(t.projectId, t.purpose, t.at),
  ],
);

/**
 * The queue. A finished row is kept for a month, and the newest of each kind
 * for each project for good, since what a project last ran is shown on its
 * pages (see pruneFinishedJobs).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    progress: text("progress"),
    error: text("error"),
  },
  (t) => [
    index("jobs_project_kind_idx").on(t.projectId, t.kind),
    // What the claim reads on every pump: the jobs still to run, by when.
    index("jobs_unfinished_run_at_idx")
      .on(t.runAt)
      .where(sql`${t.finishedAt} is null`),
  ],
);

/**
 * Every paid action a user pressed: Scan now, a profile rebuild, a refresh.
 * The per-user allowance counts these, so one account looping a button runs
 * out of its own presses long before it can trip the house caps every other
 * user's scans share. Free's presses count for good, so rows are never pruned.
 */
export const userActions = pgTable(
  "user_actions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_actions_user_action_at_idx").on(t.userId, t.action, t.at)],
);

/**
 * A website inspection run for a project. Records root URL, status, and summary counts.
 * Preserves historical snapshots so failed crawls never destroy existing coverage data.
 */
export const websiteInspections = pgTable(
  "website_inspections",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    rootUrl: text("root_url").notNull(),
    status: text("status").notNull(), // "success" | "partial" | "failed"
    pagesFound: integer("pages_found").notNull().default(0),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    hasSitemap: boolean("has_sitemap").notNull().default(false),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("website_inspections_project_idx").on(t.projectId, t.startedAt.desc())],
);

/**
 * An inspected webpage belonging to a successful or partial website inspection snapshot.
 * Stores extracted metadata (title, description, canonical, h1, headings, path).
 */
export const websitePages = pgTable(
  "website_pages",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => websiteInspections.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title"),
    description: text("description"),
    h1: text("h1"),
    headings: text("headings").array(),
    path: text("path").notNull(),
    crawledAt: timestamp("crawled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("website_pages_project_idx").on(t.projectId),
    index("website_pages_inspection_idx").on(t.inspectionId),
  ],
);

/**
 * Founder-confirmed demand-to-page mappings.
 * Allows founders to confirm or refine automated candidate matches without altering lead records.
 */
export const demandPageConfirmations = pgTable(
  "demand_page_confirmations",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    demandGroupId: text("demand_group_id").notNull(),
    status: text("status").notNull(), // "confirmed_match" | "partial_match" | "confirmed_gap" | "unconfirmed"
    confirmedPageUrl: text("confirmed_page_url"),
    notes: text("notes"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("demand_page_confirmations_project_group_idx").on(
      t.projectId,
      t.demandGroupId,
    ),
  ],
);
