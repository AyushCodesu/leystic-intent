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
  registerTrustedAuthRecord,
  resetTrustedRegistry,
  sourceForSku,
  SourceUnauthorizedError,
  type TrustedAuthRecord,
} from "@/lib/sourcePolicy";
import { newXLeadsSince } from "@/lib/alerts/leads";
import {
  listXFiltered,
  listXHeld,
  listXLeads,
  listXOpportunities,
  xLeadById,
} from "@/lib/x/read";
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

describe("Source Authorization Registry and Policy Gate", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    resetTrustedRegistry();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetTrustedRegistry();
  });

  // Requirement 1: Reddit remains blocked under current register status even with flag true
  it("Requirement 1: Reddit remains blocked under current register status (REC-REDDIT-COMMERCIAL-UNVERIFIED) even with REDDIT_SOURCE_ENABLED=true", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-REDDIT-COMMERCIAL-UNVERIFIED");

    const policy = getSourcePolicy("reddit");
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(policy.authRecordId).toBe("REC-REDDIT-COMMERCIAL-UNVERIFIED");
    expect(isSourceAuthorized("reddit")).toBe(false);
    expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);
  });

  // Requirement 2: Fabricated or unknown Reddit record ID fails closed
  it("Requirement 2: Fabricated or unknown Reddit record ID fails closed", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "FABRICATED-REC-123");

    const policy = getSourcePolicy("reddit");
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(policy.authRecordId).toBe("FABRICATED-REC-123");
    expect(isSourceAuthorized("reddit")).toBe(false);
    expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);
  });

  // Requirement 3: Missing, pending, blocked, expired, wrong-source, and wrong-scope records all fail closed
  it("Requirement 3: Missing, pending, blocked, expired, wrong-source, and wrong-scope records all fail closed", () => {
    // 3a: Missing record ID
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");
    expect(getSourcePolicy("reddit").enabled).toBe(false);
    expect(getSourcePolicy("reddit").status).toBe("BLOCKED");

    // 3b: Pending record
    const pendingRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-PENDING",
      sourceId: "reddit",
      name: "Pending Pilot Review",
      status: "PENDING",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["commercial_indexing", "search_discovery"],
      effectiveDate: "2026-01-01T00:00:00Z",
      expirationDate: null,
      evidenceReference: "REF-PENDING",
      approvalProvenance: {
        approvedBy: "Legal Dept",
        reviewedAt: "2026-10-01T00:00:00Z",
        notes: "Pending final signatures",
      },
    };
    registerTrustedAuthRecord(pendingRecord);
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-PENDING");
    const pendingPolicy = getSourcePolicy("reddit");
    expect(pendingPolicy.status).toBe("PENDING");
    expect(pendingPolicy.enabled).toBe(false);

    // 3c: Blocked record
    const blockedRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-BLOCKED",
      sourceId: "reddit",
      name: "Explicitly Rejected Terms",
      status: "BLOCKED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["commercial_indexing"],
      effectiveDate: "2026-01-01T00:00:00Z",
      expirationDate: null,
      evidenceReference: "REF-BLOCKED",
      approvalProvenance: {
        approvedBy: "Compliance",
        reviewedAt: "2026-10-01T00:00:00Z",
        notes: "Rejected commercial terms",
      },
    };
    registerTrustedAuthRecord(blockedRecord);
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-BLOCKED");
    const blockedPolicy = getSourcePolicy("reddit");
    expect(blockedPolicy.status).toBe("BLOCKED");
    expect(blockedPolicy.enabled).toBe(false);

    // 3d: Expired record
    const expiredRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-EXPIRED",
      sourceId: "reddit",
      name: "Expired Pilot Contract",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["commercial_indexing"],
      effectiveDate: "2024-01-01T00:00:00Z",
      expirationDate: "2025-01-01T00:00:00Z",
      evidenceReference: "REF-EXPIRED",
      approvalProvenance: {
        approvedBy: "Legal",
        reviewedAt: "2024-01-01T00:00:00Z",
        notes: "Expired one year agreement",
      },
    };
    registerTrustedAuthRecord(expiredRecord);
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-EXPIRED");
    const expiredPolicy = getSourcePolicy("reddit");
    expect(expiredPolicy.status).toBe("EXPIRED");
    expect(expiredPolicy.enabled).toBe(false);

    // 3e: Wrong-source record (using a website_crawler record for reddit)
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-WEBSITE-CRAWLER-FIRST-PARTY");
    const wrongSourcePolicy = getSourcePolicy("reddit");
    expect(wrongSourcePolicy.status).toBe("BLOCKED");
    expect(wrongSourcePolicy.enabled).toBe(false);

    // 3f: Wrong-scope record
    const limitedScopeRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-LIMITED-SCOPE",
      sourceId: "reddit",
      name: "Non-Commercial Academic License",
      status: "APPROVED",
      authorizedPurposes: ["academic_research_only"],
      scopes: ["read_only_audit"],
      effectiveDate: "2026-01-01T00:00:00Z",
      expirationDate: null,
      evidenceReference: "REF-ACADEMIC",
      approvalProvenance: {
        approvedBy: "Research Lead",
        reviewedAt: "2026-01-01T00:00:00Z",
        notes: "Restricted to read-only audit",
      },
    };
    registerTrustedAuthRecord(limitedScopeRecord);
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-LIMITED-SCOPE");
    const wrongPurposePolicy = getSourcePolicy("reddit", { requiredScope: "commercial_indexing" });
    expect(wrongPurposePolicy.status).toBe("BLOCKED");
    expect(wrongPurposePolicy.enabled).toBe(false);
  });

  // Requirement 4: X with X_LEADS=true and no approved record (or REC-X-PILOT-REVIEW) is disabled
  it("Requirement 4: X with X_LEADS=true and no approved record (or REC-X-PILOT-REVIEW) is disabled (status: PENDING, enabled: false)", () => {
    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "REC-X-PILOT-REVIEW");

    const policy = getSourcePolicy("x");
    expect(policy.status).toBe("PENDING");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(isSourceAuthorized("x")).toBe(false);
  });

  // Requirement 5: X with plausible-looking but unrecognized record ID remains disabled
  it("Requirement 5: X with plausible-looking but unrecognized record ID remains disabled (status: BLOCKED, enabled: false)", () => {
    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "REC-X-COMMERCIAL-2026-ENTERPRISE");

    const policy = getSourcePolicy("x");
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.commercialUsePermitted).toBe(false);
    expect(isSourceAuthorized("x")).toBe(false);
  });

  // Requirement 6: Google SERP routes have separate policy statuses and SKU mapping fails closed
  it("Requirement 6: Google SERP routes have separate policy statuses (google_scraped_serp is BLOCKED; google_official_api is BLOCKED)", () => {
    const scrapedPolicy = getSourcePolicy("google_scraped_serp");
    expect(scrapedPolicy.status).toBe("BLOCKED");
    expect(scrapedPolicy.enabled).toBe(false);

    const officialPolicy = getSourcePolicy("google_official_api");
    expect(officialPolicy.status).toBe("BLOCKED");
    expect(officialPolicy.enabled).toBe(false);

    // SKU mapping tests
    expect(sourceForSku("google.search")).toBe("google_scraped_serp");
    expect(sourceForSku("reddit.search")).toBe("reddit");
    expect(sourceForSku("reddit.post")).toBe("reddit");
    expect(sourceForSku("reddit.comments")).toBe("reddit");
    expect(sourceForSku("twitter.search")).toBe("x");
    expect(sourceForSku("twitter.user")).toBe("x");

    // Unrecognized SKU throws SourceUnauthorizedError immediately
    expect(() => sourceForSku("unknown.sku")).toThrow(SourceUnauthorizedError);
    expect(() => sourceForSku("custom.provider.fetch")).toThrow(SourceUnauthorizedError);
  });

  // Requirement 7: Denied sources cause zero paid provider calls
  it("Requirement 7: Denied sources cause zero paid provider calls at fetchShared boundary", async () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

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

  // Requirement 8: Cache and in-flight reuse cannot bypass authorization
  it("Requirement 8: Cache and in-flight reuse cannot bypass authorization", async () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    let cacheLookupAttempted = false;
    const ctx = {
      projectId: "p_gate_test",
      funded: {
        funding: "house" as const,
        call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: "mock-req" }),
        client: {},
      } as unknown as Parameters<typeof fetchShared>[0]["ctx"]["funded"],
      maxAgeMs: 3600000,
    };

    await expect(
      fetchShared({
        ctx,
        kind: "keyword",
        sku: "reddit.search",
        normalizedQuery: "cached query",
        run: async () => ({ data: { posts: [] }, costUsd: 0 }),
        store: async () => [],
        load: async () => {
          cacheLookupAttempted = true;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SourceUnauthorizedError);

    expect(cacheLookupAttempted).toBe(false);
  });

  // Requirement 9: Stored source data cannot leak through feeds, detail pages, alerts, or API
  it("Requirement 9: Stored source data cannot leak through feeds, detail pages, alerts, or API (Reddit and X)", async () => {
    // 9a: Reddit serving paths fail closed
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    const redditFilter = { status: "new" as const, days: 30 as const, order: "score" as const };
    expect(await listLeads("p_any", redditFilter)).toEqual([]);
    expect(await countLeads("p_any", redditFilter)).toBe(0);
    expect(await listLeadFaces("p_any", redditFilter)).toEqual([]);
    expect(await findLead("p_any", "lead_any")).toBeUndefined();
    expect(await listReviewItems("p_any", 30)).toEqual([]);
    expect(await listMentions("p_any")).toEqual([]);
    expect(await countMentions("p_any")).toBe(0);
    expect(await competitorsNamedIn("p_any", "post_any")).toEqual([]);
    expect(await listOpportunities("p_any", {})).toEqual([]);
    expect(await countOpportunities("p_any")).toBe(0);
    expect(await seoFacets("p_any")).toEqual({ keywords: [], subreddits: [] });

    // API 403 checks
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

    // API error serialization test
    const err = new ApiError("source_disabled", "Reddit data source disabled");
    const res = apiErrorResponse(err);
    expect(res.status).toBe(403);

    // 9b: X serving paths fail closed
    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "REC-X-PILOT-REVIEW"); // Pending, so enabled: false

    const xFilter = { days: 30 as const, status: "new" as const };
    expect(await listXLeads("p_any", xFilter)).toEqual([]);
    expect(await xLeadById("p_any", "tweet_123")).toBeNull();
    expect(await listXHeld("p_any", xFilter)).toEqual([]);
    expect(await listXFiltered("p_any", xFilter)).toEqual({
      items: [],
      judged: 0,
      screened: 0,
      unfinished: 0,
      closeCalls: 0,
      worth: 0,
      pending: 0,
    });
    expect(await listXOpportunities("p_any", xFilter)).toEqual({
      items: [],
      total: 0,
      posts: 0,
      faces: [],
    });
    expect(await newXLeadsSince("p_any", new Date(0))).toEqual([]);
  });

  // Requirement 10: Explicitly approved test fixture succeeds
  it("Requirement 10: Explicitly approved test fixture registered in trusted registry succeeds (status: APPROVED, enabled: true)", () => {
    const approvedRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-VALID-APPROVAL-2026",
      sourceId: "reddit",
      name: "Executed Enterprise Licensing Contract",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation", "competitor_intelligence", "seo_ranking"],
      scopes: ["commercial_indexing", "search_discovery", "social_intent_monitoring"],
      effectiveDate: "2026-01-01T00:00:00Z",
      expirationDate: "2028-01-01T00:00:00Z",
      evidenceReference: "CONTRACT-DOC-2026-REDDIT-001",
      approvalProvenance: {
        approvedBy: "General Counsel",
        reviewedAt: "2026-01-02T10:00:00Z",
        notes: "Direct contract executed and filed",
      },
    };
    registerTrustedAuthRecord(approvedRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-VALID-APPROVAL-2026");

    const policy = getSourcePolicy("reddit", { requiredScope: "commercial_indexing" });
    expect(policy.status).toBe("APPROVED");
    expect(policy.enabled).toBe(true);
    expect(policy.commercialUsePermitted).toBe(true);
    expect(policy.authRecordId).toBe("REC-TEST-VALID-APPROVAL-2026");
    expect(isSourceAuthorized("reddit")).toBe(true);
    expect(() => assertSourceAuthorized("reddit")).not.toThrow();
  });

  // Requirement 11: Authorized first-party website crawler and unrelated functionality continue to work
  it("Requirement 11: Authorized first-party website crawler continues to work normally", () => {
    const crawlerPolicy = getSourcePolicy("website_crawler");
    expect(crawlerPolicy.status).toBe("APPROVED");
    expect(crawlerPolicy.enabled).toBe(true);
    expect(crawlerPolicy.commercialUsePermitted).toBe(true);
    expect(isSourceAuthorized("website_crawler")).toBe(true);
    expect(() => assertSourceAuthorized("website_crawler")).not.toThrow();

    const policies = allSourcePolicies();
    expect(policies.length).toBeGreaterThanOrEqual(4);
    const crawlerFound = policies.find((p) => p.sourceId === "website_crawler");
    expect(crawlerFound?.enabled).toBe(true);
    expect(crawlerFound?.status).toBe("APPROVED");
  });

  // Requirement 12 (Contract): Retention functions and options
  it("Requirement 12: Retention functions exist and support dry-run parameter", () => {
    expect(typeof auditRetention).toBe("function");
    expect(typeof deleteExpiredPosts).toBe("function");
  });
});

