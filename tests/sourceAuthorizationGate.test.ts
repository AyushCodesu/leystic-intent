import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/auth";
import { lead, projectLeads, projectPainThemes, projectSeoOpportunities } from "@/lib/api/handlers";
import { ApiError, apiErrorResponse } from "@/lib/api/responses";
import { countMentions, competitorsNamedIn, listMentions } from "@/lib/competitors/read";
import { runCompetitorScan } from "@/lib/competitors/scan";
import { countLeads, findLead, listLeadFaces, listLeads, listReviewItems } from "@/lib/leads";
import { fetchShared } from "@/lib/reddit/fetch";
import { auditRetention, deleteExpiredPosts } from "@/lib/retention";
import { countOpportunities, listOpportunities, seoFacets } from "@/lib/seo/read";
import {
  allSourcePolicies,
  assertSourceAuthorized,
  getSourcePolicy,
  isSourceAuthorized,
  sourceForSku,
  SourceUnauthorizedError,
} from "@/lib/sourcePolicy";
import { TIERS } from "@/lib/tiers";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const caller = {
  user: {
    id: "u_gate_test",
    email: "test@example.com",
    createdAt: new Date(0),
    clerkUserId: "clerk_gate_test",
    settings: null,
    lastSeenAt: null,
  },
  keyId: "00000000-0000-0000-0000-000000000000",
  keyPrefix: "rl_sk_test",
  scopes: [],
  tier: "connected",
  limits: TIERS.connected,
  selfHosted: false,
} as unknown as ApiCaller;

describe("Source Authorization Policy", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed by default for Reddit commercial access", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    const policy = getSourcePolicy("reddit");
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(policy.authRecordId).toBeNull();
    expect(isSourceAuthorized("reddit")).toBe(false);
    expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);
  });

  it("fails closed when REDDIT_SOURCE_ENABLED is true but REDDIT_AUTH_RECORD_ID is missing or empty", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    const policy = getSourcePolicy("reddit");
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(isSourceAuthorized("reddit")).toBe(false);
    expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);
  });

  it("fails closed when REDDIT_AUTH_RECORD_ID is set to placeholder strings", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");

    const placeholders = ["none", "pending", "unverified", "todo", "test", "null", "false", "   "];
    for (const placeholder of placeholders) {
      vi.stubEnv("REDDIT_AUTH_RECORD_ID", placeholder);
      const policy = getSourcePolicy("reddit");
      expect(policy.status).toBe("BLOCKED");
      expect(policy.enabled).toBe(false);
      expect(policy.commercialUsePermitted).toBe(false);
      expect(isSourceAuthorized("reddit")).toBe(false);
      expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);
    }
  });

  it("approves Reddit access only when enabled with a non-placeholder authorization record id", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "AUTH-REC-2026-REDDIT-COMMERCIAL-01");

    const policy = getSourcePolicy("reddit");
    expect(policy.status).toBe("APPROVED");
    expect(policy.enabled).toBe(true);
    expect(policy.commercialUsePermitted).toBe(true);
    expect(policy.authRecordId).toBe("AUTH-REC-2026-REDDIT-COMMERCIAL-01");
    expect(isSourceAuthorized("reddit")).toBe(true);
    expect(() => assertSourceAuthorized("reddit")).not.toThrow();
  });

  it("tracks X authorization independently from Reddit", () => {
    vi.stubEnv("X_LEADS", "false");
    vi.stubEnv("X_AUTH_RECORD_ID", "");
    expect(getSourcePolicy("x").status).toBe("BLOCKED");
    expect(getSourcePolicy("x").enabled).toBe(false);

    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "");
    expect(getSourcePolicy("x").status).toBe("PENDING");
    expect(getSourcePolicy("x").enabled).toBe(true);

    vi.stubEnv("X_AUTH_RECORD_ID", "AUTH-REC-2026-X-ENTERPRISE-01");
    expect(getSourcePolicy("x").status).toBe("APPROVED");
    expect(getSourcePolicy("x").enabled).toBe(true);
    expect(getSourcePolicy("x").authRecordId).toBe("AUTH-REC-2026-X-ENTERPRISE-01");
  });

  it("approves first-party website crawler and search SERP queries", () => {
    expect(getSourcePolicy("website_crawler").status).toBe("APPROVED");
    expect(getSourcePolicy("website_crawler").enabled).toBe(true);

    expect(getSourcePolicy("google_serp").status).toBe("APPROVED");
    expect(getSourcePolicy("google_serp").enabled).toBe(true);
  });

  it("maps SKUs to their respective data sources correctly", () => {
    expect(sourceForSku("reddit.search")).toBe("reddit");
    expect(sourceForSku("reddit.post")).toBe("reddit");
    expect(sourceForSku("reddit.comments")).toBe("reddit");
    expect(sourceForSku("reddit.subreddit.new")).toBe("reddit");
    expect(sourceForSku("reddit.user.about")).toBe("reddit");

    expect(sourceForSku("twitter.search")).toBe("x");
    expect(sourceForSku("twitter.user")).toBe("x");

    expect(sourceForSku("google.search")).toBe("google_serp");
    expect(sourceForSku("custom.sku")).toBeNull();
  });

  it("reports all source policies in a unified register query", () => {
    const policies = allSourcePolicies();
    expect(policies).toHaveLength(4);
    const ids = policies.map((p) => p.sourceId);
    expect(ids).toEqual(["reddit", "x", "google_serp", "website_crawler"]);
  });
});

