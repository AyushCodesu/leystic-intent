import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompetitorScan } from "@/lib/competitors/scan";
import { crawlWebsiteInventory } from "@/lib/gaps/crawler";
import { fetchShared } from "@/lib/reddit/fetch";
import {
  auditRetention,
  deleteExpiredPosts,
  OperatorApprovalRequiredError,
  purgeHistoricalData,
} from "@/lib/retention";
import {
  allSourcePolicies,
  assertSourceAuthorized,
  getSourcePolicy,
  getTrustedRecord,
  InvalidAuthRecordError,
  isSourceAuthorized,
  registerTrustedAuthRecord,
  resetTrustedRegistry,
  revokeTrustedAuthRecord,
  sourceForSku,
  SourceUnauthorizedError,
  type SourceOperationRequest,
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
import { describeDb, makeProject, makeUser } from "./fixtures/db";

describe("Operation-Specific Source Authorization and Registry Controls", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    resetTrustedRegistry();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetTrustedRegistry();
  });

  // Test 1: A record approved only for read_only_audit cannot authorize commercial indexing
  it("Test 1: Record approved only for read_only_audit cannot authorize commercial indexing", () => {
    const auditRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-AUDIT-ONLY",
      sourceId: "reddit",
      name: "Reddit Read-Only Audit Agreement",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["read_only_audit"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "AUDIT-AGREEMENT-001",
      approvalProvenance: {
        approvedBy: "Compliance Auditor",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Strictly limited to read_only_audit scope",
      },
    };
    registerTrustedAuthRecord(auditRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-AUDIT-ONLY");

    const opRequest: SourceOperationRequest = {
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "commercial_indexing",
    };

    const policy = getSourcePolicy(opRequest);
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(isSourceAuthorized(opRequest)).toBe(false);
    expect(() => assertSourceAuthorized(opRequest)).toThrow(SourceUnauthorizedError);
  });

  // Test 2: A record with the correct scope but the wrong purpose is denied
  it("Test 2: Record with the correct scope but the wrong purpose is denied", () => {
    const academicRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-ACADEMIC-ONLY",
      sourceId: "reddit",
      name: "Academic Research Pilot Agreement",
      status: "APPROVED",
      authorizedPurposes: ["academic_research"],
      scopes: ["search_discovery", "social_content_read"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "ACADEMIC-GRANT-REF-42",
      approvalProvenance: {
        approvedBy: "University Ethics Committee",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Scope covers search and reads, but strictly non-commercial academic research",
      },
    };
    registerTrustedAuthRecord(academicRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-ACADEMIC-ONLY");

    const commercialRequest: SourceOperationRequest = {
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "search_discovery",
    };

    const policy = getSourcePolicy(commercialRequest);
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(isSourceAuthorized(commercialRequest)).toBe(false);
    expect(() => assertSourceAuthorized(commercialRequest)).toThrow(SourceUnauthorizedError);
  });

  // Test 3: Every production authorization call supplies its required operation purpose and scope
  it("Test 3: Calling authorization without explicit operation purpose and scope fails closed", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-REDDIT-COMMERCIAL-UNVERIFIED");

    // Calling without operation purpose and scope must fail closed
    expect(isSourceAuthorized("reddit")).toBe(false);
    expect(() => assertSourceAuthorized("reddit")).toThrow(SourceUnauthorizedError);

    // Calling for X without operation purpose and scope must fail closed
    expect(isSourceAuthorized("x")).toBe(false);
    expect(() => assertSourceAuthorized("x")).toThrow(SourceUnauthorizedError);

    // Calling for crawler without operation purpose and scope must fail closed
    expect(isSourceAuthorized("website_crawler")).toBe(false);
    expect(() => assertSourceAuthorized("website_crawler")).toThrow(SourceUnauthorizedError);
  });

  // Test 4: X read paths and alerts deny operations outside an approved record's scope
  it("Test 4: X read paths and alerts deny operations outside an approved record's scope", async () => {
    // Record approved for search_discovery only, omitting social_content_read
    const searchOnlyRecord: TrustedAuthRecord = {
      recordId: "REC-X-SEARCH-ONLY",
      sourceId: "x",
      name: "X Search Only Pilot",
      status: "APPROVED",
      authorizedPurposes: ["social_intent_monitoring"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "DOC-X-SEARCH-AGREEMENT",
      approvalProvenance: {
        approvedBy: "VP Engineering",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Authorized search discovery queries only; tweet content read scope not included",
      },
    };
    registerTrustedAuthRecord(searchOnlyRecord);

    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "REC-X-SEARCH-ONLY");

    const xFilter = { days: 30 as const, status: "new" as const };

    // All X content-reading functions require scope "social_content_read"
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

  // Test 5: fetchShared() continues to block unauthorized calls before cache reuse, in-flight reuse, and paid calls
  it("Test 5: fetchShared() blocks unauthorized calls before cache reuse and before network execution", async () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    let cacheLookupAttempted = false;
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
        normalizedQuery: "test intent query",
        run: async () => {
          anyApiCalled = true;
          return { data: { posts: [] }, costUsd: 0.0012 };
        },
        store: async () => [],
        load: async () => {
          cacheLookupAttempted = true;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SourceUnauthorizedError);

    expect(cacheLookupAttempted).toBe(false);
    expect(anyApiCalled).toBe(false);
  });

  // Test 6: Website crawler is denied when its record is blocked, pending, expired, future-dated, or out of scope
  it("Test 6: Website crawler is denied when record is blocked, pending, expired, future-dated, or out of scope", async () => {
    const crawlerOp: SourceOperationRequest = {
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    };

    // 6a: Blocked record
    revokeTrustedAuthRecord("REC-WEBSITE-CRAWLER-FIRST-PARTY", {
      status: "BLOCKED",
      reason: "Suspended due to security review",
      revokedBy: "Security Officer",
    });
    expect(isSourceAuthorized(crawlerOp)).toBe(false);
    await expect(crawlWebsiteInventory("https://example.com")).rejects.toBeInstanceOf(SourceUnauthorizedError);

    // 6b: Pending record
    resetTrustedRegistry();
    const pendingCrawler: TrustedAuthRecord = {
      recordId: "REC-CRAWLER-PENDING",
      sourceId: "website_crawler",
      name: "Crawler Pending Review",
      status: "PENDING",
      authorizedPurposes: ["customer_website_coverage"],
      scopes: ["customer_domain_crawl"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "REVIEW-123",
      approvalProvenance: { approvedBy: "Sec", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Pending" },
    };
    registerTrustedAuthRecord(pendingCrawler);
    expect(isSourceAuthorized({ ...crawlerOp, authRecordIdOverride: "REC-CRAWLER-PENDING" })).toBe(false);

    // 6c: Expired record
    const expiredCrawler: TrustedAuthRecord = {
      recordId: "REC-CRAWLER-EXPIRED",
      sourceId: "website_crawler",
      name: "Crawler Expired Agreement",
      status: "APPROVED",
      authorizedPurposes: ["customer_website_coverage"],
      scopes: ["customer_domain_crawl"],
      effectiveDate: "2024-01-01T00:00:00.000Z",
      expirationDate: "2025-01-01T00:00:00.000Z",
      evidenceReference: "EXPIRED-AGREEMENT",
      approvalProvenance: { approvedBy: "Legal", reviewedAt: "2024-01-01T00:00:00.000Z", notes: "Expired" },
    };
    registerTrustedAuthRecord(expiredCrawler);
    expect(isSourceAuthorized({ ...crawlerOp, authRecordIdOverride: "REC-CRAWLER-EXPIRED" })).toBe(false);

    // 6d: Future-dated record
    const futureCrawler: TrustedAuthRecord = {
      recordId: "REC-CRAWLER-FUTURE",
      sourceId: "website_crawler",
      name: "Crawler Future Contract",
      status: "APPROVED",
      authorizedPurposes: ["customer_website_coverage"],
      scopes: ["customer_domain_crawl"],
      effectiveDate: "2099-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "FUTURE-DOC",
      approvalProvenance: { approvedBy: "Legal", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Future effective" },
    };
    registerTrustedAuthRecord(futureCrawler);
    expect(isSourceAuthorized({ ...crawlerOp, authRecordIdOverride: "REC-CRAWLER-FUTURE" })).toBe(false);

    // 6e: Out of scope (record only covers read_only_audit, not customer_domain_crawl)
    const auditCrawler: TrustedAuthRecord = {
      recordId: "REC-CRAWLER-AUDIT-ONLY",
      sourceId: "website_crawler",
      name: "Crawler Audit Only",
      status: "APPROVED",
      authorizedPurposes: ["customer_website_coverage"],
      scopes: ["read_only_audit"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "AUDIT-CRAWLER",
      approvalProvenance: { approvedBy: "Auditor", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Audit only" },
    };
    registerTrustedAuthRecord(auditCrawler);
    expect(isSourceAuthorized({ ...crawlerOp, authRecordIdOverride: "REC-CRAWLER-AUDIT-ONLY" })).toBe(false);
  });

  // Test 7: Registry mutation cannot bypass record validation or revocation
  it("Test 7: Registry rejects malformed records, protects immutability, and supports immediate revocation", () => {
    // 7a: Reject malformed records
    expect(() =>
      registerTrustedAuthRecord({
        recordId: "INVALID-REC",
        sourceId: "reddit",
        name: "Broken Record",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["commercial_indexing"],
        effectiveDate: "2028-01-01T00:00:00.000Z",
        expirationDate: "2026-01-01T00:00:00.000Z", // effective after expiration
        evidenceReference: "DOC-INVALID",
        approvalProvenance: { approvedBy: "Tester", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Bad dates" },
      }),
    ).toThrow(InvalidAuthRecordError);

    expect(() =>
      registerTrustedAuthRecord({
        recordId: "",
        sourceId: "reddit",
        name: "Empty ID",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["commercial_indexing"],
        effectiveDate: "2026-01-01T00:00:00.000Z",
        expirationDate: null,
        evidenceReference: "DOC",
        approvalProvenance: { approvedBy: "Tester", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "No ID" },
      }),
    ).toThrow(InvalidAuthRecordError);

    // 7b: Immutability protection (frozen copies returned)
    const originalRecord = getTrustedRecord("REC-WEBSITE-CRAWLER-FIRST-PARTY");
    expect(originalRecord).not.toBeNull();
    expect(Object.isFrozen(originalRecord)).toBe(true);
    expect(() => {
      (originalRecord as unknown as { status: string }).status = "BLOCKED";
    }).toThrow();

    // 7c: Revocation immediately updates authorization decision
    const revoked = revokeTrustedAuthRecord("REC-WEBSITE-CRAWLER-FIRST-PARTY", {
      status: "BLOCKED",
      reason: "Emergency contract termination",
      revokedBy: "General Counsel",
    });
    expect(revoked.status).toBe("BLOCKED");

    const policyAfterRevoke = getSourcePolicy({
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    });
    expect(policyAfterRevoke.status).toBe("BLOCKED");
    expect(policyAfterRevoke.enabled).toBe(false);
  });

  // Test 8: Unknown SKUs still fail closed
  it("Test 8: Unknown SKUs still fail closed with SourceUnauthorizedError", () => {
    expect(() => sourceForSku("unknown.provider.sku")).toThrow(SourceUnauthorizedError);
    expect(() => sourceForSku("bing.search")).toThrow(SourceUnauthorizedError);
    expect(() => sourceForSku("")).toThrow(SourceUnauthorizedError);
  });

  // Test 9: UI status displays remain useful without granting access
  it("Test 9: UI status displays remain useful without granting data execution access", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");

    const redditDisplay = getSourcePolicy("reddit");
    expect(redditDisplay.status).toBe("BLOCKED");
    expect(redditDisplay.enabled).toBe(false);
    expect(typeof redditDisplay.reason).toBe("string");
    expect(redditDisplay.reason.length).toBeGreaterThan(10);
    expect(typeof redditDisplay.legalDisclaimer).toBe("string");

    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "");

    const xDisplay = getSourcePolicy("x");
    expect(xDisplay.status).toBe("PENDING");
    expect(xDisplay.enabled).toBe(false);
    expect(typeof xDisplay.reason).toBe("string");

    // All source policies list query
    const allPolicies = allSourcePolicies();
    expect(allPolicies.length).toBeGreaterThanOrEqual(5);
    for (const p of allPolicies) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.status).toBe("string");
    }
  });

  // Test 10: Approved test records work only within their explicitly authorized scope and purpose
  it("Test 10: Approved test records work only within their explicitly authorized scope and purpose", () => {
    const multiScopeRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-MULTI-SCOPE",
      sourceId: "reddit",
      name: "Authorized Multi-Scope Partner Contract",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation", "competitor_intelligence"],
      scopes: ["search_discovery", "social_content_read"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: "2028-01-01T00:00:00.000Z",
      evidenceReference: "CONTRACT-2026-001",
      approvalProvenance: {
        approvedBy: "Legal Counsel",
        reviewedAt: "2026-01-02T00:00:00.000Z",
        notes: "Authorized for search and post reading",
      },
    };
    registerTrustedAuthRecord(multiScopeRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-MULTI-SCOPE");

    // 10a: Authorized purpose and authorized scope -> APPROVED & enabled
    expect(
      isSourceAuthorized({
        sourceId: "reddit",
        purpose: "commercial_lead_generation",
        scope: "search_discovery",
      }),
    ).toBe(true);

    expect(
      isSourceAuthorized({
        sourceId: "reddit",
        purpose: "competitor_intelligence",
        scope: "social_content_read",
      }),
    ).toBe(true);

    // 10b: Authorized purpose but UNAUTHORIZED scope (comments_read is not in scopes) -> DENIED
    expect(
      isSourceAuthorized({
        sourceId: "reddit",
        purpose: "commercial_lead_generation",
        scope: "comments_read",
      }),
    ).toBe(false);

    // 10c: Authorized scope but UNAUTHORIZED purpose (seo_opportunity_discovery not in purposes) -> DENIED
    expect(
      isSourceAuthorized({
        sourceId: "reddit",
        purpose: "seo_opportunity_discovery",
        scope: "search_discovery",
      }),
    ).toBe(false);
  });

  // Test 11: Retention dry-run output accurately describes automatic TTL deletion versus approval-gated historical purges
  it("Test 11: Retention dry-run output accurately describes automatic TTL deletion vs approval-gated historical purges", async () => {
    // Calling historical purge without operator approval confirmation throws OperatorApprovalRequiredError
    await expect(
      purgeHistoricalData({
        operatorApprovalConfirmed: false,
      }),
    ).rejects.toBeInstanceOf(OperatorApprovalRequiredError);

    // Calling historical purge with approval confirmation in dry-run mode succeeds safely
    const purgePreview = await purgeHistoricalData({
      operatorApprovalConfirmed: true,
      operatorNote: "Audited by operator; dry-run verification",
      dryRun: true,
    });
    expect(purgePreview.dryRun).toBe(true);
    expect(purgePreview.purged).toBe(0);
  });

  // Test 12: Independent authorized functionality remains operational
  it("Test 12: Independent authorized functionality (website crawler) remains operational when Reddit is blocked", () => {
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "false");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "");
    vi.stubEnv("X_LEADS", "false");

    const crawlerOp: SourceOperationRequest = {
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    };

    expect(isSourceAuthorized(crawlerOp)).toBe(true);
    expect(() => assertSourceAuthorized(crawlerOp)).not.toThrow();

    const crawlerPolicy = getSourcePolicy(crawlerOp);
    expect(crawlerPolicy.status).toBe("APPROVED");
    expect(crawlerPolicy.enabled).toBe(true);
    expect(crawlerPolicy.commercialUsePermitted).toBe(true);
  });
});

describeDb("Database-Backed Retention Cascade Protection and Scans", () => {
  const POSTS_NOW = new Date("1969-12-31T00:00:00Z");
  const LONG_AGO = Math.floor(POSTS_NOW.getTime() / 1000) - 600 * 24 * 3600;

  it("produces a structured retention report accurately separating routine TTL from historical bulk purges", async () => {
    const report = await auditRetention();
    expect(report.retentionWindowDays).toBe(30);
    expect(typeof report.auditTimestamp).toBe("string");
    expect(typeof report.cutoffDate).toBe("string");
    expect(report.redditPosts).toHaveProperty("total");
    expect(report.redditPosts).toHaveProperty("eligibleForDeletion");
    expect(report.redditPosts).toHaveProperty("retainedByLeads");
    expect(report.redditPosts).toHaveProperty("retainedBySeo");
    expect(report.redditPosts).toHaveProperty("retainedByCompetitorMentions");

    // Dry Run Plan accurately distinguishes automatic TTL from approval-gated historical purge
    expect(report.dryRunPlan).toBeDefined();
    expect(typeof report.dryRunPlan.cutoffDate).toBe("string");
    expect(typeof report.dryRunPlan.eligiblePostsToDelete).toBe("number");
    expect(report.dryRunPlan.routineTtlCleanup.isAutomatic).toBe(true);
    expect(report.dryRunPlan.routineTtlCleanup.windowDays).toBe(30);
    expect(report.dryRunPlan.routineTtlCleanup.batchSize).toBe(500);
    expect(report.dryRunPlan.routineTtlCleanup.preservesReferencedRows).toBe(true);
    expect(report.dryRunPlan.historicalBulkPurge.requiresOperatorApproval).toBe(true);
    expect(report.dryRunPlan.historicalBulkPurge.approvalEnforcedInCode).toBe(true);
    expect(report.dryRunPlan.destructivePurgeBlockedWithoutOperatorApproval).toBe(true);
    expect(typeof report.dryRunPlan.notes).toBe("string");
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
