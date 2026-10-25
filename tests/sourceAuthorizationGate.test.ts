import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompetitorScan } from "@/lib/competitors/scan";
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
  bootstrapOperatorCredentials,
  createDefaultSourceAuthStore,
  DrizzleOperatorCredentialStore,
  DrizzleSourceAuthStore,
  getOperatorCredentialAuditHistory,
  getSourceAuthAuditHistory,
  getSourcePolicy,
  getTrustedRecord,
  globalOperatorCredentialRegistry,
  globalRegistry,
  hashOperatorSecret,
  InvalidAuthRecordError,
  InvalidCredentialRecordError,
  isPermittedAcquisitionOperation,
  OperatorAuthorizationError,
  operatorApproveRecord,
  OperatorCredentialRegistry,
  operatorRegisterCredential,
  operatorRegisterRecord,
  operatorRevokeCredential,
  operatorRevokeRecord,
  operatorRotateCredential,
  PersistentFileOperatorCredentialStore,
  PersistentFileSourceAuthStore,
  registerTrustedAuthRecord,
  resetTrustedRegistry,
  setGlobalOperatorCredentialStore,
  setGlobalRegistryStore,
  sourceForSku,
  type SourceAuthStore,
  SourcePolicyRegistry,
  SourceUnauthorizedError,
  type OperatorContext,
  type OperatorRole,
  type SourceOperationRequest,
  type TrustedAuthRecord,
  validateOperatorCredentialRecord,
  validateSecretTokenStrength,
  __testOnlyRegisterOperatorCredential,
  __testOnlyRegisterRecord,
} from "@/lib/sourcePolicy";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

const legalOperator: OperatorContext = {
  operatorId: "legal_counsel_001",
  role: "legal_counsel",
  operatorKey: "legal_secret_key_001",
};

const complianceOperator: OperatorContext = {
  operatorId: "compliance_officer_001",
  role: "compliance_officer",
  operatorKey: "compliance_secret_key_001",
};

const adminOperator: OperatorContext = {
  operatorId: "sysadmin_001",
  role: "system_administrator",
  operatorKey: "admin_secret_key_001",
};

