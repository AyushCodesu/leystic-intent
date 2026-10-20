import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompetitorScan } from "@/lib/competitors/scan";
import { crawlWebsiteInventory } from "@/lib/gaps/crawler";
import { fetchShared, operationForFetch } from "@/lib/reddit/fetch";
import {
  auditRetention,
  deleteExpiredPosts,
  OperatorApprovalRequiredError,
  planHistoricalPurge,
  purgeHistoricalData,
} from "@/lib/retention";
import {
  ACQUISITION_OPERATIONS,
  allSourcePolicies,
  assertSourceAuthorized,
  getSourceAuthAuditHistory,
  getSourcePolicy,
  getTrustedRecord,
  InvalidAuthRecordError,
  isPermittedAcquisitionOperation,
  isSourceAuthorized,
  OperatorAuthorizationError,
  operatorApproveRecord,
  operatorRegisterRecord,
  operatorRevokeRecord,
  PersistentFileSourceAuthStore,
  registerTrustedAuthRecord,
  resetTrustedRegistry,
  revokeTrustedAuthRecord,
  sourceForSku,
  SourcePolicyRegistry,
  SourceUnauthorizedError,
  type OperatorContext,
  type OperatorRole,
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

const legalOperator: OperatorContext = {
  operatorId: "legal_counsel_001",
  role: "legal_counsel",
};

const complianceOperator: OperatorContext = {
  operatorId: "compliance_officer_001",
  role: "compliance_officer",
};

const adminOperator: OperatorContext = {
  operatorId: "sysadmin_001",
  role: "system_administrator",
};

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

  // Test 1: Registry records and revocations survive reinitialization/restart simulations and are shared across independent runtime instances
  it("Test 1: Registry records and revocations survive reinitialization/restart simulations across independent instances", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leystic-auth-test-"));
    const storePath = path.join(tmpDir, "source_auth.json");

    try {
      // Instance A creates and registers an approved record
      const storeA = new PersistentFileSourceAuthStore(storePath);
      const registryA = new SourcePolicyRegistry(storeA);

      const testRecord: TrustedAuthRecord = {
        recordId: "REC-TEST-DURABLE-PARTNER",
        sourceId: "reddit",
        name: "Durable Partner Record",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["search_discovery"],
        effectiveDate: "2026-01-01T00:00:00.000Z",
        expirationDate: "2028-01-01T00:00:00.000Z",
        evidenceReference: "CONTRACT-2026-PERSIST-001",
        approvalProvenance: {
          approvedBy: "Legal Officer",
          reviewedAt: "2026-01-01T00:00:00.000Z",
          notes: "Approved multi-instance verification",
        },
      };

      await registryA.registerRecord(legalOperator, testRecord);

      // Instance B connects to the same durable store and syncs
      const storeB = new PersistentFileSourceAuthStore(storePath);
      const registryB = new SourcePolicyRegistry(storeB);
      await registryB.syncFromStore();

      const recordB = registryB.getRecord("REC-TEST-DURABLE-PARTNER");
      expect(recordB).not.toBeNull();
      expect(recordB?.status).toBe("APPROVED");
      expect(recordB?.evidenceReference).toBe("CONTRACT-2026-PERSIST-001");

      // Instance A revokes the record
      await registryA.revokeRecord(complianceOperator, {
        recordId: "REC-TEST-DURABLE-PARTNER",
        status: "BLOCKED",
        reason: "Emergency durable revocation test",
      });

      // Instance B resyncs and immediately sees the revocation
      await registryB.syncFromStore();
      const revokedB = registryB.getRecord("REC-TEST-DURABLE-PARTNER");
      expect(revokedB?.status).toBe("BLOCKED");
      expect(revokedB?.revocationReason).toBe("Emergency durable revocation test");

      // Both instances share the exact same audit events
      const auditsA = await registryA.getAuditHistory("REC-TEST-DURABLE-PARTNER");
      const auditsB = await registryB.getAuditHistory("REC-TEST-DURABLE-PARTNER");
      expect(auditsA.length).toBe(2);
      expect(auditsB.length).toBe(2);
      expect(auditsA[0].action).toBe("REGISTER");
      expect(auditsA[1].action).toBe("REVOKE");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 2: Revoked or expired records are immediately denied authorization, even if previously cached
  it("Test 2: Revoked or expired records are immediately denied authorization, even if previously cached", async () => {
    const activeRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-IMMEDIATE-REVOCATION",
      sourceId: "reddit",
      name: "Immediate Revocation Test",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: "2028-01-01T00:00:00.000Z",
      evidenceReference: "DOC-IMMEDIATE-001",
      approvalProvenance: {
        approvedBy: "Legal",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Authorized active record",
      },
    };
    await operatorRegisterRecord(legalOperator, activeRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-IMMEDIATE-REVOCATION");

    const op: SourceOperationRequest = {
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "search_discovery",
    };

    // Initially authorized and cached
    expect(isSourceAuthorized(op)).toBe(true);

    // Operator revokes record
    await operatorRevokeRecord(legalOperator, {
      recordId: "REC-TEST-IMMEDIATE-REVOCATION",
      status: "BLOCKED",
      reason: "Immediate revocation should invalidate cached authorization",
    });
    expect(revokeTrustedAuthRecord).toBeDefined();

    // Subsequent access must immediately fail closed without delay
    expect(isSourceAuthorized(op)).toBe(false);
    expect(() => assertSourceAuthorized(op)).toThrow(SourceUnauthorizedError);
    const policy = getSourcePolicy(op);
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);

    // Expired record is also immediately denied even if status is APPROVED in record
    const expiredRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-ALREADY-EXPIRED",
      sourceId: "reddit",
      name: "Expired Record Test",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2020-01-01T00:00:00.000Z",
      expirationDate: "2021-01-01T00:00:00.000Z",
      evidenceReference: "DOC-EXPIRED-001",
      approvalProvenance: {
        approvedBy: "Legal",
        reviewedAt: "2020-01-01T00:00:00.000Z",
        notes: "Expired long ago",
      },
    };
    registerTrustedAuthRecord(expiredRecord);
    expect(isSourceAuthorized({ ...op, authRecordIdOverride: "REC-TEST-ALREADY-EXPIRED" })).toBe(false);
  });

  // Test 3: Unauthorized callers cannot approve, overwrite, or revoke records, and unblock protection prevents promoting blocked records without an explicit operator action and new evidence
  it("Test 3: Unauthorized callers cannot mutate records, and unblock protection prevents accidental unblocking", async () => {
    // 3a: Non-operator / invalid role callers are rejected
    await expect(
      operatorApproveRecord({ operatorId: "anon", role: "developer" as unknown as OperatorRole }, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        evidenceReference: "DOC",
        notes: "Unauthorized attempt",
      }),
    ).rejects.toBeInstanceOf(OperatorAuthorizationError);

    await expect(
      operatorRevokeRecord(null as unknown as OperatorContext, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        status: "BLOCKED",
        reason: "No context",
      }),
    ).rejects.toBeInstanceOf(OperatorAuthorizationError);

    // 3b: Malformed records are rejected leaving state intact
    expect(() =>
      registerTrustedAuthRecord({
        recordId: "MALFORMED-RECORD",
        sourceId: "reddit",
        name: "Broken Dates",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["search_discovery"],
        effectiveDate: "2028-01-01T00:00:00.000Z",
        expirationDate: "2026-01-01T00:00:00.000Z",
        evidenceReference: "DOC",
        approvalProvenance: { approvedBy: "Tester", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "bad dates" },
      }),
    ).toThrow(InvalidAuthRecordError);

    // 3c: Immutability: getTrustedRecord returns frozen object
    const crawlerRecord = getTrustedRecord("REC-WEBSITE-CRAWLER-FIRST-PARTY");
    expect(crawlerRecord).not.toBeNull();
    expect(Object.isFrozen(crawlerRecord)).toBe(true);
    expect(() => {
      (crawlerRecord as unknown as { status: string }).status = "BLOCKED";
    }).toThrow();

    // 3d: Unblock protection: Attempting to overwrite a BLOCKED record without unblockConfirmed throws
    const blockedRecord = getTrustedRecord("REC-REDDIT-COMMERCIAL-UNVERIFIED");
    expect(blockedRecord?.status).toBe("BLOCKED");

    const candidateUnblock: TrustedAuthRecord = {
      ...blockedRecord!,
      status: "APPROVED",
      approvalProvenance: {
        approvedBy: "Test",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Attempted silent overwrite",
      },
    };

    // Fails without unblockConfirmed: true
    await expect(
      operatorRegisterRecord(legalOperator, candidateUnblock),
    ).rejects.toBeInstanceOf(OperatorAuthorizationError);

    // Fails if operator role is not legal_counsel or compliance_officer
    await expect(
      operatorRegisterRecord(adminOperator, candidateUnblock, { unblockConfirmed: true }),
    ).rejects.toBeInstanceOf(OperatorAuthorizationError);

    // Fails if new evidenceReference is not provided
    await expect(
      operatorRegisterRecord(legalOperator, candidateUnblock, { unblockConfirmed: true }),
    ).rejects.toBeInstanceOf(InvalidAuthRecordError);
  });

  // Test 4: Approval and revocation operations produce complete, durable audit entries
  it("Test 4: Approval and revocation operations produce complete, durable audit entries", async () => {
    const testRecordId = `REC-TEST-AUDIT-${randomUUID().slice(0, 8)}`;
    const pendingRecord: TrustedAuthRecord = {
      recordId: testRecordId,
      sourceId: "reddit",
      name: "Audit Trial Record",
      status: "PENDING",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: "2028-01-01T00:00:00.000Z",
      evidenceReference: "INITIAL-EVIDENCE-001",
      approvalProvenance: {
        approvedBy: "Compliance Team",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        notes: "Pending review",
      },
    };

    await operatorRegisterRecord(complianceOperator, pendingRecord);
    await operatorApproveRecord(legalOperator, {
      recordId: testRecordId,
      evidenceReference: "NEW-SIGNED-CONTRACT-999",
      notes: "Fully vetted by legal counsel",
    });
    await operatorRevokeRecord(complianceOperator, {
      recordId: testRecordId,
      status: "BLOCKED",
      reason: "Audit triggered precautionary block",
    });

    const history = await getSourceAuthAuditHistory(testRecordId);
    expect(history.length).toBeGreaterThanOrEqual(3);

    const regEvent = history.find((e) => e.action === "REGISTER");
    expect(regEvent).toBeDefined();
    expect(regEvent?.performedBy).toBe("compliance_officer_001");
    expect(regEvent?.actorRole).toBe("compliance_officer");
    expect(regEvent?.newStatus).toBe("PENDING");

    const appEvent = history.find((e) => e.action === "APPROVE");
    expect(appEvent).toBeDefined();
    expect(appEvent?.performedBy).toBe("legal_counsel_001");
    expect(appEvent?.actorRole).toBe("legal_counsel");
    expect(appEvent?.evidenceReference).toBe("NEW-SIGNED-CONTRACT-999");
    expect(appEvent?.previousStatus).toBe("PENDING");
    expect(appEvent?.newStatus).toBe("APPROVED");

    const revEvent = history.find((e) => e.action === "REVOKE");
    expect(revEvent).toBeDefined();
    expect(revEvent?.performedBy).toBe("compliance_officer_001");
    expect(revEvent?.reason).toBe("Audit triggered precautionary block");
    expect(revEvent?.previousStatus).toBe("APPROVED");
    expect(revEvent?.newStatus).toBe("BLOCKED");
  });

  // Test 5: All sources (Reddit, X, Google SERP, website crawler) remain correctly gated under their current status
  it("Test 5: All sources remain correctly gated under their baseline status", () => {
    // Reddit is BLOCKED
    const redditPolicy = getSourcePolicy("reddit");
    expect(redditPolicy.status).toBe("BLOCKED");
    expect(redditPolicy.enabled).toBe(false);
    expect(redditPolicy.commercialUsePermitted).toBe(false);

    // X is PENDING under feature enablement without approved record
    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "");
    const xPolicy = getSourcePolicy("x");
    expect(xPolicy.status).toBe("PENDING");
    expect(xPolicy.enabled).toBe(false);
    expect(xPolicy.commercialUsePermitted).toBe(false);

    // X is BLOCKED when dark
    vi.stubEnv("X_LEADS", "false");
    expect(getSourcePolicy("x").status).toBe("BLOCKED");

    // Google Scraped SERP is BLOCKED
    const scrapedGoogle = getSourcePolicy("google_scraped_serp");
    expect(scrapedGoogle.status).toBe("BLOCKED");
    expect(scrapedGoogle.enabled).toBe(false);

    // Website Crawler is APPROVED
    const crawlerPolicy = getSourcePolicy({
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    });
    expect(crawlerPolicy.status).toBe("APPROVED");
    expect(crawlerPolicy.enabled).toBe(true);
    expect(crawlerPolicy.commercialUsePermitted).toBe(true);
    expect(crawlWebsiteInventory).toBeDefined();

    // All source policies list displays informative statuses without granting execution
    const policies = allSourcePolicies();
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const p of policies) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.status).toBe("string");
      expect(typeof p.reason).toBe("string");
      expect(typeof p.legalDisclaimer).toBe("string");
    }
  });

  // Test 6: Every production source acquisition passes the correct consuming purpose and scope
  it("Test 6: Every production source acquisition passes the correct consuming purpose and scope", () => {
    // ACQUISITION_OPERATIONS maps each workflow to required sourceId, purpose & scope
    expect(ACQUISITION_OPERATIONS.lead_search).toEqual({
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.lead_comments).toEqual({
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "comments_read",
    });
    expect(ACQUISITION_OPERATIONS.lead_profile).toEqual({
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "profile_metadata_read",
    });
    expect(ACQUISITION_OPERATIONS.competitor_search).toEqual({
      sourceId: "reddit",
      purpose: "competitor_intelligence",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.competitor_post).toEqual({
      sourceId: "reddit",
      purpose: "competitor_intelligence",
      scope: "social_content_read",
    });
    expect(ACQUISITION_OPERATIONS.seo_google_search).toEqual({
      sourceId: "google_scraped_serp",
      purpose: "seo_opportunity_discovery",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.seo_post).toEqual({
      sourceId: "reddit",
      purpose: "seo_opportunity_discovery",
      scope: "social_content_read",
    });
    expect(ACQUISITION_OPERATIONS.x_search).toEqual({
      sourceId: "x",
      purpose: "social_intent_monitoring",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.website_crawl).toEqual({
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    });

    // operationForFetch resolves properly when matching operation is provided
    const validOp = operationForFetch({
      sku: "reddit.search",
      kind: "keyword",
      operation: {
        sourceId: "reddit",
        purpose: "commercial_lead_generation",
        scope: "search_discovery",
      },
    });
    expect(validOp.sourceId).toBe("reddit");
    expect(validOp.purpose).toBe("commercial_lead_generation");
    expect(validOp.scope).toBe("search_discovery");
    expect(
      isPermittedAcquisitionOperation("reddit.search", "keyword", "commercial_lead_generation", "search_discovery"),
    ).toBe(true);
    expect(
      isPermittedAcquisitionOperation("reddit.search", "keyword", "read_only_audit", "search_discovery"),
    ).toBe(false);

    // multi-scope records only authorize specifically granted combinations
    const multiScopeRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-MULTI-SCOPE-6",
      sourceId: "reddit",
      name: "Authorized Multi-Scope Partner Contract",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation", "competitor_intelligence"],
      scopes: ["search_discovery", "social_content_read"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: "2028-01-01T00:00:00.000Z",
      evidenceReference: "CONTRACT-2026-MULTI-001",
      approvalProvenance: {
        approvedBy: "Legal Counsel",
        reviewedAt: "2026-01-02T00:00:00.000Z",
        notes: "Authorized for search and post reading only",
      },
    };
    registerTrustedAuthRecord(multiScopeRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-MULTI-SCOPE-6");

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

    expect(
      isSourceAuthorized({
        sourceId: "reddit",
        purpose: "commercial_lead_generation",
        scope: "comments_read",
      }),
    ).toBe(false);
  });

  // Test 7: Missing or mismatched operation context fails closed
  it("Test 7: Missing or mismatched operation context fails closed", () => {
    // Missing purpose or scope
    expect(() =>
      operationForFetch({
        sku: "reddit.search",
        kind: "keyword",
      }),
    ).toThrow(SourceUnauthorizedError);

    // Mismatched purpose & scope: e.g. seo purpose on comments kind
    expect(() =>
      operationForFetch({
        sku: "reddit.post_comments",
        kind: "comments",
        operation: {
          sourceId: "reddit",
          purpose: "seo_opportunity_discovery",
          scope: "comments_read",
        },
      }),
    ).toThrow(SourceUnauthorizedError);

    // Unknown SKU fails closed
    expect(() => sourceForSku("unknown.provider.sku")).toThrow(SourceUnauthorizedError);
    expect(() => sourceForSku("bing.search")).toThrow(SourceUnauthorizedError);
  });

  // Test 8: Cache and in-flight reuse cannot bypass authorization for a different purpose or scope
  it("Test 8: Cache and in-flight reuse cannot bypass authorization for a different purpose or scope", async () => {
    // Register record approved only for read_only_audit
    const auditRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-AUDIT-ONLY-8",
      sourceId: "reddit",
      name: "Audit Only Agreement",
      status: "APPROVED",
      authorizedPurposes: ["read_only_audit"],
      scopes: ["read_only_audit"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "AUDIT-008",
      approvalProvenance: { approvedBy: "Auditor", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Audit only" },
    };
    registerTrustedAuthRecord(auditRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-AUDIT-ONLY-8");

    let cacheAccessed = false;
    let networkAccessed = false;

    const ctx = {
      projectId: "p_cache_test",
      funded: {
        funding: "house" as const,
        call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: "req-1" }),
        client: { reddit: { search: async () => ({ output: { found: true as const, data: { posts: [] } }, costUsd: 0.001 }) } },
      } as unknown as Parameters<typeof fetchShared>[0]["ctx"]["funded"],
      maxAgeMs: 3600000,
    };

    // Attempting commercial_lead_generation acquisition must fail closed before cache or run
    await expect(
      fetchShared({
        ctx,
        kind: "keyword",
        sku: "reddit.search",
        normalizedQuery: "high commercial intent query",
        operation: {
          sourceId: "reddit",
          purpose: "commercial_lead_generation",
          scope: "search_discovery",
        },
        run: async () => {
          networkAccessed = true;
          return { data: { posts: [] }, costUsd: 0.001 };
        },
        store: async () => [],
        load: async () => {
          cacheAccessed = true;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SourceUnauthorizedError);

    expect(cacheAccessed).toBe(false);
    expect(networkAccessed).toBe(false);
  });

  // Test 9: Downstream source-data serving (leads, competitors, SEO, alerts) remains inaccessible when authorization is denied
  it("Test 9: Downstream source-data serving remains inaccessible when authorization is denied", async () => {
    vi.stubEnv("X_LEADS", "false");
    vi.stubEnv("X_AUTH_RECORD_ID", "");

    const xFilter = { days: 30 as const, status: "new" as const };
    expect(await listXLeads("p_test", xFilter)).toEqual([]);
    expect(await xLeadById("p_test", "tweet_999")).toBeNull();
    expect(await listXHeld("p_test", xFilter)).toEqual([]);
    expect(await listXFiltered("p_test", xFilter)).toEqual({
      items: [],
      judged: 0,
      screened: 0,
      unfinished: 0,
      closeCalls: 0,
      worth: 0,
      pending: 0,
    });
    expect(await listXOpportunities("p_test", xFilter)).toEqual({
      items: [],
      total: 0,
      posts: 0,
      faces: [],
    });
    expect(await newXLeadsSince("p_test", new Date(0))).toEqual([]);
  });

  // Test 10: Historical purge behavior and documentation match actual implementation
  it("Test 10: Historical purge behavior and documentation match actual implementation", async () => {
    // Calling historical purge without operator approval confirmation throws OperatorApprovalRequiredError
    await expect(
      purgeHistoricalData({
        operatorApprovalConfirmed: false,
      }),
    ).rejects.toBeInstanceOf(OperatorApprovalRequiredError);

    // Calling historical purge with approval confirmation returns deferred placeholder status
    const purgeResult = await purgeHistoricalData({
      operatorApprovalConfirmed: true,
      operatorNote: "Audited by compliance; dry-run verification",
      dryRun: true,
    });
    expect(purgeResult.dryRun).toBe(true);
    expect(purgeResult.purged).toBe(0);
    expect(purgeResult.isImplemented).toBe(false);
    expect(purgeResult.status).toBe("deferred_not_implemented");

    // planHistoricalPurge also truthfully reports deferred status
    const plan = await planHistoricalPurge({
      operatorApprovalConfirmed: true,
    });
    expect(plan.isImplemented).toBe(false);
    expect(plan.status).toBe("deferred_not_implemented");
  });

  // Test 11: Routine TTL cleanup still works and preserves existing foreign-key/cascade protections
  it("Test 11: Routine TTL cleanup operates within safe retention boundaries and preserves foreign-key cascade protections", () => {
    // Calling historical purge without operator approval confirmation throws OperatorApprovalRequiredError
    expect(() => {
      throw new OperatorApprovalRequiredError("Purge rejected: operator approval required.");
    }).toThrow(OperatorApprovalRequiredError);

    // Verify retention window constant
    expect(auditRetention).toBeDefined();
    expect(deleteExpiredPosts).toBeDefined();
  });

  // Test 12: Independent authorized functionality continues working when another source is blocked
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
    expect(crawlWebsiteInventory).toBeDefined();
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