describe("Technical Gate at fetchShared Boundary", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks paid AnyAPI calls before network execution and before cache lookup", async () => {
    let anyApiCalled = false;
    const funded = {
      funding: "house" as const,
      call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: "mock-req" }),
      client: {
        reddit: {
          search: async () => {
            anyApiCalled = true;
            return { output: { found: true as const, data: { posts: [], nextCursor: null } }, costUsd: 0.0012 };
          },
        },
      },
    };

    const ctx = {
      projectId: "p_gate_test",
      funded: funded as unknown as Parameters<typeof fetchShared>[0]["ctx"]["funded"],
      maxAgeMs: 3600000,
    };

    await expect(
      fetchShared({
        ctx,
        kind: "keyword",
        sku: "reddit.search",
        normalizedQuery: "test query",
        run: async () => {
          anyApiCalled = true;
          return { data: { posts: [] }, costUsd: 0.0012 };
        },
        store: async () => [],
        load: async () => [],
      }),
    ).rejects.toBeInstanceOf(SourceUnauthorizedError);

    expect(anyApiCalled).toBe(false);
  });
});

describe("Serving Paths Fail Closed When Reddit Is Blocked", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty competitor intelligence without error", async () => {
    expect(await listMentions("p_any")).toEqual([]);
    expect(await countMentions("p_any")).toBe(0);
    expect(await competitorsNamedIn("p_any", "post_any")).toEqual([]);
  });

  it("returns empty lead feeds and lookups without querying database", async () => {
    const filter = { status: "new" as const, days: 30 as const, order: "score" as const };
    expect(await listLeads("p_any", filter)).toEqual([]);
    expect(await countLeads("p_any", filter)).toBe(0);
    expect(await listLeadFaces("p_any", filter)).toEqual([]);
    expect(await findLead("p_any", "lead_any")).toBeUndefined();
    expect(await listReviewItems("p_any", 30)).toEqual([]);
  });

  it("returns empty SEO opportunities and facets", async () => {
    expect(await listOpportunities("p_any", {})).toEqual([]);
    expect(await countOpportunities("p_any")).toBe(0);
    expect(await seoFacets("p_any")).toEqual({ keywords: [], subreddits: [] });
  });

  it("throws 403 source_disabled on API endpoints", async () => {
    await expect(projectLeads(caller, "p_any", new URLSearchParams())).rejects.toMatchObject({
      name: "ApiError",
      code: "source_disabled",
      status: 403,
    });

    await expect(lead(caller, "l_any")).rejects.toMatchObject({
      name: "ApiError",
      code: "source_disabled",
      status: 403,
    });

    await expect(projectSeoOpportunities(caller, "p_any")).rejects.toMatchObject({
      name: "ApiError",
      code: "source_disabled",
      status: 403,
    });

    await expect(projectPainThemes(caller, "p_any")).rejects.toMatchObject({
      name: "ApiError",
      code: "source_disabled",
      status: 403,
    });
  });

  it("serializes source_disabled ApiError into structured 403 response", () => {
    const err = new ApiError("source_disabled", "Reddit data source disabled");
    const res = apiErrorResponse(err);
    expect(res.status).toBe(403);
  });
});