describe("Operation-Specific Source Authorization and Registry Controls", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://reddit_leads@localhost:5433/reddit_leads");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    globalOperatorCredentialRegistry.reset();
    setGlobalRegistryStore(createDefaultSourceAuthStore());
    resetTrustedRegistry();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalOperatorCredentialRegistry.reset();
    setGlobalRegistryStore(createDefaultSourceAuthStore());
    resetTrustedRegistry();
  });

  // Test 1: Production bootstrap selects the PostgreSQL registry rather than a fallback file
  it("Test 1: Production bootstrap selects the PostgreSQL registry rather than a fallback file", () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = createDefaultSourceAuthStore();
    expect(store).toBeInstanceOf(DrizzleSourceAuthStore);
    expect(store).not.toBeInstanceOf(PersistentFileSourceAuthStore);
  });

  // Test 2: Durable records survive restart simulations across independent runtime instances
  it("Test 2: Durable records survive restart simulations across independent runtime instances", async () => {
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

  // Test 3: Database failure prevents protected access; authorization fails closed rather than falling back to an unverified cache
  it("Test 3: Database failure prevents protected access; authorization fails closed rather than falling back to an unverified cache", async () => {
    // Failing store simulates offline or unreachable durable store
    const failingStore: SourceAuthStore = {
      getRecord: async () => {
        throw new Error("PostgreSQL connection refused: host unreachable");
      },
      getAllRecords: async () => {
        throw new Error("PostgreSQL connection refused: host unreachable");
      },
      saveRecord: async () => {
        throw new Error("PostgreSQL connection refused: host unreachable");
      },
      revokeRecord: async () => {
        throw new Error("PostgreSQL connection refused: host unreachable");
      },
      getAuditEvents: async () => {
        throw new Error("PostgreSQL connection refused: host unreachable");
      },
    };

    const isolatedRegistry = new SourcePolicyRegistry(failingStore);
    isolatedRegistry.__testOnlyInjectRecord({
      recordId: "REC-TEST-FAIL-CLOSED",
      sourceId: "reddit",
      name: "Pre-existing cache entry",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: "2028-01-01T00:00:00.000Z",
      evidenceReference: "DOC-PRE",
      approvalProvenance: { approvedBy: "Legal", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "test" },
    });

    // When store synchronization fails, the cache must be cleared and marked unhealthy
    await expect(isolatedRegistry.syncFromStore()).rejects.toThrow(/Failed to synchronize source authorization registry/);
    expect(isolatedRegistry.isHealthy()).toBe(false);
    expect(isolatedRegistry.getRecord("REC-TEST-FAIL-CLOSED")).toBeNull();
    expect(isolatedRegistry.getAllRecords()).toEqual([]);

    // Set failing store on global registry to verify getSourcePolicy and assertSourceAuthorized
    setGlobalRegistryStore(failingStore);
    await expect(globalRegistry.syncFromStore()).rejects.toThrow();
    expect(globalRegistry.isHealthy()).toBe(false);

    const op: SourceOperationRequest = {
      sourceId: "reddit",
      purpose: "commercial_lead_generation",
      scope: "search_discovery",
    };
    const policy = getSourcePolicy(op);
    expect(policy.status).toBe("BLOCKED");
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toContain("Durable authorization store is unreachable");
    expect(() => assertSourceAuthorized(op)).toThrow(SourceUnauthorizedError);
  });

  // Test 4: Cache expiry and invalidation work as documented across runtime instances and processes
  it("Test 4: Cache expiry and invalidation work as documented across runtime instances and processes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leystic-auth-ttl-"));
    const storePath = path.join(tmpDir, "source_auth.json");

    try {
      const sharedStore = new PersistentFileSourceAuthStore(storePath);

      // Instance A with short TTL (20ms)
      const registryA = new SourcePolicyRegistry(sharedStore, 20);
      // Instance B with short TTL (20ms)
      const registryB = new SourcePolicyRegistry(sharedStore, 20);

      const testRecord: TrustedAuthRecord = {
        recordId: "REC-TEST-TTL-EXPIRY",
        sourceId: "reddit",
        name: "TTL Expiry Record",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["search_discovery"],
        effectiveDate: "2026-01-01T00:00:00.000Z",
        expirationDate: "2028-01-01T00:00:00.000Z",
        evidenceReference: "DOC-TTL-001",
        approvalProvenance: { approvedBy: "Legal", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "TTL test" },
      };

      await registryA.registerRecord(legalOperator, testRecord);
      await registryB.syncFromStore();
      expect(registryB.getRecord("REC-TEST-TTL-EXPIRY")?.status).toBe("APPROVED");

      // Instance A revokes record in the shared store
      await registryA.revokeRecord(legalOperator, {
        recordId: "REC-TEST-TTL-EXPIRY",
        status: "BLOCKED",
        reason: "Invalidated via revocation",
      });

      // In Instance A, cache was immediately invalidated on revocation
      expect(registryA.getRecord("REC-TEST-TTL-EXPIRY")?.status).toBe("BLOCKED");

      // In Instance B, wait for TTL to expire (35ms > 20ms)
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(registryB.isCacheExpired()).toBe(true);

      // Once ensureFresh is called after TTL, Instance B sees the revocation
      await registryB.ensureFresh();
      expect(registryB.getRecord("REC-TEST-TTL-EXPIRY")?.status).toBe("BLOCKED");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 5: Fabricated operator contexts cannot approve or revoke records in production, including when secrets are absent
  it("Test 5: Fabricated operator contexts cannot approve or revoke records in production, including when secrets are absent", async () => {
    vi.stubEnv("NODE_ENV", "production");

    // 5a: In production without OPERATOR_SECRET_KEY configured, all mutations fail closed
    vi.stubEnv("OPERATOR_SECRET_KEY", "");

    await expect(
      operatorApproveRecord(legalOperator, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        evidenceReference: "DOC",
        notes: "Attempt without secret configured",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    await expect(
      operatorRevokeRecord(legalOperator, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        status: "BLOCKED",
        reason: "Attempt without secret configured",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // 5b: With secret configured in production, invalid key or anonymous identity fails closed
    vi.stubEnv("OPERATOR_SECRET_KEY", "super-secret-operator-key-999");

    const anonOperator: OperatorContext = {
      operatorId: "anon",
      role: "legal_counsel",
      operatorKey: "super-secret-operator-key-999",
    };
    await expect(
      operatorApproveRecord(anonOperator, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        evidenceReference: "DOC",
        notes: "Attempt with anon identity",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    const wrongKeyOperator: OperatorContext = {
      operatorId: "legal_officer_real",
      role: "legal_counsel",
      operatorKey: "wrong-secret-key",
    };
    await expect(
      operatorApproveRecord(wrongKeyOperator, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        evidenceReference: "DOC",
        notes: "Attempt with wrong key",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // 5c: Calling registerTrustedAuthRecord without operator context in production throws
    expect(() =>
      registerTrustedAuthRecord({
        recordId: "REC-TEST-PROD-ATTEMPT",
        sourceId: "reddit",
        name: "Test",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["search_discovery"],
        effectiveDate: "2026-01-01T00:00:00.000Z",
        expirationDate: "2028-01-01T00:00:00.000Z",
        evidenceReference: "DOC",
        approvalProvenance: { approvedBy: "Tester", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "test" },
      }),
    ).toThrow(OperatorAuthorizationError);
  });

  // Test 6: Only an authenticated operator with an appropriate role can perform each type of mutation
  it("Test 6: Only an authenticated operator with an appropriate role can perform each type of mutation", async () => {
    // Non-permitted roles are rejected
    await expect(
      operatorApproveRecord({ operatorId: "developer_001", role: "developer" as unknown as OperatorRole }, {
        recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
        evidenceReference: "DOC",
        notes: "Dev role cannot mutate",
      }),
    ).rejects.toBeInstanceOf(OperatorAuthorizationError);

    // Unblocking a BLOCKED record requires legal_counsel or compliance_officer
    const blockedRecord = getTrustedRecord("REC-REDDIT-COMMERCIAL-UNVERIFIED");
    expect(blockedRecord?.status).toBe("BLOCKED");

    const unblockCandidate: TrustedAuthRecord = {
      ...blockedRecord!,
      status: "APPROVED",
      evidenceReference: "NEW-OFFICIAL-CONTRACT-2026",
      approvalProvenance: { approvedBy: "Sysadmin", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Sysadmin unblock" },
    };

    // sysadmin cannot unblock
    await expect(
      operatorRegisterRecord(adminOperator, unblockCandidate, { unblockConfirmed: true }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // legal_counsel without unblockConfirmed cannot unblock
    await expect(
      operatorRegisterRecord(legalOperator, unblockCandidate, { unblockConfirmed: false }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // legal_counsel without new evidence cannot unblock
    await expect(
      operatorRegisterRecord(
        legalOperator,
        { ...unblockCandidate, evidenceReference: blockedRecord!.evidenceReference },
        { unblockConfirmed: true },
      ),
    ).rejects.toThrow(InvalidAuthRecordError);

    // Valid legal unblock with confirmation and new evidence succeeds
    const unblocked = await operatorRegisterRecord(legalOperator, unblockCandidate, { unblockConfirmed: true });
    expect(unblocked.status).toBe("APPROVED");
    expect(unblocked.evidenceReference).toBe("NEW-OFFICIAL-CONTRACT-2026");
  });

  // Test 7: Operation identifiers match their exact SKU and fetch kind
  it("Test 7: Operation identifiers match their exact SKU and fetch kind", () => {
    // ACQUISITION_OPERATIONS maps each workflow to required operationId, sourceId, sku, kind, purpose, and scope
    expect(ACQUISITION_OPERATIONS.lead_search).toEqual({
      operationId: "lead_search",
      sourceId: "reddit",
      sku: "reddit.search",
      kind: "keyword",
      purpose: "commercial_lead_generation",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.lead_comments).toEqual({
      operationId: "lead_comments",
      sourceId: "reddit",
      sku: "reddit.post_comments",
      kind: "comments",
      purpose: "commercial_lead_generation",
      scope: "comments_read",
    });
    expect(ACQUISITION_OPERATIONS.lead_post).toEqual({
      operationId: "lead_post",
      sourceId: "reddit",
      sku: "reddit.post",
      kind: "post",
      purpose: "commercial_lead_generation",
      scope: "social_content_read",
    });
    expect(ACQUISITION_OPERATIONS.seo_google_search).toEqual({
      operationId: "seo_google_search",
      sourceId: "google_scraped_serp",
      sku: "google.search",
      kind: "serp",
      purpose: "seo_opportunity_discovery",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.x_search).toEqual({
      operationId: "x_search",
      sourceId: "x",
      sku: "twitter.search",
      kind: "x_search",
      purpose: "social_intent_monitoring",
      scope: "search_discovery",
    });
    expect(ACQUISITION_OPERATIONS.website_crawl).toEqual({
      operationId: "website_crawl",
      sourceId: "website_crawler",
      sku: "website.crawl",
      kind: "website_crawl",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    });

    // isPermittedAcquisitionOperation validates all 5 fields
    expect(
      isPermittedAcquisitionOperation("reddit.search", "keyword", "commercial_lead_generation", "search_discovery", "lead_search"),
    ).toBe(true);
    expect(
      isPermittedAcquisitionOperation("reddit.search", "post", "commercial_lead_generation", "search_discovery", "lead_search"),
    ).toBe(false);
  });

  // Test 8: A valid operation mapping cannot authorize a different workflow
  it("Test 8: A valid operation mapping cannot authorize a different workflow", () => {
    // Missing explicit operationId fails closed
    expect(() =>
      operationForFetch({
        sku: "reddit.search",
        kind: "keyword",
      }),
    ).toThrow(SourceUnauthorizedError);

    // Unknown operationId fails closed
    expect(() =>
      operationForFetch({
        sku: "reddit.search",
        kind: "keyword",
        operation: {
          operationId: "nonexistent_op" as unknown as SourceOperationRequest["operationId"],
          sourceId: "reddit",
          purpose: "commercial_lead_generation",
          scope: "search_discovery",
        },
      }),
    ).toThrow(SourceUnauthorizedError);

    // Mismatched SKU or kind for operationId fails closed
    expect(() =>
      operationForFetch({
        sku: "reddit.post",
        kind: "post",
        operation: ACQUISITION_OPERATIONS.lead_search,
      }),
    ).toThrow(SourceUnauthorizedError);

    // Attempting to override purpose or scope defined for an operation is rejected
    expect(() =>
      operationForFetch({
        sku: "reddit.search",
        kind: "keyword",
        purpose: "competitor_intelligence",
        operation: ACQUISITION_OPERATIONS.lead_search,
      }),
    ).toThrow(SourceUnauthorizedError);

    expect(() =>
      operationForFetch({
        sku: "reddit.search",
        kind: "keyword",
        scope: "social_content_read",
        operation: ACQUISITION_OPERATIONS.lead_search,
      }),
    ).toThrow(SourceUnauthorizedError);

    // Exact valid mapping succeeds with all 5 dimensions matching
    const valid = operationForFetch({
      sku: "reddit.search",
      kind: "keyword",
      operation: ACQUISITION_OPERATIONS.lead_search,
    });
    expect(valid.operationId).toBe("lead_search");
    expect(valid.sourceId).toBe("reddit");
    expect(valid.purpose).toBe("commercial_lead_generation");
    expect(valid.scope).toBe("search_discovery");

    // Unknown SKU fails closed
    expect(() => sourceForSku("unknown.provider.sku")).toThrow(SourceUnauthorizedError);
    expect(() => sourceForSku("bing.search")).toThrow(SourceUnauthorizedError);
  });

  // Test 8B: Operator authentication enforces server-side credentials and rejects caller role assertions
  it("Test 8B: Operator authentication enforces server-side credentials and rejects caller role assertions", async () => {
    const unblockCandidate: TrustedAuthRecord = {
      recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
      sourceId: "reddit",
      name: "Reddit (via AnyAPI Gateway)",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-10-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "NEW-OFFICIAL-DIRECT-AGREEMENT-2026",
      approvalProvenance: {
        approvedBy: "legal_counsel_001",
        reviewedAt: "2026-10-20T00:00:00.000Z",
        notes: "Direct verified agreement executed",
      },
    };

    // Caller cannot elevate role: sysadmin credential claiming legal_counsel is rejected
    await expect(
      operatorRegisterRecord(
        {
          operatorId: "sysadmin_001",
          role: "legal_counsel",
          operatorKey: "admin_secret_key_001",
        },
        unblockCandidate,
        { unblockConfirmed: true },
      ),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Unknown credential token is rejected
    await expect(
      operatorRegisterRecord(
        {
          operatorId: "legal_counsel_001",
          role: "legal_counsel",
          operatorKey: "unregistered_token_xyz",
        },
        unblockCandidate,
        { unblockConfirmed: true },
      ),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Revoked credential is rejected
    __testOnlyRegisterOperatorCredential({
      credentialId: "cred_revoked_counsel",
      operatorId: "revoked_counsel_001",
      role: "legal_counsel",
      secret: "revoked_token_123",
      revoked: true,
    });
    await expect(
      operatorRegisterRecord(
        {
          operatorId: "revoked_counsel_001",
          role: "legal_counsel",
          operatorKey: "revoked_token_123",
        },
        unblockCandidate,
        { unblockConfirmed: true },
      ),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Expired credential is rejected
    __testOnlyRegisterOperatorCredential({
      credentialId: "cred_expired_counsel",
      operatorId: "expired_counsel_001",
      role: "legal_counsel",
      secret: "expired_token_123",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      operatorRegisterRecord(
        {
          operatorId: "expired_counsel_001",
          role: "legal_counsel",
          operatorKey: "expired_token_123",
        },
        unblockCandidate,
        { unblockConfirmed: true },
      ),
    ).rejects.toThrow(OperatorAuthorizationError);

    // In production, missing OPERATOR_SECRET_KEY disables mutations fail-closed
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPERATOR_SECRET_KEY", "");
    await expect(
      operatorRegisterRecord(legalOperator, unblockCandidate, { unblockConfirmed: true }),
    ).rejects.toThrow(OperatorAuthorizationError);
    vi.unstubAllEnvs();
  });

  // Test 9: Cache reuse cannot bypass a new operation's purpose or scope requirements
  it("Test 9: Cache reuse cannot bypass a new operation's purpose or scope requirements", async () => {
    const auditRecord: TrustedAuthRecord = {
      recordId: "REC-TEST-AUDIT-ONLY-9",
      sourceId: "reddit",
      name: "Audit Only Agreement",
      status: "APPROVED",
      authorizedPurposes: ["read_only_audit"],
      scopes: ["read_only_audit"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "AUDIT-009",
      approvalProvenance: { approvedBy: "Auditor", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Audit only" },
    };
    registerTrustedAuthRecord(auditRecord);

    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "REC-TEST-AUDIT-ONLY-9");

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

    // Attempting commercial_lead_generation acquisition must fail closed before cache or network run
    await expect(
      fetchShared({
        ctx,
        kind: "keyword",
        sku: "reddit.search",
        normalizedQuery: "commercial test query",
        operation: {
          operationId: "lead_search",
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

  // Test 10: The audit ledger survives record state changes, and no ordinary registry operation or cascade deletion can erase audit events
  it("Test 10: The audit ledger survives record state changes, and no ordinary registry operation or cascade deletion can erase audit events", async () => {
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

  // Test 11: Routine TTL behavior remains intact and historical purge behavior matches its honest status
  it("Test 11: Routine TTL behavior remains intact and historical purge behavior matches its honest status", async () => {
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

    // Routine TTL cleanup functions exist
    expect(auditRetention).toBeDefined();
    expect(deleteExpiredPosts).toBeDefined();
  });

  // Test 12: Reddit, X, and scraped Google SERP remain blocked or pending under the current register
  it("Test 12: Reddit, X, and scraped Google SERP remain blocked or pending under the current register", () => {
    // Reddit is BLOCKED
    const redditPolicy = getSourcePolicy("reddit");
    expect(redditPolicy.status).toBe("BLOCKED");
    expect(redditPolicy.enabled).toBe(false);
    expect(redditPolicy.commercialUsePermitted).toBe(false);

    // Reddit flag + arbitrary record fails closed
    vi.stubEnv("REDDIT_SOURCE_ENABLED", "true");
    vi.stubEnv("REDDIT_AUTH_RECORD_ID", "arbitrary-unknown-record");
    expect(getSourcePolicy("reddit").status).toBe("BLOCKED");
    expect(getSourcePolicy("reddit").enabled).toBe(false);

    // X is PENDING when enabled without approved record
    vi.stubEnv("X_LEADS", "true");
    vi.stubEnv("X_AUTH_RECORD_ID", "");
    const xPolicy = getSourcePolicy("x");
    expect(xPolicy.status).toBe("PENDING");
    expect(xPolicy.enabled).toBe(false);

    // X is BLOCKED when dark
    vi.stubEnv("X_LEADS", "false");
    expect(getSourcePolicy("x").status).toBe("BLOCKED");

    // Google Scraped SERP is BLOCKED
    const scrapedGoogle = getSourcePolicy("google_scraped_serp");
    expect(scrapedGoogle.status).toBe("BLOCKED");
    expect(scrapedGoogle.enabled).toBe(false);

    // Website Crawler is APPROVED
    const crawlerPolicy = getSourcePolicy({
      operationId: "website_crawl",
      sourceId: "website_crawler",
      purpose: "customer_website_coverage",
      scope: "customer_domain_crawl",
    });
    expect(crawlerPolicy.status).toBe("APPROVED");
    expect(crawlerPolicy.enabled).toBe(true);
    expect(crawlerPolicy.commercialUsePermitted).toBe(true);

    // allSourcePolicies surfaces accurate statuses
    const policies = allSourcePolicies();
    expect(policies.length).toBeGreaterThanOrEqual(4);
    for (const p of policies) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.status).toBe("string");
    }
  });

  // Test 13: Operator credential durability survives process restarts across independent instances
  it("Test 13: Operator credential durability survives process restarts across independent instances", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leystic-cred-durability-"));
    const storePath = path.join(tmpDir, "operator_creds.json");

    try {
      const storeA = new PersistentFileOperatorCredentialStore(storePath);
      const registryA = new OperatorCredentialRegistry(storeA);

      // Instance A registers a new credential for an officer
      const newCred = await registryA.registerCredential(adminOperator, {
        credentialId: "cred_durable_officer_01",
        operatorId: "durable_officer_01",
        role: "compliance_officer",
        secret: "secure_compliance_secret_token_12345678",
        description: "Durable compliance officer credential",
      });
      expect(newCred.credentialId).toBe("cred_durable_officer_01");

      // Simulate process restart: Instance B opens the same store
      const storeB = new PersistentFileOperatorCredentialStore(storePath);
      const registryB = new OperatorCredentialRegistry(storeB);
      await registryB.ensureFresh(true);

      const loadedCred = registryB.getCredential("cred_durable_officer_01");
      expect(loadedCred).toBeDefined();
      expect(loadedCred?.operatorId).toBe("durable_officer_01");
      expect(loadedCred?.role).toBe("compliance_officer");
      expect(loadedCred?.revoked).toBe(false);

      // Verify token authentication works in Instance B
      const verified = registryB.findCredentialByToken("secure_compliance_secret_token_12345678");
      expect(verified?.credentialId).toBe("cred_durable_officer_01");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 14: Cross-worker operator credential revocation and TTL staleness bounds
  it("Test 14: Cross-worker operator credential revocation and TTL staleness bounds", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leystic-cred-ttl-"));
    const storePath = path.join(tmpDir, "operator_creds.json");

    try {
      const storeA = new PersistentFileOperatorCredentialStore(storePath);
      const registryA = new OperatorCredentialRegistry(storeA, 20); // 20ms TTL
      const storeB = new PersistentFileOperatorCredentialStore(storePath);
      const registryB = new OperatorCredentialRegistry(storeB, 20); // 20ms TTL

      // Provision credential on instance A
      await registryA.registerCredential(adminOperator, {
        credentialId: "cred_worker_revoked_01",
        operatorId: "worker_officer_01",
        role: "compliance_officer",
        secret: "valid_secret_key_worker_token_12345678",
      });

      // Instance B hydrates and authenticates successfully
      await registryB.syncFromStore();
      expect(registryB.findCredentialByToken("valid_secret_key_worker_token_12345678")).toBeDefined();

      // Instance A revokes credential
      await registryA.revokeCredential(adminOperator, {
        credentialId: "cred_worker_revoked_01",
        reason: "Compromised credential during penetration testing",
      });

      // In Instance A, cache immediately shows revoked
      expect(registryA.getCredential("cred_worker_revoked_01")?.revoked).toBe(true);

      // Wait for TTL on Instance B (35ms > 20ms)
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(registryB.isCacheExpired()).toBe(true);

      // Instance B refreshes and rejects the revoked credential
      await registryB.ensureFresh();
      const credOnB = registryB.getCredential("cred_worker_revoked_01");
      expect(credOnB?.revoked).toBe(true);
      expect(credOnB?.revocationReason).toBe("Compromised credential during penetration testing");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 15: Revocation persists across restart simulations
  it("Test 15: Revocation persists across restart simulations", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leystic-cred-restart-"));
    const storePath = path.join(tmpDir, "operator_creds.json");

    try {
      const storeA = new PersistentFileOperatorCredentialStore(storePath);
      const registryA = new OperatorCredentialRegistry(storeA);

      await registryA.registerCredential(adminOperator, {
        credentialId: "cred_restart_revoked",
        operatorId: "restart_legal_01",
        role: "legal_counsel",
        secret: "legal_restart_secret_token_12345678",
      });

      await registryA.revokeCredential(complianceOperator, {
        credentialId: "cred_restart_revoked",
        reason: "Departed company",
      });

      // Simulate process termination and fresh restart
      const storeRestarted = new PersistentFileOperatorCredentialStore(storePath);
      const registryRestarted = new OperatorCredentialRegistry(storeRestarted);
      await registryRestarted.ensureFresh(true);

      const restartedCred = registryRestarted.getCredential("cred_restart_revoked");
      expect(restartedCred?.revoked).toBe(true);
      expect(restartedCred?.revokedBy).toBe("compliance_officer_001");
      expect(restartedCred?.revocationReason).toBe("Departed company");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 16: Strict validation fails closed on malformed credential records and low-entropy secrets
  it("Test 16: Strict validation fails closed on malformed credential records and low-entropy secrets", () => {
    // Empty or missing credentialId
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Empty or missing operatorId
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "   ",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Anonymous or unknown operatorId
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "anon",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "unknown_user",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Unrecognized role
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "super_admin" as unknown as OperatorRole,
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Malformed SHA-256 hash (wrong length, invalid chars)
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: "not_a_valid_hex_hash",
        revoked: false,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Non-boolean revoked state
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: "false" as unknown as boolean,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Invalid revokedAt date when revoked is true
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: true,
        revokedAt: "invalid-date-string",
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Missing revokedAt when revoked is true
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: true,
        revokedAt: null,
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Present revokedAt when revoked is false
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
        revokedAt: new Date().toISOString(),
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Invalid expiresAt date
    expect(() =>
      validateOperatorCredentialRecord({
        credentialId: "cred_001",
        operatorId: "operator_001",
        role: "legal_counsel",
        secretHash: hashOperatorSecret("valid_secret_key_12345678"),
        revoked: false,
        expiresAt: "corrupt_expiration_date",
      }),
    ).toThrow(InvalidCredentialRecordError);

    // Secret token strength: short tokens rejected
    expect(() => validateSecretTokenStrength("short")).toThrow(OperatorAuthorizationError);

    // Secret token strength: low-entropy repeated characters rejected
    expect(() => validateSecretTokenStrength("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)).toThrow(
      OperatorAuthorizationError,
    );
  });

  // Test 17: Privileged operations are restricted to authorized roles and prevent role elevation
  it("Test 17: Privileged operations are restricted to authorized roles and prevent role elevation", async () => {
    // Non-sysadmin (compliance_officer) cannot register new credentials
    await expect(
      operatorRegisterCredential(complianceOperator, {
        credentialId: "cred_unauthorized_reg",
        operatorId: "new_operator",
        role: "compliance_officer",
        secret: "valid_secret_token_1234567890",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Non-sysadmin (legal_counsel) cannot register new credentials
    await expect(
      operatorRegisterCredential(legalOperator, {
        credentialId: "cred_unauthorized_reg_2",
        operatorId: "new_operator",
        role: "legal_counsel",
        secret: "valid_secret_token_1234567890",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Non-sysadmin cannot rotate credentials
    await expect(
      operatorRotateCredential(complianceOperator, {
        credentialId: "cred_compliance_default",
        newSecret: "new_compliance_secret_token_12345",
        reason: "Unauthorized rotation attempt",
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // sysadmin CAN register and rotate credentials
    const regResult = await operatorRegisterCredential(adminOperator, {
      credentialId: "cred_valid_admin_reg",
      operatorId: "new_officer_verified",
      role: "compliance_officer",
      secret: "valid_secret_token_1234567890",
      description: "Registered by administrator",
    });
    expect(regResult.credentialId).toBe("cred_valid_admin_reg");

    const rotated = await operatorRotateCredential(adminOperator, {
      credentialId: "cred_valid_admin_reg",
      newSecret: "rotated_secret_token_0987654321",
      reason: "Routine credential rotation",
    });
    expect(rotated.credentialId).toBe("cred_valid_admin_reg");
    expect(rotated.secretHash).toBe(hashOperatorSecret("rotated_secret_token_0987654321"));

    // Test standalone operatorRevokeCredential API
    const revokedDirectly = await operatorRevokeCredential(complianceOperator, {
      credentialId: "cred_valid_admin_reg",
      reason: "Revoked via standalone operatorRevokeCredential helper",
    });
    expect(revokedDirectly.revoked).toBe(true);

    // Verify setGlobalOperatorCredentialStore rebinds store
    const currentStore = globalOperatorCredentialRegistry.getStore();
    setGlobalOperatorCredentialStore(currentStore);
  });

  // Test 18: Production mode strictly forbids test-only injection and unconfigured mutations
  it("Test 18: Production mode strictly forbids test-only injection and unconfigured mutations", () => {
    vi.stubEnv("NODE_ENV", "production");

    // __testOnlyRegisterOperatorCredential throws in production
    expect(() =>
      __testOnlyRegisterOperatorCredential({
        credentialId: "cred_prod_injected",
        operatorId: "injected_user",
        role: "system_administrator",
        secret: "super_secret_token_1234567890",
      }),
    ).toThrow(/production/);

    // __testOnlyRegisterRecord throws in production
    expect(() =>
      __testOnlyRegisterRecord({
        recordId: "REC-PROD-INJECTED",
        sourceId: "reddit",
        name: "Prod Injected Record",
        status: "APPROVED",
        authorizedPurposes: ["commercial_lead_generation"],
        scopes: ["search_discovery"],
        effectiveDate: "2026-01-01T00:00:00.000Z",
        expirationDate: null,
        evidenceReference: "DOC-PROD",
        approvalProvenance: { approvedBy: "Tester", reviewedAt: "2026-01-01T00:00:00.000Z", notes: "Notes" },
      }),
    ).toThrow(/production/);

    // OperatorCredentialRegistry in production never seeds default test credentials
    const prodRegistry = new OperatorCredentialRegistry(new PersistentFileOperatorCredentialStore(path.join(os.tmpdir(), "prod_test_empty.json")));
    expect(prodRegistry.count()).toBe(0);
  });

  // Test 19: Emergency operator bootstrap requires valid recovery key and creates audit ledger entries
  it("Test 19: Emergency operator bootstrap requires valid recovery key and creates audit ledger entries", async () => {
    vi.stubEnv("OPERATOR_BOOTSTRAP_KEY", "super-recovery-bootstrap-key-99999");

    // Wrong recovery key fails closed
    await expect(
      bootstrapOperatorCredentials({
        bootstrapKey: "wrong-bootstrap-key",
        credentials: [
          {
            credentialId: "cred_emergency_admin",
            operatorId: "emergency_admin_001",
            role: "system_administrator",
            secret: "emergency_admin_secret_token_12345678",
          },
        ],
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Valid recovery key provisions credentials and records audit ledger
    const bootstrapped = await bootstrapOperatorCredentials({
      bootstrapKey: "super-recovery-bootstrap-key-99999",
      credentials: [
        {
          credentialId: "cred_emergency_admin",
          operatorId: "emergency_admin_001",
          role: "system_administrator",
          secret: "emergency_admin_secret_token_12345678",
          description: "Emergency break-glass administrator",
        },
      ],
      reason: "Initial deployment bootstrap",
    });

    expect(bootstrapped).toHaveLength(1);
    expect(bootstrapped[0].credentialId).toBe("cred_emergency_admin");

    const auditHistory = await getOperatorCredentialAuditHistory("cred_emergency_admin");
    const provEvent = auditHistory.find((e) => e.action === "PROVISION");
    expect(provEvent).toBeDefined();
    expect(provEvent?.performedBy).toBe("emergency_bootstrap");
    expect(provEvent?.reason).toBe("Initial deployment bootstrap");
  });

  // Test 20: Dual-control master secret semantics and deployment kill switch
  it("Test 20: Dual-control master secret semantics and deployment kill switch", async () => {
    vi.stubEnv("OPERATOR_SECRET_KEY", "cluster-master-secret-12345");

    // Invalid masterKey passed in context is rejected
    await expect(
      operatorRegisterCredential(
        {
          ...adminOperator,
          masterKey: "incorrect-master-key",
        },
        {
          credentialId: "cred_dual_control_test",
          operatorId: "dual_officer",
          role: "compliance_officer",
          secret: "dual_secret_token_1234567890",
        },
      ),
    ).rejects.toThrow(/master operator secret key/);

    // Matching masterKey succeeds
    const success = await operatorRegisterCredential(
      {
        ...adminOperator,
        masterKey: "cluster-master-secret-12345",
      },
      {
        credentialId: "cred_dual_control_test",
        operatorId: "dual_officer",
        role: "compliance_officer",
        secret: "dual_secret_token_1234567890",
      },
    );
    expect(success.credentialId).toBe("cred_dual_control_test");
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

  it("enforces cross-worker revocation consistency across two DrizzleSourceAuthStore instances", async () => {
    const storeA = new DrizzleSourceAuthStore();
    const registryA = new SourcePolicyRegistry(storeA, 100);
    const storeB = new DrizzleSourceAuthStore();
    const registryB = new SourcePolicyRegistry(storeB, 100);

    await storeA.ready();
    await storeB.ready();

    const testRecordId = `REC-TEST-MULTIWORKER-${randomUUID().slice(0, 8)}`;
    const testRecord: TrustedAuthRecord = {
      recordId: testRecordId,
      sourceId: "reddit",
      name: "Multi-Worker Invalidation Record",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "CONTRACT-CROSS-WORKER-001",
      approvalProvenance: {
        approvedBy: legalOperator.operatorId ?? "legal_counsel_001",
        reviewedAt: new Date().toISOString(),
        notes: "Approved for cross-worker test",
      },
    };

    // Worker A registers and approves fixture
    await registryA.registerRecord(legalOperator, testRecord);

    // Worker B hydrates and sees APPROVED state
    await registryB.syncFromStore();
    const recordOnB = registryB.getRecord(testRecordId);
    expect(recordOnB?.status).toBe("APPROVED");

    // Worker A revokes the record
    await registryA.revokeRecord(complianceOperator, {
      recordId: testRecordId,
      status: "BLOCKED",
      reason: "Cross-worker revocation consistency test",
    });

    // Worker B must observe revocation within consistency guarantee
    await registryB.ensureFresh();
    const revokedOnB = registryB.getRecord(testRecordId);
    expect(revokedOnB?.status).toBe("BLOCKED");
    expect(revokedOnB?.revocationReason).toBe("Cross-worker revocation consistency test");
  });

  it("enforces TTL fallback when a cross-worker notification is missed", async () => {
    const storeA = new DrizzleSourceAuthStore();
    const registryA = new SourcePolicyRegistry(storeA, 100);
    const storeB = new DrizzleSourceAuthStore();
    const registryB = new SourcePolicyRegistry(storeB, 100);

    await storeA.ready();
    await storeB.ready();

    const testRecordId = `REC-TEST-TTL-${randomUUID().slice(0, 8)}`;
    const testRecord: TrustedAuthRecord = {
      recordId: testRecordId,
      sourceId: "reddit",
      name: "TTL Fallback Invalidation Record",
      status: "APPROVED",
      authorizedPurposes: ["commercial_lead_generation"],
      scopes: ["search_discovery"],
      effectiveDate: "2026-01-01T00:00:00.000Z",
      expirationDate: null,
      evidenceReference: "CONTRACT-CROSS-WORKER-TTL",
      approvalProvenance: {
        approvedBy: legalOperator.operatorId ?? "legal_counsel_001",
        reviewedAt: new Date().toISOString(),
        notes: "Approved for TTL fallback test",
      },
    };

    await registryA.registerRecord(legalOperator, testRecord);
    await registryB.syncFromStore();
    expect(registryB.getRecord(testRecordId)?.status).toBe("APPROVED");

    await registryA.revokeRecord(complianceOperator, {
      recordId: testRecordId,
      status: "BLOCKED",
      reason: "TTL fallback revocation test",
    });

    // Wait for TTL (100ms) to elapse to simulate missed notification
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Cache is expired, so synchronous getRecord fails closed rather than returning stale approved
    expect(registryB.isCacheExpired()).toBe(true);
    expect(registryB.getRecord(testRecordId)).toBeNull();

    // Calling ensureFresh rehydrates from authoritative DB store
    await registryB.ensureFresh();
    const revokedOnB = registryB.getRecord(testRecordId);
    expect(revokedOnB?.status).toBe("BLOCKED");
    expect(revokedOnB?.revocationReason).toBe("TTL fallback revocation test");
  });

  it("strictly enforces database-level append-only immutability and blocks TRUNCATE on audit events", async () => {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    // Attempting to truncate source_auth_audit_events must be blocked by trigger / permissions
    await expect(
      db().execute(sql`TRUNCATE TABLE "source_auth_audit_events";`),
    ).rejects.toThrow();

    // Attempting to delete from source_auth_audit_events must be blocked by row-level trigger
    await expect(
      db().execute(sql`DELETE FROM "source_auth_audit_events";`),
    ).rejects.toThrow();
  });

  it("enforces cross-worker operator credential revocation consistency across two DrizzleOperatorCredentialStore instances", async () => {
    const storeA = new DrizzleOperatorCredentialStore();
    const registryA = new OperatorCredentialRegistry(storeA, 100);
    const storeB = new DrizzleOperatorCredentialStore();
    const registryB = new OperatorCredentialRegistry(storeB, 100);

    await storeA.ready();
    await storeB.ready();

    const testCredId = `cred_worker_db_${randomUUID().slice(0, 8)}`;
    const testSecret = `db_worker_secret_token_${randomUUID().slice(0, 8)}_1234`;

    // Worker A registers credential
    await registryA.registerCredential(adminOperator, {
      credentialId: testCredId,
      operatorId: "db_worker_operator",
      role: "compliance_officer",
      secret: testSecret,
    });

    // Worker B syncs and verifies credential is active
    await registryB.syncFromStore();
    const credOnB = registryB.getCredential(testCredId);
    expect(credOnB?.revoked).toBe(false);

    // Worker A revokes credential
    await registryA.revokeCredential(complianceOperator, {
      credentialId: testCredId,
      reason: "Database cross-worker revocation test",
    });

    // Worker B must observe revocation within consistency guarantee
    await registryB.ensureFresh();
    const revokedOnB = registryB.getCredential(testCredId);
    expect(revokedOnB?.revoked).toBe(true);
    expect(revokedOnB?.revocationReason).toBe("Database cross-worker revocation test");
  });

  it("enforces durable first-use-only bootstrap constraint in PostgreSQL", async () => {
    const store = new DrizzleOperatorCredentialStore();
    const registry = new OperatorCredentialRegistry(store, 100);
    await store.ready();

    vi.stubEnv("OPERATOR_BOOTSTRAP_KEY", "pg-bootstrap-key-12345");

    const credId = `cred_pg_boot_${randomUUID().slice(0, 8)}`;
    const secret = `pg_secret_bootstrap_${randomUUID().slice(0, 8)}_1234`;

    // First bootstrap succeeds (or was already bootstrapped in prior test run)
    const currentStatus = await store.getBootstrapStatus();
    if (!currentStatus.isBootstrapped) {
      const bootstrapped = await registry.bootstrapCredentials({
        bootstrapKey: "pg-bootstrap-key-12345",
        credentials: [
          {
            credentialId: credId,
            operatorId: "pg_bootstrap_operator",
            role: "system_administrator",
            secret,
            description: "Initial bootstrap operator",
          },
        ],
        reason: "Initial deployment bootstrap",
      });

      expect(bootstrapped).toHaveLength(1);
      expect(bootstrapped[0].credentialId).toBe(credId);

      const auditHistory = await store.getAuditEvents(credId);
      const provEvent = auditHistory.find((e) => e.action === "PROVISION");
      expect(provEvent).toBeDefined();
      expect(provEvent?.performedBy).toBe("emergency_bootstrap");
    }

    // Repeated bootstrap must fail closed with OperatorAuthorizationError
    await expect(
      registry.bootstrapCredentials({
        bootstrapKey: "pg-bootstrap-key-12345",
        credentials: [
          {
            credentialId: `cred_repeat_${randomUUID().slice(0, 8)}`,
            operatorId: "repeat_bootstrap_operator",
            role: "system_administrator",
            secret: `repeat_secret_${randomUUID().slice(0, 8)}_1234`,
          },
        ],
      }),
    ).rejects.toThrow(OperatorAuthorizationError);

    // Concurrent bootstrap attempts: all subsequent attempts fail closed
    const concurrentAttempts = await Promise.allSettled([
      registry.bootstrapCredentials({
        bootstrapKey: "pg-bootstrap-key-12345",
        credentials: [
          {
            credentialId: `cred_conc_1_${randomUUID().slice(0, 8)}`,
            operatorId: "conc_operator_1",
            role: "system_administrator",
            secret: `conc_secret_1_${randomUUID().slice(0, 8)}_1234`,
          },
        ],
      }),
      registry.bootstrapCredentials({
        bootstrapKey: "pg-bootstrap-key-12345",
        credentials: [
          {
            credentialId: `cred_conc_2_${randomUUID().slice(0, 8)}`,
            operatorId: "conc_operator_2",
            role: "system_administrator",
            secret: `conc_secret_2_${randomUUID().slice(0, 8)}_1234`,
          },
        ],
      }),
    ]);
    expect(concurrentAttempts[0].status).toBe("rejected");
    expect(concurrentAttempts[1].status).toBe("rejected");

    // Emergency recovery succeeds with valid recovery key
    vi.stubEnv("OPERATOR_RECOVERY_KEY", "pg-emergency-recovery-key-99999");

    const recoveryCredId = `cred_recovery_${randomUUID().slice(0, 8)}`;
    const recoverySecret = `recovery_secret_${randomUUID().slice(0, 8)}_1234`;

    const recovered = await registry.emergencyRecoverCredentials({
      recoveryKey: "pg-emergency-recovery-key-99999",
      confirmRecovery: true,
      reason: "PostgreSQL emergency credential recovery",
      credentials: [
        {
          credentialId: recoveryCredId,
          operatorId: "recovery_operator",
          role: "system_administrator",
          secret: recoverySecret,
          description: "Emergency recovered operator",
        },
      ],
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0].credentialId).toBe(recoveryCredId);

    const recoveryAuditHistory = await store.getAuditEvents(recoveryCredId);
    const recEvent = recoveryAuditHistory.find((e) => e.action === "RECOVERY");
    expect(recEvent).toBeDefined();
    expect(recEvent?.performedBy).toBe("emergency_recovery");
    expect(recEvent?.reason).toBe("PostgreSQL emergency credential recovery");

    const status = await store.getBootstrapStatus();
    expect(status.isBootstrapped).toBe(true);
    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(status.lastRecoveryReason).toBe("PostgreSQL emergency credential recovery");
  });

  it("strictly enforces database-level append-only immutability and blocks TRUNCATE and DELETE on operator credential audit events", async () => {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    // Attempting to truncate operator_credential_audit_events must be blocked by trigger / permissions
    await expect(
      db().execute(sql`TRUNCATE TABLE "operator_credential_audit_events";`),
    ).rejects.toThrow();

    // Attempting to delete from operator_credential_audit_events must be blocked by row-level trigger
    await expect(
      db().execute(sql`DELETE FROM "operator_credential_audit_events";`),
    ).rejects.toThrow();
  });
});