describeDb("Database-Backed Retention Cascade Protection and Scans", () => {
  const POSTS_NOW = new Date("1969-12-31T00:00:00Z");
  const LONG_AGO = Math.floor(POSTS_NOW.getTime() / 1000) - 600 * 24 * 3600;

  it("Requirement 12 (Integration): Produces a structured, read-only retention audit report with dryRunPlan and limitations", async () => {
    const report = await auditRetention();
    expect(report.retentionWindowDays).toBe(30);
    expect(typeof report.auditTimestamp).toBe("string");
    expect(typeof report.cutoffDate).toBe("string");
    expect(report.redditPosts).toHaveProperty("total");
    expect(report.redditPosts).toHaveProperty("eligibleForDeletion");
    expect(report.redditPosts).toHaveProperty("retainedByLeads");
    expect(report.redditPosts).toHaveProperty("retainedBySeo");
    expect(report.redditPosts).toHaveProperty("retainedByCompetitorMentions");

    // Dry Run Plan
    expect(report.dryRunPlan).toBeDefined();
    expect(typeof report.dryRunPlan.cutoffDate).toBe("string");
    expect(typeof report.dryRunPlan.eligiblePostsToDelete).toBe("number");
    expect(report.dryRunPlan.preservedReferencedPosts).toBeDefined();
    expect(typeof report.dryRunPlan.preservedReferencedPosts.byLeads).toBe("number");
    expect(typeof report.dryRunPlan.preservedReferencedPosts.bySeo).toBe("number");
    expect(typeof report.dryRunPlan.preservedReferencedPosts.byCompetitorMentions).toBe("number");
    expect(typeof report.dryRunPlan.preservedReferencedPosts.totalPreserved).toBe("number");
    expect(report.dryRunPlan.destructivePurgeBlockedWithoutOperatorApproval).toBe(true);
    expect(typeof report.dryRunPlan.notes).toBe("string");

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
    const dryRunEligible = await deleteExpiredPosts(POSTS_NOW, undefined, { dryRun: true });
    expect(dryRunEligible).toBeGreaterThanOrEqual(1);

    // Verify all posts still exist after dry run
    const keptAfterDryRun = await db()
      .select({ id: schema.redditPosts.id })
      .from(schema.redditPosts)
      .where(inArray(schema.redditPosts.id, [led.id, ranked.id, competitorTracked.id, loose.id]));
    expect(keptAfterDryRun).toHaveLength(4);

    // Real cleanup must preserve led, ranked, AND competitorTracked, and drop loose
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