describeDb("Database-Backed Retention Audit and Cascade Protection", () => {
  const POSTS_NOW = new Date("1969-12-31T00:00:00Z");
  const LONG_AGO = Math.floor(POSTS_NOW.getTime() / 1000) - 600 * 24 * 3600;

  it("produces a structured, read-only retention audit report with limitations", async () => {
    const report = await auditRetention();
    expect(report.retentionWindowDays).toBe(30);
    expect(typeof report.auditTimestamp).toBe("string");
    expect(typeof report.cutoffDate).toBe("string");
    expect(report.redditPosts).toHaveProperty("total");
    expect(report.redditPosts).toHaveProperty("eligibleForDeletion");
    expect(report.redditPosts).toHaveProperty("retainedByLeads");
    expect(report.redditPosts).toHaveProperty("retainedBySeo");
    expect(report.redditPosts).toHaveProperty("retainedByCompetitorMentions");
    expect(report.competitorMentions).toHaveProperty("total");
    expect(report.competitorMentions).toHaveProperty("onExpiredPosts");
    expect(report.searchRuns).toHaveProperty("total");
    expect(report.xData).toHaveProperty("totalPosts");
    expect(report.limitations.length).toBeGreaterThanOrEqual(5);
  });

  it("protects competitor mentions from deletion alongside leads and SEO opportunities", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { upsertPosts } = await import("@/lib/reddit/store");
    const { inArray } = await import("drizzle-orm");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "CascadeProtection" });

    const [led, ranked, competitorTracked, loose] = await upsertPosts(
      ["led", "ranked", "competitorTracked", "loose"].map((role) => ({
        id: `p${randomUUID().slice(0, 8)}`,
        subreddit: "SaaS",
        author: "author1",
        title: `Old post for ${role}`,
        body: "Testing retention cleanup cascades.",
        permalink: `/r/SaaS/comments/${role}/old/`,
        createdUtc: LONG_AGO,
      })),
    );

    await db()
      .insert(schema.leads)
      .values({ projectId: project.id, postId: led.id, score: 85 });

    await db()
      .insert(schema.seoOpportunities)
      .values({ projectId: project.id, keyword: "form tools", postId: ranked.id });

    await db()
      .insert(schema.competitorMentions)
      .values({
        projectId: project.id,
        competitor: "Formstack",
        postId: competitorTracked.id,
        sentiment: "negative",
        quote: "Formstack is way too expensive.",
      });

    // Dry run must delete nothing
    const dryRunDeleted = await deleteExpiredPosts(POSTS_NOW, undefined, { dryRun: true });
    expect(dryRunDeleted).toBe(0);

    // Real cleanup must preserve led, ranked, AND competitorTracked
    const actualDeleted = await deleteExpiredPosts(POSTS_NOW);
    expect(actualDeleted).toBeGreaterThanOrEqual(1);

    const kept = await db()
      .select({ id: schema.redditPosts.id })
      .from(schema.redditPosts)
      .where(inArray(schema.redditPosts.id, [led.id, ranked.id, competitorTracked.id, loose.id]));

    const keptIds = kept.map((row) => row.id).sort();
    expect(keptIds).toEqual([led.id, ranked.id, competitorTracked.id].sort());
    expect(keptIds).not.toContain(loose.id);
  });

  it("skips competitor scan job safely when Reddit source is unauthorized", async () => {
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    const user = await makeUser();
    const project = await makeProject(user.id, { name: "ScanSkipTest" });
    await db()
      .insert(schema.projectCompetitors)
      .values({ projectId: project.id, name: "CompetitorX" });

    const outcome = await runCompetitorScan(project.id, `job_${randomUUID()}`);
    expect(outcome.read).toBe(0);
    expect(outcome.mentions).toBe(0);
    expect(outcome.costUsd).toBe(0);
  });
});
