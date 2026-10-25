import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { config } from "./config";
import {
  type OperatorRole,
  type VerifiedOperator,
  type OperatorCredentialRecord,
  type OperatorCredentialAuditEvent,
  type OperatorCredentialAction,
  type OperatorCredentialStore,
  type OperatorContext,
  VALID_OPERATOR_ROLES,
  OperatorAuthorizationError,
  InvalidCredentialRecordError,
  verifyOperatorCredentials,
  globalOperatorCredentialRegistry,
  hashOperatorSecret,
  safeCompareHashes,
  safeCompareStrings,
  validateSecretTokenStrength,
  validateOperatorCredentialRecord,
  operatorRegisterCredential,
  operatorRevokeCredential,
  operatorRotateCredential,
  bootstrapOperatorCredentials,
  getOperatorCredentialAuditHistory,
  setGlobalOperatorCredentialStore,
  initOperatorCredentialRegistry,
  ensureOperatorCredentialFresh,
  __testOnlyRegisterOperatorCredential,
  DrizzleOperatorCredentialStore,
  PersistentFileOperatorCredentialStore,
  OperatorCredentialRegistry,
} from "./operatorAuth";

export {
  type OperatorRole,
  type VerifiedOperator,
  type OperatorCredentialRecord,
  type OperatorCredentialAuditEvent,
  type OperatorCredentialAction,
  type OperatorCredentialStore,
  type OperatorContext,
  VALID_OPERATOR_ROLES,
  OperatorAuthorizationError,
  InvalidCredentialRecordError,
  verifyOperatorCredentials,
  globalOperatorCredentialRegistry,
  OperatorCredentialRegistry,
  hashOperatorSecret,
  safeCompareHashes,
  safeCompareStrings,
  validateSecretTokenStrength,
  validateOperatorCredentialRecord,
  operatorRegisterCredential,
  operatorRevokeCredential,
  operatorRotateCredential,
  bootstrapOperatorCredentials,
  getOperatorCredentialAuditHistory,
  setGlobalOperatorCredentialStore,
  initOperatorCredentialRegistry,
  ensureOperatorCredentialFresh,
  __testOnlyRegisterOperatorCredential,
  DrizzleOperatorCredentialStore,
  PersistentFileOperatorCredentialStore,
};

export type SourceId =
  | "reddit"
  | "x"
  | "google_scraped_serp"
  | "google_official_api"
  | "google_serp"
  | "website_crawler"
  | "unclassified";

export type SourceAuthStatus = "PENDING" | "APPROVED" | "BLOCKED" | "EXPIRED";

export const SOURCE_USAGE_PURPOSES = [
  "commercial_lead_generation",
  "competitor_intelligence",
  "seo_opportunity_discovery",
  "customer_website_coverage",
  "social_intent_monitoring",
  "compliance_audit",
  "read_only_audit",
  "academic_research",
] as const;

export type SourceUsagePurpose = (typeof SOURCE_USAGE_PURPOSES)[number];

export const SOURCE_USAGE_SCOPES = [
  "search_discovery",
  "social_content_read",
  "comments_read",
  "profile_metadata_read",
  "customer_domain_crawl",
  "commercial_indexing",
  "social_intent_monitoring",
  "read_only_audit",
  "test_scope",
] as const;

export type SourceUsageScope = (typeof SOURCE_USAGE_SCOPES)[number];

export type TrustedAuthRecord = {
  recordId: string;
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus;
  authorizedPurposes: SourceUsagePurpose[];
  scopes: SourceUsageScope[];
  effectiveDate: string; // ISO 8601
  expirationDate: string | null; // ISO 8601 or null
  evidenceReference: string;
  approvalProvenance: {
    approvedBy: string;
    reviewedAt: string;
    notes: string;
  };
  revocationReason?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  updatedAt?: string;
};


export type SourceAuthAuditEvent = {
  id: string;
  recordId: string;
  action: "REGISTER" | "APPROVE" | "UPDATE" | "REVOKE";
  performedBy: string;
  actorRole: string;
  evidenceReference: string;
  reason: string;
  previousStatus: SourceAuthStatus | null;
  newStatus: SourceAuthStatus;
  details?: Record<string, unknown>;
  createdAt: string; // ISO 8601
};

export type SourceOperationId =
  | "lead_search"
  | "lead_subreddit_posts"
  | "lead_post"
  | "lead_comments"
  | "lead_profile"
  | "lead_subreddit_details"
  | "competitor_search"
  | "competitor_post"
  | "seo_google_search"
  | "seo_post"
  | "x_search"
  | "x_tweet"
  | "x_profile"
  | "website_crawl";

export type SourceOperationRequest = {
  operationId?: SourceOperationId;
  sourceId: SourceId;
  purpose: SourceUsagePurpose;
  scope: SourceUsageScope;
  now?: Date;
  authRecordIdOverride?: string;
};

export type SourcePolicyOptions = {
  now?: Date;
  purpose?: SourceUsagePurpose;
  scope?: SourceUsageScope;
  authRecordIdOverride?: string;
};

export type SourcePolicy = {
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus;
  enabled: boolean;
  authRecordId: string | null;
  commercialUsePermitted: boolean;
  authorizedPurposes: SourceUsagePurpose[];
  authorizedScopes: SourceUsageScope[];
  requestedPurpose?: SourceUsagePurpose;
  requestedScope?: SourceUsageScope;
  reason: string;
  legalDisclaimer: string;
  record?: TrustedAuthRecord | null;
};

export class SourceUnauthorizedError extends Error {
  readonly sourceId: SourceId;
  readonly status: SourceAuthStatus;
  readonly recordId: string | null;

  constructor(
    sourceId: SourceId,
    message: string,
    status: SourceAuthStatus = "BLOCKED",
    recordId: string | null = null,
  ) {
    super(`[Source Gate: ${sourceId}] ${message}`);
    this.name = "SourceUnauthorizedError";
    this.sourceId = sourceId;
    this.status = status;
    this.recordId = recordId;
  }
}

export class InvalidAuthRecordError extends Error {
  constructor(message: string) {
    super(`[Invalid Authorization Record] ${message}`);
    this.name = "InvalidAuthRecordError";
  }
}

export const PLACEHOLDER_RECORD_IDS = new Set([
  "none",
  "pending",
  "unverified",
  "todo",
  "test",
  "null",
  "false",
  "",
]);

/**
 * Authoritative default trusted records documented in docs/source-authorization-register.md.
 * Human operators must verify legal sufficiency before creating or approving records.
 */
export const DEFAULT_TRUSTED_REGISTRY: TrustedAuthRecord[] = [
  {
    recordId: "REC-REDDIT-COMMERCIAL-UNVERIFIED",
    sourceId: "reddit",
    name: "Reddit (via AnyAPI Gateway)",
    status: "BLOCKED",
    authorizedPurposes: [
      "commercial_lead_generation",
      "competitor_intelligence",
      "seo_opportunity_discovery",
    ],
    scopes: [
      "commercial_indexing",
      "search_discovery",
      "social_content_read",
      "comments_read",
    ],
    effectiveDate: "2026-10-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "https://www.redditinc.com/policies/data-api-terms (Direct commercial contract not executed)",
    approvalProvenance: {
      approvedBy: "Legal and Compliance Review",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "BLOCKED launch blocker: AnyAPI gateway proxy does not convey commercial rights from Reddit Inc. Direct developer licensing required.",
    },
  },
  {
    recordId: "REC-X-PILOT-REVIEW",
    sourceId: "x",
    name: "X / Twitter (via AnyAPI Gateway)",
    status: "PENDING",
    authorizedPurposes: ["social_intent_monitoring"],
    scopes: [
      "social_intent_monitoring",
      "search_discovery",
      "social_content_read",
      "profile_metadata_read",
    ],
    effectiveDate: "2026-10-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "https://developer.x.com/en/more/developer-terms/agreement-and-policy",
    approvalProvenance: {
      approvedBy: "Operations and Legal Review",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "PENDING: Enterprise terms under pilot review. Paid calls, cache reuse, and serving are denied until approved.",
    },
  },
  {
    recordId: "REC-GOOGLE-ANYAPI-SCRAPED",
    sourceId: "google_scraped_serp",
    name: "Google Search (AnyAPI Scraped SERP)",
    status: "BLOCKED",
    authorizedPurposes: ["seo_opportunity_discovery"],
    scopes: ["search_discovery"],
    effectiveDate: "2026-10-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "https://policies.google.com/terms (Automated queries prohibited)",
    approvalProvenance: {
      approvedBy: "Architecture and Legal Review",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "BLOCKED: Scraped SERP via third-party proxy violates Google ToS without an official Google Cloud contract.",
    },
  },
  {
    recordId: "REC-GOOGLE-OFFICIAL-CSE",
    sourceId: "google_official_api",
    name: "Google Custom Search (Official API)",
    status: "BLOCKED",
    authorizedPurposes: ["seo_opportunity_discovery"],
    scopes: ["search_discovery"],
    effectiveDate: "2026-10-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "https://developers.google.com/custom-search/v1/overview",
    approvalProvenance: {
      approvedBy: "Architecture Review",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "BLOCKED: Official Google Custom Search API credentials not configured in deployment.",
    },
  },
  {
    recordId: "REC-WEBSITE-CRAWLER-FIRST-PARTY",
    sourceId: "website_crawler",
    name: "Target Website Web Crawler",
    status: "APPROVED",
    authorizedPurposes: ["customer_website_coverage", "read_only_audit"],
    scopes: ["customer_domain_crawl", "read_only_audit"],
    effectiveDate: "2026-01-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "Customer Service Agreement (First-Party Domain Verification)",
    approvalProvenance: {
      approvedBy: "Security and Architecture Review",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "APPROVED: In-house connection-pinned crawler restricted to customer-authenticated domains with SSRF/DNS-rebinding protection.",
    },
  },
  {
    recordId: "REC-LLM-INFERENCE-GATEWAY",
    sourceId: "unclassified",
    name: "LLM Gateway Inference (OpenRouter / Vercel AI Gateway)",
    status: "APPROVED",
    authorizedPurposes: [
      "commercial_lead_generation",
      "competitor_intelligence",
      "seo_opportunity_discovery",
    ],
    scopes: ["commercial_indexing"],
    effectiveDate: "2026-01-01T00:00:00.000Z",
    expirationDate: null,
    evidenceReference: "OpenRouter Terms of Service & Vercel AI Gateway Data Processing Agreements",
    approvalProvenance: {
      approvedBy: "Information Security & Compliance",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      notes: "APPROVED: Multi-provider DPAs in place prohibiting model training on customer prompt payloads.",
    },
  },
];

export const ACQUISITION_OPERATIONS = {
  lead_search: {
    operationId: "lead_search" as const,
    sourceId: "reddit" as const,
    sku: "reddit.search",
    kind: "keyword",
    purpose: "commercial_lead_generation" as const,
    scope: "search_discovery" as const,
  },
  lead_subreddit_posts: {
    operationId: "lead_subreddit_posts" as const,
    sourceId: "reddit" as const,
    sku: "reddit.subreddit_posts",
    kind: "subreddit_posts",
    purpose: "commercial_lead_generation" as const,
    scope: "search_discovery" as const,
  },
  lead_post: {
    operationId: "lead_post" as const,
    sourceId: "reddit" as const,
    sku: "reddit.post",
    kind: "post",
    purpose: "commercial_lead_generation" as const,
    scope: "social_content_read" as const,
  },
  lead_comments: {
    operationId: "lead_comments" as const,
    sourceId: "reddit" as const,
    sku: "reddit.post_comments",
    kind: "comments",
    purpose: "commercial_lead_generation" as const,
    scope: "comments_read" as const,
  },
  lead_profile: {
    operationId: "lead_profile" as const,
    sourceId: "reddit" as const,
    sku: "reddit.avatar",
    kind: "profile",
    purpose: "commercial_lead_generation" as const,
    scope: "profile_metadata_read" as const,
  },
  lead_subreddit_details: {
    operationId: "lead_subreddit_details" as const,
    sourceId: "reddit" as const,
    sku: "reddit.subreddit_details",
    kind: "subreddit",
    purpose: "commercial_lead_generation" as const,
    scope: "search_discovery" as const,
  },
  competitor_search: {
    operationId: "competitor_search" as const,
    sourceId: "reddit" as const,
    sku: "reddit.search",
    kind: "keyword",
    purpose: "competitor_intelligence" as const,
    scope: "search_discovery" as const,
  },
  competitor_post: {
    operationId: "competitor_post" as const,
    sourceId: "reddit" as const,
    sku: "reddit.post",
    kind: "post",
    purpose: "competitor_intelligence" as const,
    scope: "social_content_read" as const,
  },
  seo_google_search: {
    operationId: "seo_google_search" as const,
    sourceId: "google_scraped_serp" as const,
    sku: "google.search",
    kind: "serp",
    purpose: "seo_opportunity_discovery" as const,
    scope: "search_discovery" as const,
  },
  seo_post: {
    operationId: "seo_post" as const,
    sourceId: "reddit" as const,
    sku: "reddit.post",
    kind: "post",
    purpose: "seo_opportunity_discovery" as const,
    scope: "social_content_read" as const,
  },
  x_search: {
    operationId: "x_search" as const,
    sourceId: "x" as const,
    sku: "twitter.search",
    kind: "x_search",
    purpose: "social_intent_monitoring" as const,
    scope: "search_discovery" as const,
  },
  x_tweet: {
    operationId: "x_tweet" as const,
    sourceId: "x" as const,
    sku: "twitter.tweet",
    kind: "x_tweet",
    purpose: "social_intent_monitoring" as const,
    scope: "social_content_read" as const,
  },
  x_profile: {
    operationId: "x_profile" as const,
    sourceId: "x" as const,
    sku: "twitter.profile",
    kind: "x_profile",
    purpose: "social_intent_monitoring" as const,
    scope: "profile_metadata_read" as const,
  },
  website_crawl: {
    operationId: "website_crawl" as const,
    sourceId: "website_crawler" as const,
    sku: "website.crawl",
    kind: "website_crawl",
    purpose: "customer_website_coverage" as const,
    scope: "customer_domain_crawl" as const,
  },
} as const;

export const REDDIT_LEADS_READ_OP: SourceOperationRequest = {
  operationId: "lead_post",
  sourceId: "reddit",
  purpose: "commercial_lead_generation",
  scope: "social_content_read",
};

export const COMPETITOR_READ_OP: SourceOperationRequest = {
  operationId: "competitor_post",
  sourceId: "reddit",
  purpose: "competitor_intelligence",
  scope: "social_content_read",
};

export const COMPETITOR_SCAN_OP: SourceOperationRequest = {
  operationId: "competitor_search",
  sourceId: "reddit",
  purpose: "competitor_intelligence",
  scope: "search_discovery",
};

export const SEO_READ_OP: SourceOperationRequest = {
  operationId: "seo_post",
  sourceId: "reddit",
  purpose: "seo_opportunity_discovery",
  scope: "social_content_read",
};

export const REDDIT_ALERT_OP: SourceOperationRequest = {
  operationId: "lead_post",
  sourceId: "reddit",
  purpose: "commercial_lead_generation",
  scope: "social_content_read",
};

export const X_ALERT_OP: SourceOperationRequest = {
  operationId: "x_tweet",
  sourceId: "x",
  purpose: "social_intent_monitoring",
  scope: "social_content_read",
};

export const REDDIT_API_LEADS_OP: SourceOperationRequest = {
  operationId: "lead_post",
  sourceId: "reddit",
  purpose: "commercial_lead_generation",
  scope: "social_content_read",
};

export const REDDIT_API_SEO_OP: SourceOperationRequest = {
  operationId: "seo_post",
  sourceId: "reddit",
  purpose: "seo_opportunity_discovery",
  scope: "social_content_read",
};

export const X_READ_OP: SourceOperationRequest = {
  operationId: "x_tweet",
  sourceId: "x",
  purpose: "social_intent_monitoring",
  scope: "social_content_read",
};

export const X_SCAN_OP: SourceOperationRequest = {
  operationId: "x_search",
  sourceId: "x",
  purpose: "social_intent_monitoring",
  scope: "search_discovery",
};

function cloneAndFreezeRecord(record: TrustedAuthRecord): TrustedAuthRecord {
  const cloned: TrustedAuthRecord = {
    recordId: record.recordId,
    sourceId: record.sourceId,
    name: record.name,
    status: record.status,
    authorizedPurposes: [...record.authorizedPurposes],
    scopes: [...record.scopes],
    effectiveDate: record.effectiveDate,
    expirationDate: record.expirationDate,
    evidenceReference: record.evidenceReference,
    approvalProvenance: {
      approvedBy: record.approvalProvenance.approvedBy,
      reviewedAt: record.approvalProvenance.reviewedAt,
      notes: record.approvalProvenance.notes,
    },
    revocationReason: record.revocationReason ?? null,
    revokedAt: record.revokedAt ?? null,
    revokedBy: record.revokedBy ?? null,
    updatedAt: record.updatedAt,
  };
  Object.freeze(cloned.authorizedPurposes);
  Object.freeze(cloned.scopes);
  Object.freeze(cloned.approvalProvenance);
  return Object.freeze(cloned);
}

export function validateTrustedAuthRecord(record: unknown): TrustedAuthRecord {
  if (!record || typeof record !== "object") {
    throw new InvalidAuthRecordError("Record must be a non-null object.");
  }
  const r = record as Record<string, unknown>;

  if (typeof r.recordId !== "string" || !r.recordId.trim()) {
    throw new InvalidAuthRecordError("recordId must be a non-empty string.");
  }
  const recordId = r.recordId.trim();
  if (PLACEHOLDER_RECORD_IDS.has(recordId.toLowerCase())) {
    throw new InvalidAuthRecordError(`recordId cannot be a placeholder string ('${recordId}').`);
  }

  const validSources: SourceId[] = [
    "reddit",
    "x",
    "google_scraped_serp",
    "google_official_api",
    "google_serp",
    "website_crawler",
    "unclassified",
  ];
  if (!validSources.includes(r.sourceId as SourceId)) {
    throw new InvalidAuthRecordError(`Invalid sourceId '${String(r.sourceId)}'.`);
  }
  const sourceId = r.sourceId as SourceId;

  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new InvalidAuthRecordError("name must be a non-empty string.");
  }

  const validStatuses: SourceAuthStatus[] = ["PENDING", "APPROVED", "BLOCKED", "EXPIRED"];
  if (!validStatuses.includes(r.status as SourceAuthStatus)) {
    throw new InvalidAuthRecordError(`Invalid status '${String(r.status)}'.`);
  }
  const status = r.status as SourceAuthStatus;

  if (!Array.isArray(r.authorizedPurposes) || r.authorizedPurposes.length === 0) {
    throw new InvalidAuthRecordError("authorizedPurposes must be a non-empty array.");
  }
  for (const p of r.authorizedPurposes) {
    if (!SOURCE_USAGE_PURPOSES.includes(p as SourceUsagePurpose)) {
      throw new InvalidAuthRecordError(`Unsupported purpose '${String(p)}'.`);
    }
  }
  const authorizedPurposes = [...r.authorizedPurposes] as SourceUsagePurpose[];

  if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
    throw new InvalidAuthRecordError("scopes must be a non-empty array.");
  }
  for (const s of r.scopes) {
    if (!SOURCE_USAGE_SCOPES.includes(s as SourceUsageScope)) {
      throw new InvalidAuthRecordError(`Unsupported scope '${String(s)}'.`);
    }
  }
  const scopes = [...r.scopes] as SourceUsageScope[];

  if (typeof r.effectiveDate !== "string" || isNaN(new Date(r.effectiveDate).getTime())) {
    throw new InvalidAuthRecordError(`Invalid effectiveDate '${String(r.effectiveDate)}'.`);
  }
  const effectiveDate = r.effectiveDate;

  let expirationDate: string | null = null;
  if (r.expirationDate !== null && r.expirationDate !== undefined) {
    if (typeof r.expirationDate !== "string" || isNaN(new Date(r.expirationDate).getTime())) {
      throw new InvalidAuthRecordError(`Invalid expirationDate '${String(r.expirationDate)}'.`);
    }
    if (new Date(effectiveDate).getTime() > new Date(r.expirationDate).getTime()) {
      throw new InvalidAuthRecordError(
        `effectiveDate '${effectiveDate}' cannot be after expirationDate '${r.expirationDate}'.`,
      );
    }
    expirationDate = r.expirationDate;
  }

  if (typeof r.evidenceReference !== "string" || !r.evidenceReference.trim()) {
    throw new InvalidAuthRecordError("evidenceReference must be a non-empty string.");
  }

  if (!r.approvalProvenance || typeof r.approvalProvenance !== "object") {
    throw new InvalidAuthRecordError("approvalProvenance must be a non-null object.");
  }
  const prov = r.approvalProvenance as Record<string, unknown>;
  if (typeof prov.approvedBy !== "string" || !prov.approvedBy.trim()) {
    throw new InvalidAuthRecordError("approvalProvenance.approvedBy must be a non-empty string.");
  }
  if (typeof prov.reviewedAt !== "string" || isNaN(new Date(prov.reviewedAt).getTime())) {
    throw new InvalidAuthRecordError(
      `approvalProvenance.reviewedAt must be a valid date ('${String(prov.reviewedAt)}').`,
    );
  }
  if (typeof prov.notes !== "string" || !prov.notes.trim()) {
    throw new InvalidAuthRecordError("approvalProvenance.notes must be a non-empty string.");
  }

  return {
    recordId,
    sourceId,
    name: (r.name as string).trim(),
    status,
    authorizedPurposes,
    scopes,
    effectiveDate,
    expirationDate,
    evidenceReference: (r.evidenceReference as string).trim(),
    approvalProvenance: {
      approvedBy: (prov.approvedBy as string).trim(),
      reviewedAt: prov.reviewedAt as string,
      notes: (prov.notes as string).trim(),
    },
    revocationReason: typeof r.revocationReason === "string" ? r.revocationReason : null,
    revokedAt: typeof r.revokedAt === "string" ? r.revokedAt : null,
    revokedBy: typeof r.revokedBy === "string" ? r.revokedBy : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
  };
}

export function assertAuthorizedOperator(
  context: unknown,
  requiredRoles?: OperatorRole | OperatorRole[],
): VerifiedOperator {
  return verifyOperatorCredentials(context, requiredRoles);
}

/**
 * Validates that an acquisition workflow matches permitted source and scope parameters.
 * Ordinary callers cannot bypass this check by supplying arbitrary combinations.
 */
export function isPermittedAcquisitionOperation(
  sku: string,
  kind: string,
  purpose: SourceUsagePurpose,
  scope: SourceUsageScope,
  operationId?: SourceOperationId,
): boolean {
  let expectedSource: SourceId;
  try {
    expectedSource = sourceForSku(sku);
  } catch {
    return false;
  }

  if (operationId) {
    const def = ACQUISITION_OPERATIONS[operationId];
    if (!def) {
      return false;
    }
    return (
      def.operationId === operationId &&
      def.sku === sku &&
      def.kind === kind &&
      def.purpose === purpose &&
      def.scope === scope &&
      def.sourceId === expectedSource
    );
  }

  return Object.values(ACQUISITION_OPERATIONS).some(
    (def) =>
      def.sku === sku &&
      def.kind === kind &&
      def.purpose === purpose &&
      def.scope === scope &&
      def.sourceId === expectedSource,
  );
}

export function findAcquisitionOperation(
  sku: string,
  kind: string,
  purpose: SourceUsagePurpose,
  scope: SourceUsageScope,
): (typeof ACQUISITION_OPERATIONS)[keyof typeof ACQUISITION_OPERATIONS] | undefined {
  return Object.values(ACQUISITION_OPERATIONS).find(
    (def) =>
      def.sku === sku &&
      def.kind === kind &&
      def.purpose === purpose &&
      def.scope === scope,
  );
}

export type InvalidationPayload = {
  recordId?: string;
  action?: string;
  status?: string;
};

export type InvalidationCallback = (payload: InvalidationPayload) => void;

export interface SourceAuthStore {
  getRecord(recordId: string): Promise<TrustedAuthRecord | null>;
  getAllRecords(): Promise<TrustedAuthRecord[]>;
  saveRecord(record: TrustedAuthRecord, auditEvent: SourceAuthAuditEvent): Promise<void>;
  revokeRecord(
    recordId: string,
    revocation: {
      status: "BLOCKED" | "EXPIRED";
      reason: string;
      revokedBy: string;
      revokedAt?: string;
    },
    auditEvent: SourceAuthAuditEvent,
  ): Promise<TrustedAuthRecord>;
  getAuditEvents(recordId?: string): Promise<SourceAuthAuditEvent[]>;
  resetToDefaults?(): Promise<void>;
  subscribeInvalidation?(callback: InvalidationCallback): () => void;
  checkInvalidated?(sinceMs: number): boolean;
  readStateSync?(): TrustedAuthRecord[];
}

const fileStoreEventBus = new EventEmitter();
fileStoreEventBus.setMaxListeners(100);

/**
 * File-backed persistent storage implementation supporting cross-worker/cross-process
 * durability simulations and offline testing without external database dependencies.
 */
export class PersistentFileSourceAuthStore implements SourceAuthStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.SOURCE_AUTH_REGISTRY_PATH ??
      path.join(os.tmpdir(), "leystic_source_auth_registry.json");
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    if (!fs.existsSync(this.filePath)) {
      const records: Record<string, TrustedAuthRecord> = {};
      const auditEvents: SourceAuthAuditEvent[] = [];
      for (const r of DEFAULT_TRUSTED_REGISTRY) {
        records[r.recordId] = r;
        auditEvents.push({
          id: `seed_${randomUUID().slice(0, 8)}`,
          recordId: r.recordId,
          action: "REGISTER",
          performedBy: r.approvalProvenance.approvedBy,
          actorRole: "compliance_officer",
          evidenceReference: r.evidenceReference,
          reason: `Initial register seeding: ${r.status}`,
          previousStatus: null,
          newStatus: r.status,
          createdAt: new Date().toISOString(),
        });
      }
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ records, auditEvents }, null, 2),
        "utf8",
      );
    }
  }

  private readState(): {
    records: Record<string, TrustedAuthRecord>;
    auditEvents: SourceAuthAuditEvent[];
  } {
    this.ensureInitialized();
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return { records: {}, auditEvents: [] };
    }
  }

  readStateSync(): TrustedAuthRecord[] {
    const state = this.readState();
    return Object.values(state.records);
  }

  private writeState(state: {
    records: Record<string, TrustedAuthRecord>;
    auditEvents: SourceAuthAuditEvent[];
  }): void {
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  async getRecord(recordId: string): Promise<TrustedAuthRecord | null> {
    const state = this.readState();
    const found = state.records[recordId.trim()];
    return found ? cloneAndFreezeRecord(validateTrustedAuthRecord(found)) : null;
  }

  async getAllRecords(): Promise<TrustedAuthRecord[]> {
    const state = this.readState();
    return Object.values(state.records).map((r) => cloneAndFreezeRecord(validateTrustedAuthRecord(r)));
  }

  async saveRecord(record: TrustedAuthRecord, auditEvent: SourceAuthAuditEvent): Promise<void> {
    const state = this.readState();
    state.records[record.recordId] = record;
    state.auditEvents.push(auditEvent);
    this.writeState(state);
    fileStoreEventBus.emit("invalidation", {
      filePath: this.filePath,
      recordId: record.recordId,
      action: auditEvent.action,
    });
  }

  async revokeRecord(
    recordId: string,
    revocation: {
      status: "BLOCKED" | "EXPIRED";
      reason: string;
      revokedBy: string;
      revokedAt?: string;
    },
    auditEvent: SourceAuthAuditEvent,
  ): Promise<TrustedAuthRecord> {
    const state = this.readState();
    const existing = state.records[recordId.trim()];
    if (!existing) {
      throw new Error(`Cannot revoke record '${recordId}': record not found in trusted registry.`);
    }
    const updated: TrustedAuthRecord = {
      ...existing,
      status: revocation.status,
      revocationReason: revocation.reason,
      revokedAt: revocation.revokedAt ?? new Date().toISOString(),
      revokedBy: revocation.revokedBy,
      approvalProvenance: {
        approvedBy: revocation.revokedBy,
        reviewedAt: revocation.revokedAt ?? new Date().toISOString(),
        notes: `REVOKED (${revocation.status}): ${revocation.reason}. Prior notes: ${existing.approvalProvenance.notes}`,
      },
      updatedAt: new Date().toISOString(),
    };
    state.records[recordId.trim()] = updated;
    state.auditEvents.push(auditEvent);
    this.writeState(state);
    fileStoreEventBus.emit("invalidation", {
      filePath: this.filePath,
      recordId,
      action: "REVOKE",
      status: revocation.status,
    });
    return cloneAndFreezeRecord(validateTrustedAuthRecord(updated));
  }

  async getAuditEvents(recordId?: string): Promise<SourceAuthAuditEvent[]> {
    const state = this.readState();
    if (!recordId) return [...state.auditEvents];
    return state.auditEvents.filter((e) => e.recordId === recordId.trim());
  }

  async resetToDefaults(): Promise<void> {
    if (fs.existsSync(this.filePath)) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // ignore
      }
    }
    this.ensureInitialized();
    fileStoreEventBus.emit("invalidation", { filePath: this.filePath });
  }

  subscribeInvalidation(callback: InvalidationCallback): () => void {
    const handler = (evt: { filePath: string; recordId?: string; action?: string; status?: string }) => {
      if (evt.filePath === this.filePath) {
        callback({ recordId: evt.recordId, action: evt.action, status: evt.status });
      }
    };
    fileStoreEventBus.on("invalidation", handler);
    return () => {
      fileStoreEventBus.off("invalidation", handler);
    };
  }

  checkInvalidated(sinceMs: number): boolean {
    try {
      if (!fs.existsSync(this.filePath)) return false;
      const stats = fs.statSync(this.filePath);
      return stats.mtimeMs > sinceMs;
    } catch {
      return true;
    }
  }
}

/**
 * Database-backed persistent storage using Drizzle ORM and PostgreSQL transactions.
 */
export class DrizzleSourceAuthStore implements SourceAuthStore {
  private invalidationListeners: Set<InvalidationCallback> = new Set();
  private isListening = false;
  private unsubscribeClient?: () => Promise<void>;

  subscribeInvalidation(callback: InvalidationCallback): () => void {
    this.invalidationListeners.add(callback);
    void this.ensureListening();
    return () => {
      this.invalidationListeners.delete(callback);
    };
  }

  private async ensureListening(): Promise<void> {
    if (this.isListening) return;
    this.isListening = true;
    try {
      const postgres = (await import("postgres")).default;
      const { config } = await import("@/lib/config");
      const client = postgres(config().DATABASE_URL, { max: 1, idle_timeout: 0 });
      const { unlisten } = await client.listen("source_auth_invalidation", (msg) => {
        try {
          const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
          for (const listener of this.invalidationListeners) {
            listener(parsed);
          }
        } catch {
          for (const listener of this.invalidationListeners) {
            listener({});
          }
        }
      });
      this.unsubscribeClient = async () => {
        try {
          await unlisten();
          await client.end({ timeout: 1 });
        } catch {
          // ignore
        }
      };
    } catch {
      this.isListening = false;
    }
  }

  async getRecord(recordId: string): Promise<TrustedAuthRecord | null> {
    const { db } = await import("@/db");
    const { sourceAuthRecords } = await import("@/db/schema/sourceAuth");
    const { eq } = await import("drizzle-orm");

    const rows = await db()
      .select()
      .from(sourceAuthRecords)
      .where(eq(sourceAuthRecords.recordId, recordId.trim()))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return cloneAndFreezeRecord(
      validateTrustedAuthRecord({
        recordId: row.recordId,
        sourceId: row.sourceId as SourceId,
        name: row.name,
        status: row.status as SourceAuthStatus,
        authorizedPurposes: row.authorizedPurposes,
        scopes: row.scopes,
        effectiveDate: row.effectiveDate.toISOString(),
        expirationDate: row.expirationDate ? row.expirationDate.toISOString() : null,
        evidenceReference: row.evidenceReference,
        approvalProvenance: row.approvalProvenance,
        revocationReason: row.revocationReason,
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        revokedBy: row.revokedBy,
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  }

  async getAllRecords(): Promise<TrustedAuthRecord[]> {
    const { db } = await import("@/db");
    const { sourceAuthRecords } = await import("@/db/schema/sourceAuth");

    const rows = await db().select().from(sourceAuthRecords);
    return rows.map((row) =>
      cloneAndFreezeRecord(
        validateTrustedAuthRecord({
          recordId: row.recordId,
          sourceId: row.sourceId as SourceId,
          name: row.name,
          status: row.status as SourceAuthStatus,
          authorizedPurposes: row.authorizedPurposes,
          scopes: row.scopes,
          effectiveDate: row.effectiveDate.toISOString(),
          expirationDate: row.expirationDate ? row.expirationDate.toISOString() : null,
          evidenceReference: row.evidenceReference,
          approvalProvenance: row.approvalProvenance,
          revocationReason: row.revocationReason,
          revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
          revokedBy: row.revokedBy,
          updatedAt: row.updatedAt.toISOString(),
        }),
      ),
    );
  }

  async saveRecord(record: TrustedAuthRecord, auditEvent: SourceAuthAuditEvent): Promise<void> {
    const { db } = await import("@/db");
    const { sourceAuthRecords, sourceAuthAuditEvents } = await import("@/db/schema/sourceAuth");
    const { sql } = await import("drizzle-orm");

    await db().transaction(async (tx) => {
      await tx
        .insert(sourceAuthRecords)
        .values({
          recordId: record.recordId,
          sourceId: record.sourceId,
          name: record.name,
          status: record.status,
          authorizedPurposes: record.authorizedPurposes,
          scopes: record.scopes,
          effectiveDate: new Date(record.effectiveDate),
          expirationDate: record.expirationDate ? new Date(record.expirationDate) : null,
          evidenceReference: record.evidenceReference,
          approvalProvenance: record.approvalProvenance,
          revocationReason: record.revocationReason ?? null,
          revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
          revokedBy: record.revokedBy ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: sourceAuthRecords.recordId,
          set: {
            sourceId: record.sourceId,
            name: record.name,
            status: record.status,
            authorizedPurposes: record.authorizedPurposes,
            scopes: record.scopes,
            effectiveDate: new Date(record.effectiveDate),
            expirationDate: record.expirationDate ? new Date(record.expirationDate) : null,
            evidenceReference: record.evidenceReference,
            approvalProvenance: record.approvalProvenance,
            revocationReason: record.revocationReason ?? null,
            revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
            revokedBy: record.revokedBy ?? null,
            updatedAt: new Date(),
          },
        });

      await tx.insert(sourceAuthAuditEvents).values({
        id: auditEvent.id,
        recordId: auditEvent.recordId,
        action: auditEvent.action,
        performedBy: auditEvent.performedBy,
        actorRole: auditEvent.actorRole,
        evidenceReference: auditEvent.evidenceReference,
        reason: auditEvent.reason,
        previousStatus: auditEvent.previousStatus,
        newStatus: auditEvent.newStatus,
        details: auditEvent.details,
        createdAt: new Date(auditEvent.createdAt),
      });

      await tx.execute(
        sql`SELECT pg_notify('source_auth_invalidation', ${JSON.stringify({ recordId: record.recordId, action: auditEvent.action })});`,
      );
    });
  }

  async revokeRecord(
    recordId: string,
    revocation: {
      status: "BLOCKED" | "EXPIRED";
      reason: string;
      revokedBy: string;
      revokedAt?: string;
    },
    auditEvent: SourceAuthAuditEvent,
  ): Promise<TrustedAuthRecord> {
    const { db } = await import("@/db");
    const { sourceAuthRecords, sourceAuthAuditEvents } = await import("@/db/schema/sourceAuth");
    const { eq, sql } = await import("drizzle-orm");

    return await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sourceAuthRecords)
        .where(eq(sourceAuthRecords.recordId, recordId.trim()))
        .limit(1);

      const existing = rows[0];
      if (!existing) {
        throw new Error(`Cannot revoke record '${recordId}': record not found in database.`);
      }

      const revokedAt = revocation.revokedAt ? new Date(revocation.revokedAt) : new Date();
      const updatedProvenance = {
        approvedBy: revocation.revokedBy,
        reviewedAt: revokedAt.toISOString(),
        notes: `REVOKED (${revocation.status}): ${revocation.reason}. Prior notes: ${existing.approvalProvenance.notes}`,
      };

      const [updatedRow] = await tx
        .update(sourceAuthRecords)
        .set({
          status: revocation.status,
          revocationReason: revocation.reason,
          revokedAt,
          revokedBy: revocation.revokedBy,
          approvalProvenance: updatedProvenance,
          updatedAt: new Date(),
        })
        .where(eq(sourceAuthRecords.recordId, recordId.trim()))
        .returning();

      await tx.insert(sourceAuthAuditEvents).values({
        id: auditEvent.id,
        recordId: auditEvent.recordId,
        action: auditEvent.action,
        performedBy: auditEvent.performedBy,
        actorRole: auditEvent.actorRole,
        evidenceReference: auditEvent.evidenceReference,
        reason: auditEvent.reason,
        previousStatus: auditEvent.previousStatus,
        newStatus: auditEvent.newStatus,
        details: auditEvent.details,
        createdAt: new Date(auditEvent.createdAt),
      });

      await tx.execute(
        sql`SELECT pg_notify('source_auth_invalidation', ${JSON.stringify({ recordId: recordId.trim(), action: 'REVOKE', status: revocation.status })});`,
      );

      return cloneAndFreezeRecord(
        validateTrustedAuthRecord({
          recordId: updatedRow.recordId,
          sourceId: updatedRow.sourceId as SourceId,
          name: updatedRow.name,
          status: updatedRow.status as SourceAuthStatus,
          authorizedPurposes: updatedRow.authorizedPurposes,
          scopes: updatedRow.scopes,
          effectiveDate: updatedRow.effectiveDate.toISOString(),
          expirationDate: updatedRow.expirationDate ? updatedRow.expirationDate.toISOString() : null,
          evidenceReference: updatedRow.evidenceReference,
          approvalProvenance: updatedRow.approvalProvenance,
          revocationReason: updatedRow.revocationReason,
          revokedAt: updatedRow.revokedAt ? updatedRow.revokedAt.toISOString() : null,
          revokedBy: updatedRow.revokedBy,
          updatedAt: updatedRow.updatedAt.toISOString(),
        }),
      );
    });
  }

  async getAuditEvents(recordId?: string): Promise<SourceAuthAuditEvent[]> {
    const { db } = await import("@/db");
    const { sourceAuthAuditEvents } = await import("@/db/schema/sourceAuth");
    const { desc, eq } = await import("drizzle-orm");

    const query = db().select().from(sourceAuthAuditEvents);
    const rows = recordId
      ? await query
          .where(eq(sourceAuthAuditEvents.recordId, recordId.trim()))
          .orderBy(desc(sourceAuthAuditEvents.createdAt))
      : await query.orderBy(desc(sourceAuthAuditEvents.createdAt));

    return rows.map((r) => ({
      id: r.id,
      recordId: r.recordId,
      action: r.action as "REGISTER" | "APPROVE" | "UPDATE" | "REVOKE",
      performedBy: r.performedBy,
      actorRole: r.actorRole,
      evidenceReference: r.evidenceReference,
      reason: r.reason,
      previousStatus: (r.previousStatus as SourceAuthStatus) ?? null,
      newStatus: r.newStatus as SourceAuthStatus,
      details: (r.details as Record<string, unknown>) ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export const DEFAULT_MAX_STALENESS_MS = 2000;

/**
 * Registry manager coordinating durable persistence, local in-memory caching,
 * defensive copying, schema validation, and operator authorization.
 */
export class SourcePolicyRegistry {
  private store: SourceAuthStore;
  private cache = new Map<string, TrustedAuthRecord>();
  private lastSyncMs = 0;
  private readonly maxStalenessMs: number;
  private revision = 0;
  private storeHealthy = true;
  private isHydrated = false;
  private unsubscribeStore?: () => void;

  constructor(store: SourceAuthStore, maxStalenessMs = DEFAULT_MAX_STALENESS_MS) {
    this.store = store;
    this.maxStalenessMs = maxStalenessMs;
    this.bindStoreListeners();
    if (process.env.NODE_ENV !== "production") {
      this.seedCacheDefaults();
    }
  }

  private bindStoreListeners(): void {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = undefined;
    }
    if (this.store.subscribeInvalidation) {
      this.unsubscribeStore = this.store.subscribeInvalidation((payload) => {
        if (payload?.recordId) {
          this.cache.delete(payload.recordId);
        } else {
          this.cache.clear();
        }
        this.lastSyncMs = 0;
        this.revision++;
      });
    }
  }

  seedCacheDefaults(): void {
    this.cache.clear();
    for (const record of DEFAULT_TRUSTED_REGISTRY) {
      const validated = validateTrustedAuthRecord(record);
      this.cache.set(validated.recordId, cloneAndFreezeRecord(validated));
    }
    this.storeHealthy = true;
    this.isHydrated = true;
    this.revision++;
  }

  getStore(): SourceAuthStore {
    return this.store;
  }

  getRevision(): number {
    return this.revision;
  }

  isHealthy(): boolean {
    return this.storeHealthy;
  }

  setStore(store: SourceAuthStore): void {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = undefined;
    }
    this.store = store;
    this.storeHealthy = true;
    this.isHydrated = false;
    this.lastSyncMs = 0;
    this.cache.clear();
    this.bindStoreListeners();
  }

  getRecord(recordId: string): TrustedAuthRecord | null {
    if (!this.storeHealthy) {
      return null;
    }
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      if (typeof this.store.readStateSync === "function") {
        try {
          const records = this.store.readStateSync();
          this.cache.clear();
          for (const r of records) {
            const validated = validateTrustedAuthRecord(r);
            this.cache.set(validated.recordId, cloneAndFreezeRecord(validated));
          }
          this.lastSyncMs = Date.now();
        } catch {
          this.cache.delete(recordId.trim());
        }
      } else {
        this.cache.delete(recordId.trim());
      }
    }
    const found = this.cache.get(recordId.trim());
    return found ? cloneAndFreezeRecord(found) : null;
  }

  getAllRecords(): TrustedAuthRecord[] {
    if (!this.storeHealthy) {
      return [];
    }
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      if (typeof this.store.readStateSync === "function") {
        try {
          const records = this.store.readStateSync();
          this.cache.clear();
          for (const r of records) {
            const validated = validateTrustedAuthRecord(r);
            this.cache.set(validated.recordId, cloneAndFreezeRecord(validated));
          }
          this.lastSyncMs = Date.now();
        } catch {
          // ignore
        }
      }
    }
    return Array.from(this.cache.values()).map(cloneAndFreezeRecord);
  }

  async syncFromStore(): Promise<void> {
    try {
      const records = await this.store.getAllRecords();
      this.cache.clear();
      for (const record of records) {
        const validated = validateTrustedAuthRecord(record);
        this.cache.set(validated.recordId, cloneAndFreezeRecord(validated));
      }
      this.lastSyncMs = Date.now();
      this.isHydrated = true;
      this.storeHealthy = true;
      this.revision++;
    } catch (err) {
      this.storeHealthy = false;
      this.cache.clear();
      throw new Error(
        `Failed to synchronize source authorization registry from durable store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  isCacheExpired(now = Date.now()): boolean {
    if (!this.isHydrated || !this.storeHealthy) return true;
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      return true;
    }
    if (this.maxStalenessMs <= 0) return false;
    return now - this.lastSyncMs >= this.maxStalenessMs;
  }

  async ensureFresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.isHydrated && this.storeHealthy && !this.isCacheExpired(now)) {
      return;
    }
    await this.syncFromStore();
  }

  async registerRecord(
    operator: unknown,
    record: TrustedAuthRecord,
    options?: { unblockConfirmed?: boolean; reason?: string },
  ): Promise<TrustedAuthRecord> {
    const verified = assertAuthorizedOperator(operator);
    const validated = validateTrustedAuthRecord(record);

    const existing = this.cache.get(validated.recordId);
    if (existing) {
      if ((existing.status === "BLOCKED" || existing.status === "EXPIRED") && validated.status === "APPROVED") {
        if (!options?.unblockConfirmed) {
          throw new OperatorAuthorizationError(
            `Cannot overwrite ${existing.status} record '${validated.recordId}' into APPROVED state without explicit unblock confirmation (unblockConfirmed: true).`,
          );
        }
        if (verified.role !== "legal_counsel" && verified.role !== "compliance_officer") {
          throw new OperatorAuthorizationError(
            `Only legal_counsel or compliance_officer can unblock a revoked or blocked record (current role: '${verified.role}').`,
          );
        }
        if (!validated.evidenceReference || validated.evidenceReference === existing.evidenceReference) {
          throw new InvalidAuthRecordError(
            `Unblocking record '${validated.recordId}' requires a new, updated evidenceReference proving legal authorization.`,
          );
        }
      }
    }

    const auditEvent: SourceAuthAuditEvent = {
      id: `audit_${randomUUID()}`,
      recordId: validated.recordId,
      action: existing ? (validated.status === "APPROVED" && existing.status !== "APPROVED" ? "APPROVE" : "UPDATE") : "REGISTER",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      evidenceReference: validated.evidenceReference,
      reason: options?.reason ?? `Operator ${verified.operatorId} registered record with status ${validated.status}`,
      previousStatus: existing ? existing.status : null,
      newStatus: validated.status,
      createdAt: new Date().toISOString(),
    };

    await this.store.saveRecord(validated, auditEvent);
    const frozen = cloneAndFreezeRecord(validated);
    this.cache.set(validated.recordId, frozen);
    this.revision++;
    return frozen;
  }

  async approveRecord(
    operator: unknown,
    params: {
      recordId: string;
      evidenceReference: string;
      notes: string;
      unblockConfirmed?: boolean;
      now?: Date;
    },
  ): Promise<TrustedAuthRecord> {
    const verified = assertAuthorizedOperator(operator);
    const existing = this.cache.get(params.recordId.trim());
    if (!existing) {
      throw new Error(`Record '${params.recordId}' not found in registry.`);
    }

    if (existing.status === "BLOCKED" || existing.status === "EXPIRED") {
      if (!params.unblockConfirmed) {
        throw new OperatorAuthorizationError(
          `Cannot approve previously ${existing.status} record '${params.recordId}' without explicit unblock confirmation (unblockConfirmed: true).`,
        );
      }
      if (verified.role !== "legal_counsel" && verified.role !== "compliance_officer") {
        throw new OperatorAuthorizationError(
          `Only legal_counsel or compliance_officer can unblock a revoked or blocked record (current role: '${verified.role}').`,
        );
      }
      if (!params.evidenceReference || params.evidenceReference === existing.evidenceReference) {
        throw new InvalidAuthRecordError(
          `Approving previously ${existing.status} record '${params.recordId}' requires a new, updated evidenceReference proving legal authorization.`,
        );
      }
    }

    const updated: TrustedAuthRecord = {
      ...existing,
      status: "APPROVED",
      evidenceReference: params.evidenceReference.trim(),
      approvalProvenance: {
        approvedBy: verified.operatorId,
        reviewedAt: (params.now ?? new Date()).toISOString(),
        notes: params.notes.trim(),
      },
      revocationReason: null,
      revokedAt: null,
      revokedBy: null,
      updatedAt: (params.now ?? new Date()).toISOString(),
    };

    const validated = validateTrustedAuthRecord(updated);
    const auditEvent: SourceAuthAuditEvent = {
      id: `audit_${randomUUID()}`,
      recordId: validated.recordId,
      action: "APPROVE",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      evidenceReference: params.evidenceReference,
      reason: params.notes,
      previousStatus: existing.status,
      newStatus: "APPROVED",
      createdAt: (params.now ?? new Date()).toISOString(),
    };

    await this.store.saveRecord(validated, auditEvent);
    const frozen = cloneAndFreezeRecord(validated);
    this.cache.set(validated.recordId, frozen);
    this.revision++;
    return frozen;
  }

  async revokeRecord(
    operator: unknown,
    params: {
      recordId: string;
      status: "BLOCKED" | "EXPIRED";
      reason: string;
      revokedAt?: string;
    },
  ): Promise<TrustedAuthRecord> {
    const verified = assertAuthorizedOperator(operator);
    const existing = this.cache.get(params.recordId.trim());
    if (!existing) {
      throw new Error(`Cannot revoke record '${params.recordId}': record not found in trusted registry.`);
    }

    const auditEvent: SourceAuthAuditEvent = {
      id: `audit_${randomUUID()}`,
      recordId: params.recordId.trim(),
      action: "REVOKE",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      evidenceReference: existing.evidenceReference,
      reason: params.reason,
      previousStatus: existing.status,
      newStatus: params.status,
      createdAt: params.revokedAt ?? new Date().toISOString(),
    };

    const immediateRevoked = cloneAndFreezeRecord(
      validateTrustedAuthRecord({
        ...existing,
        status: params.status,
        revocationReason: params.reason,
        revokedAt: params.revokedAt ?? new Date().toISOString(),
        revokedBy: verified.operatorId,
        approvalProvenance: {
          approvedBy: verified.operatorId,
          reviewedAt: params.revokedAt ?? new Date().toISOString(),
          notes: `REVOKED (${params.status}): ${params.reason}. Prior notes: ${existing.approvalProvenance.notes}`,
        },
      }),
    );
    this.cache.set(params.recordId.trim(), immediateRevoked);
    this.revision++;

    const revoked = await this.store.revokeRecord(
      params.recordId,
      {
        status: params.status,
        reason: params.reason,
        revokedBy: verified.operatorId,
        revokedAt: params.revokedAt,
      },
      auditEvent,
    );

    const frozen = cloneAndFreezeRecord(revoked);
    this.cache.set(params.recordId.trim(), frozen);
    return frozen;
  }

  async getAuditHistory(recordId?: string): Promise<SourceAuthAuditEvent[]> {
    return this.store.getAuditEvents(recordId);
  }

  __testOnlyInjectRecord(record: TrustedAuthRecord): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("__testOnlyInjectRecord cannot be called in production.");
    }
    const validated = validateTrustedAuthRecord(record);
    this.cache.set(validated.recordId, cloneAndFreezeRecord(validated));
  }

  async reset(): Promise<void> {
    this.seedCacheDefaults();
    this.lastSyncMs = 0;
    if (this.store.resetToDefaults) {
      await this.store.resetToDefaults();
    }
  }
}

/** Factory to select the authoritative storage backend. */
export function createDefaultSourceAuthStore(): SourceAuthStore {
  // In production, MUST use durable PostgreSQL store
  if (process.env.NODE_ENV === "production") {
    return new DrizzleSourceAuthStore();
  }
  // Persistent file store only where explicitly configured for tests or offline dev
  if (process.env.SOURCE_AUTH_STORE === "drizzle") {
    return new DrizzleSourceAuthStore();
  }
  return new PersistentFileSourceAuthStore();
}

// Global active store instance
let globalStore: SourceAuthStore = createDefaultSourceAuthStore();
export const globalRegistry = new SourcePolicyRegistry(globalStore);

export function setGlobalRegistryStore(store: SourceAuthStore): void {
  globalStore = store;
  globalRegistry.setStore(store);
}

/** Explicit runtime hydration hook called at server bootstrap. */
export async function initSourcePolicyRegistry(): Promise<void> {
  await globalRegistry.ensureFresh(true);
  await ensureOperatorCredentialFresh(true);
}

/** Explicit helper to ensure registry is freshly synced from durable store. */
export async function ensureSourcePolicyFresh(force = false): Promise<void> {
  await globalRegistry.ensureFresh(force);
  await ensureOperatorCredentialFresh(force);
}

/** Looks up a trusted record by its stable identifier. Returns an immutable frozen clone. */
export function getTrustedRecord(recordId: string): TrustedAuthRecord | null {
  return globalRegistry.getRecord(recordId);
}

/** Returns all currently registered trusted authorization records as immutable frozen clones. */
export function listTrustedRecords(): TrustedAuthRecord[] {
  return globalRegistry.getAllRecords();
}

/** Operator API to approve an authorization record. Requires valid operator context. */
export async function operatorApproveRecord(
  operator: OperatorContext,
  params: {
    recordId: string;
    evidenceReference: string;
    notes: string;
    unblockConfirmed?: boolean;
    now?: Date;
  },
): Promise<TrustedAuthRecord> {
  return globalRegistry.approveRecord(operator, params);
}

/** Operator API to revoke an authorization record. Requires valid operator context. */
export async function operatorRevokeRecord(
  operator: OperatorContext,
  params: {
    recordId: string;
    status: "BLOCKED" | "EXPIRED";
    reason: string;
    revokedAt?: string;
  },
): Promise<TrustedAuthRecord> {
  return globalRegistry.revokeRecord(operator, params);
}

/** Operator API to register or update an authorization record. Requires valid operator context. */
export async function operatorRegisterRecord(
  operator: OperatorContext,
  record: TrustedAuthRecord,
  options?: { unblockConfirmed?: boolean; reason?: string },
): Promise<TrustedAuthRecord> {
  return globalRegistry.registerRecord(operator, record, options);
}

/** Retrieves audit history for registry actions. */
export async function getSourceAuthAuditHistory(
  recordId?: string,
): Promise<SourceAuthAuditEvent[]> {
  return globalRegistry.getAuditHistory(recordId);
}

/** Test-only helper to register mock records during automated testing. */
export function __testOnlyRegisterRecord(record: TrustedAuthRecord): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__testOnlyRegisterRecord cannot be called in production.");
  }
  globalRegistry.__testOnlyInjectRecord(record);
}

/**
 * Backward-compatible registration helper. In production, requires operator authorization;
 * in non-production, delegates to test injection.
 */
export function registerTrustedAuthRecord(
  record: TrustedAuthRecord,
  operator?: OperatorContext,
): void {
  if (operator) {
    void globalRegistry.registerRecord(operator, record);
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new OperatorAuthorizationError(
      "registerTrustedAuthRecord without OperatorContext is prohibited in production.",
    );
  }
  globalRegistry.__testOnlyInjectRecord(record);
}

/**
 * Backward-compatible revocation helper. In production, requires operator authorization;
 * in non-production, delegates with standard system_administrator role.
 */
export function revokeTrustedAuthRecord(
  recordId: string,
  revocation: {
    status: "BLOCKED" | "EXPIRED";
    reason: string;
    revokedBy: string;
    revokedAt?: string;
  },
  operator?: unknown,
): TrustedAuthRecord {
  if (process.env.NODE_ENV === "production" && !operator) {
    throw new OperatorAuthorizationError(
      "revokeTrustedAuthRecord without OperatorContext is prohibited in production.",
    );
  }
  const op = operator ?? {
    operatorId: revocation.revokedBy || "sysadmin_001",
    role: "system_administrator",
    operatorKey: "admin_secret_key_001",
  };
  void globalRegistry.revokeRecord(op, {
    recordId,
    status: revocation.status,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt,
  });
  const updated = globalRegistry.getRecord(recordId);
  if (!updated) {
    throw new Error(`Record '${recordId}' not found after revocation.`);
  }
  return updated;
}

/** Resets the trusted registry to defaults (for test isolation). */
export function resetTrustedRegistry(): void {
  globalRegistry.seedCacheDefaults();
  void globalRegistry.reset();
}

/** Synchronizes the in-memory cache with the durable persistent store. */
export async function syncRegistryFromStore(): Promise<void> {
  await globalRegistry.syncFromStore();
}

/** Reinitializes registry from the persistent store, simulating process restart. */
export async function reloadRegistryFromStore(store?: SourceAuthStore): Promise<SourcePolicyRegistry> {
  const activeStore = store ?? globalStore;
  const newRegistry = new SourcePolicyRegistry(activeStore);
  await newRegistry.syncFromStore();
  return newRegistry;
}

/** Validates temporal validity of an authorization record. */
export function isRecordDateValid(
  record: TrustedAuthRecord,
  now: Date,
): { valid: boolean; status?: SourceAuthStatus; reason?: string } {
  const effective = new Date(record.effectiveDate);
  if (isNaN(effective.getTime())) {
    return {
      valid: false,
      status: "BLOCKED",
      reason: `Malformed effectiveDate '${record.effectiveDate}'.`,
    };
  }
  if (now.getTime() < effective.getTime()) {
    return {
      valid: false,
      status: "PENDING",
      reason: `Authorization record '${record.recordId}' is not yet effective (effective: ${record.effectiveDate}).`,
    };
  }
  if (record.expirationDate !== null) {
    const expiration = new Date(record.expirationDate);
    if (isNaN(expiration.getTime())) {
      return {
        valid: false,
        status: "BLOCKED",
        reason: `Malformed expirationDate '${record.expirationDate}'.`,
      };
    }
    if (now.getTime() > expiration.getTime()) {
      return {
        valid: false,
        status: "EXPIRED",
        reason: `Authorization record '${record.recordId}' expired on ${record.expirationDate}.`,
      };
    }
  }
  return { valid: true };
}

/** Validates scope and purpose coverage of an authorization record. */
export function isRecordOperationValid(
  record: TrustedAuthRecord,
  operation?: { purpose?: SourceUsagePurpose; scope?: SourceUsageScope },
): { valid: boolean; reason?: string } {
  if (!operation) {
    return { valid: true };
  }
  if (operation.purpose && !record.authorizedPurposes.includes(operation.purpose)) {
    return {
      valid: false,
      reason: `Authorization record '${record.recordId}' does not authorize purpose '${operation.purpose}' (authorized: [${record.authorizedPurposes.join(", ")}]).`,
    };
  }
  if (operation.scope && !record.scopes.includes(operation.scope)) {
    return {
      valid: false,
      reason: `Authorization record '${record.recordId}' does not cover required scope '${operation.scope}' (authorized: [${record.scopes.join(", ")}]).`,
    };
  }
  return { valid: true };
}

/**
 * Resolves the authoritative source authorization policy.
 */
export function getSourcePolicy(
  target: SourceId | SourceOperationRequest,
  options: SourcePolicyOptions = {},
): SourcePolicy {
  const isOperationRequest =
    typeof target === "object" && target !== null && "purpose" in target && "scope" in target;
  const sourceId: SourceId = typeof target === "string" ? target : target.sourceId;
  const now = (isOperationRequest ? target.now : options.now) ?? options.now ?? new Date();
  const requestedPurpose: SourceUsagePurpose | undefined = isOperationRequest
    ? target.purpose
    : options.purpose;
  const requestedScope: SourceUsageScope | undefined = isOperationRequest
    ? target.scope
    : options.scope;
  const authRecordIdOverride =
    (isOperationRequest ? target.authRecordIdOverride : options.authRecordIdOverride) ??
    options.authRecordIdOverride;

  if (!globalRegistry.isHealthy()) {
    return {
      sourceId,
      name: "Source Authorization Gate",
      status: "BLOCKED",
      enabled: false,
      authRecordId: null,
      commercialUsePermitted: false,
      authorizedPurposes: [],
      authorizedScopes: [],
      requestedPurpose,
      requestedScope,
      reason:
        "Durable authorization store is unreachable, failed validation, or is offline; access denied fail-closed.",
      legalDisclaimer:
        "Technical gate enforced: Access denied when durable authorization registry cannot be verified.",
    };
  }

  const cfg = config();

  // Route alias: google_serp evaluates the active AnyAPI scraped SERP route
  if (sourceId === "google_serp" || sourceId === "google_scraped_serp") {
    const isFlagOn = cfg.GOOGLE_SERP_SOURCE_ENABLED ?? false;
    const rawRecordId = authRecordIdOverride ?? cfg.GOOGLE_SERP_AUTH_RECORD_ID?.trim() ?? null;
    const recordId = rawRecordId ?? "REC-GOOGLE-ANYAPI-SCRAPED";

    if (!isFlagOn) {
      return {
        sourceId: "google_scraped_serp",
        name: "Google Search (AnyAPI Scraped SERP)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason:
          "AnyAPI scraped Google search is disabled by configuration (GOOGLE_SERP_SOURCE_ENABLED=false). Automated SERP scraping without an official Google agreement is prohibited.",
        legalDisclaimer: "Technical gate enforced: Scraped Google SERP calls and caching are disabled.",
      };
    }

    if (!rawRecordId || PLACEHOLDER_RECORD_IDS.has(rawRecordId.toLowerCase())) {
      return {
        sourceId: "google_scraped_serp",
        name: "Google Search (AnyAPI Scraped SERP)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason:
          "GOOGLE_SERP_SOURCE_ENABLED is set, but GOOGLE_SERP_AUTH_RECORD_ID is missing or a placeholder. An environment variable alone cannot grant approval; an explicit, recognized record in the trusted authorization registry is required.",
        legalDisclaimer: "Technical gate enforced: Missing or placeholder authorization record reference fails closed.",
      };
    }

    const record = getTrustedRecord(recordId);
    if (!record) {
      return {
        sourceId: "google_scraped_serp",
        name: "Google Search (AnyAPI Scraped SERP)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is not recognized in the trusted registry. Arbitrary or fabricated identifiers fail closed.`,
        legalDisclaimer: "Technical gate enforced: Unrecognized authorization record fails closed.",
      };
    }

    if (record.sourceId !== "google_scraped_serp" && record.sourceId !== "google_serp") {
      return {
        sourceId: "google_scraped_serp",
        name: "Google Search (AnyAPI Scraped SERP)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is registered for source '${record.sourceId}', not 'google_scraped_serp'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched source record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "google_scraped_serp",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' has status '${record.status}'. Scraped SERP requires explicit commercial approval. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "google_scraped_serp",
        name: record.name,
        status: dateCheck.status!,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: dateCheck.reason!,
        legalDisclaimer: `Technical gate enforced: Record temporal check evaluated to ${dateCheck.status}.`,
        record,
      };
    }

    if (!requestedPurpose || !requestedScope) {
      return {
        sourceId: "google_scraped_serp",
        name: record.name,
        status: "APPROVED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: true,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        reason: "Policy status display query. Access execution requires explicit operation purpose and scope.",
        legalDisclaimer: "Technical gate enforced: Access execution denied without explicit purpose and scope.",
        record,
      };
    }

    const opCheck = isRecordOperationValid(record, { purpose: requestedPurpose, scope: requestedScope });
    if (!opCheck.valid) {
      return {
        sourceId: "google_scraped_serp",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: opCheck.reason!,
        legalDisclaimer: "Technical gate enforced: Operation outside authorized purpose or scope fails closed.",
        record,
      };
    }

    return {
      sourceId: "google_scraped_serp",
      name: record.name,
      status: "APPROVED",
      enabled: true,
      authRecordId: recordId,
      commercialUsePermitted: true,
      authorizedPurposes: record.authorizedPurposes,
      authorizedScopes: record.scopes,
      requestedPurpose,
      requestedScope,
      reason: `Operator enabled with verified, approved authorization record: ${recordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${recordId}'. Software cannot verify external legal sufficiency; operator is responsible for legal contract validity.`,
      record,
    };
  }

  if (sourceId === "google_official_api") {
    const record = getTrustedRecord("REC-GOOGLE-OFFICIAL-CSE");
    return {
      sourceId: "google_official_api",
      name: "Google Custom Search (Official API)",
      status: "BLOCKED",
      enabled: false,
      authRecordId: "REC-GOOGLE-OFFICIAL-CSE",
      commercialUsePermitted: false,
      authorizedPurposes: record ? record.authorizedPurposes : [],
      authorizedScopes: record ? record.scopes : [],
      requestedPurpose,
      requestedScope,
      reason:
        "Official Google Custom Search JSON API credentials (API key and CSE ID) are not provisioned in deployment.",
      legalDisclaimer:
        "Official Google API access requires commercial billing and verified API credentials.",
      record,
    };
  }

  if (sourceId === "reddit") {
    const isFlagOn = cfg.REDDIT_SOURCE_ENABLED;
    const rawRecordId = authRecordIdOverride ?? cfg.REDDIT_AUTH_RECORD_ID?.trim() ?? null;
    const recordId = rawRecordId ?? "REC-REDDIT-COMMERCIAL-UNVERIFIED";

    if (!isFlagOn) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason:
          "Reddit data source is disabled by configuration (REDDIT_SOURCE_ENABLED=false). Commercial redistribution and model extraction require an executed agreement with Reddit Inc.",
        legalDisclaimer:
          "Technical gate enforced: Ingestion, cache reuse, and downstream serving are disabled.",
      };
    }

    if (!rawRecordId || PLACEHOLDER_RECORD_IDS.has(rawRecordId.toLowerCase())) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason:
          "REDDIT_SOURCE_ENABLED is set, but REDDIT_AUTH_RECORD_ID is missing or a placeholder. An environment variable alone cannot grant approval; an explicit, recognized record in the trusted authorization registry is required.",
        legalDisclaimer:
          "Technical gate enforced: Missing or placeholder authorization record reference fails closed.",
      };
    }

    const record = getTrustedRecord(recordId);
    if (!record) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is not recognized in the trusted registry. Arbitrary or fabricated identifiers fail closed.`,
        legalDisclaimer: "Technical gate enforced: Unrecognized authorization record fails closed.",
      };
    }

    if (record.sourceId !== "reddit") {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is registered for source '${record.sourceId}', not 'reddit'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched source record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "reddit",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' has status '${record.status}'. Commercial ingestion requires explicit approval. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "reddit",
        name: record.name,
        status: dateCheck.status!,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: dateCheck.reason!,
        legalDisclaimer: `Technical gate enforced: Record temporal check evaluated to ${dateCheck.status}.`,
        record,
      };
    }

    if (!requestedPurpose || !requestedScope) {
      return {
        sourceId: "reddit",
        name: record.name,
        status: "APPROVED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: true,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        reason: "Policy status display query. Access execution requires explicit operation purpose and scope.",
        legalDisclaimer: "Technical gate enforced: Access execution denied without explicit purpose and scope.",
        record,
      };
    }

    const opCheck = isRecordOperationValid(record, { purpose: requestedPurpose, scope: requestedScope });
    if (!opCheck.valid) {
      return {
        sourceId: "reddit",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: opCheck.reason!,
        legalDisclaimer: "Technical gate enforced: Operation outside authorized purpose or scope fails closed.",
        record,
      };
    }

    return {
      sourceId: "reddit",
      name: record.name,
      status: "APPROVED",
      enabled: true,
      authRecordId: recordId,
      commercialUsePermitted: true,
      authorizedPurposes: record.authorizedPurposes,
      authorizedScopes: record.scopes,
      requestedPurpose,
      requestedScope,
      reason: `Operator enabled with verified, approved authorization record: ${recordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${recordId}'. Software cannot verify external legal sufficiency; operator is responsible for legal contract validity.`,
      record,
    };
  }

  if (sourceId === "x") {
    const isFlagOn = cfg.X_LEADS;
    const rawRecordId = authRecordIdOverride ?? cfg.X_AUTH_RECORD_ID?.trim() ?? null;
    const recordId = rawRecordId ?? "REC-X-PILOT-REVIEW";

    if (!isFlagOn) {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason:
          "X leads feature is dark by configuration (X_LEADS=false). Feature flag must be enabled by operator alongside verified authorization.",
        legalDisclaimer: "Technical gate enforced: X ingestion and serving are dark.",
      };
    }

    if (!rawRecordId || PLACEHOLDER_RECORD_IDS.has(rawRecordId.toLowerCase())) {
      const defaultRecord = getTrustedRecord("REC-X-PILOT-REVIEW");
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: defaultRecord ? defaultRecord.status : "PENDING",
        enabled: false,
        authRecordId: null,
        commercialUsePermitted: false,
        authorizedPurposes: defaultRecord ? defaultRecord.authorizedPurposes : [],
        authorizedScopes: defaultRecord ? defaultRecord.scopes : [],
        requestedPurpose,
        requestedScope,
        reason:
          "X_LEADS is enabled, but X_AUTH_RECORD_ID is not configured with an approved record. Current status is PENDING pilot review; commercial serving and paid API calls are blocked.",
        legalDisclaimer:
          "Technical gate enforced: Missing or unconfigured X authorization record reference fails closed as PENDING/BLOCKED.",
        record: defaultRecord,
      };
    }

    const record = getTrustedRecord(recordId);
    if (!record) {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is not recognized in the trusted registry. Arbitrary or fabricated identifiers fail closed.`,
        legalDisclaimer: "Technical gate enforced: Unrecognized authorization record fails closed.",
      };
    }

    if (record.sourceId !== "x") {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' is registered for source '${record.sourceId}', not 'x'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched source record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "x",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `X authorization record '${rawRecordId}' has status '${record.status}'. Commercial ingestion requires explicit approval. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "x",
        name: record.name,
        status: dateCheck.status!,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: dateCheck.reason!,
        legalDisclaimer: `Technical gate enforced: Record temporal check evaluated to ${dateCheck.status}.`,
        record,
      };
    }

    if (!requestedPurpose || !requestedScope) {
      return {
        sourceId: "x",
        name: record.name,
        status: "APPROVED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: true,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        reason: "Policy status display query. Access execution requires explicit operation purpose and scope.",
        legalDisclaimer: "Technical gate enforced: Access execution denied without explicit purpose and scope.",
        record,
      };
    }

    const opCheck = isRecordOperationValid(record, { purpose: requestedPurpose, scope: requestedScope });
    if (!opCheck.valid) {
      return {
        sourceId: "x",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: opCheck.reason!,
        legalDisclaimer: "Technical gate enforced: Operation outside authorized purpose or scope fails closed.",
        record,
      };
    }

    return {
      sourceId: "x",
      name: record.name,
      status: "APPROVED",
      enabled: true,
      authRecordId: recordId,
      commercialUsePermitted: true,
      authorizedPurposes: record.authorizedPurposes,
      authorizedScopes: record.scopes,
      requestedPurpose,
      requestedScope,
      reason: `Operator enabled with verified, approved authorization record: ${recordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${recordId}'. Software cannot verify external legal sufficiency; operator is responsible for legal contract validity.`,
      record,
    };
  }

  if (sourceId === "website_crawler") {
    const rawRecordId = authRecordIdOverride ?? "REC-WEBSITE-CRAWLER-FIRST-PARTY";
    const record = getTrustedRecord(rawRecordId);

    if (!record) {
      return {
        sourceId: "website_crawler",
        name: "Target Website Web Crawler",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: [],
        authorizedScopes: [],
        requestedPurpose,
        requestedScope,
        reason: `Crawler authorization record '${rawRecordId}' is not recognized in the trusted registry. Access fails closed.`,
        legalDisclaimer: "Technical gate enforced: Missing crawler authorization record fails closed.",
      };
    }

    if (record.sourceId !== "website_crawler") {
      return {
        sourceId: "website_crawler",
        name: "Target Website Web Crawler",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Authorization record '${rawRecordId}' belongs to source '${record.sourceId}', not 'website_crawler'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched crawler record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "website_crawler",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: `Crawler authorization record '${rawRecordId}' has status '${record.status}'. Crawling requires an APPROVED record. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Crawler record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "website_crawler",
        name: record.name,
        status: dateCheck.status!,
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: dateCheck.reason!,
        legalDisclaimer: `Technical gate enforced: Crawler record temporal check evaluated to ${dateCheck.status}.`,
        record,
      };
    }

    if (!requestedPurpose || !requestedScope) {
      return {
        sourceId: "website_crawler",
        name: record.name,
        status: "APPROVED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: true,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        reason: "Policy status display query. Access execution requires explicit operation purpose and scope.",
        legalDisclaimer: "Technical gate enforced: Crawler execution denied without explicit purpose and scope.",
        record,
      };
    }

    const opCheck = isRecordOperationValid(record, { purpose: requestedPurpose, scope: requestedScope });
    if (!opCheck.valid) {
      return {
        sourceId: "website_crawler",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        authorizedPurposes: record.authorizedPurposes,
        authorizedScopes: record.scopes,
        requestedPurpose,
        requestedScope,
        reason: opCheck.reason!,
        legalDisclaimer: "Technical gate enforced: Crawler operation outside authorized purpose or scope fails closed.",
        record,
      };
    }

    return {
      sourceId: "website_crawler",
      name: record.name,
      status: "APPROVED",
      enabled: true,
      authRecordId: rawRecordId,
      commercialUsePermitted: true,
      authorizedPurposes: record.authorizedPurposes,
      authorizedScopes: record.scopes,
      requestedPurpose,
      requestedScope,
      reason:
        "First-party website audit initiated by authenticated project owner for their own configured website domain.",
      legalDisclaimer:
        "Connection-pinned crawler with SSRF and DNS-rebinding protection restricted to customer domains.",
      record,
    };
  }

  return {
    sourceId: "unclassified",
    name: "Unclassified Data Source",
    status: "BLOCKED",
    enabled: false,
    authRecordId: null,
    commercialUsePermitted: false,
    authorizedPurposes: [],
    authorizedScopes: [],
    requestedPurpose,
    requestedScope,
    reason: `Source '${sourceId}' is unclassified. Access fails closed by default.`,
    legalDisclaimer: "Technical gate enforced: Unclassified source fails closed.",
  };
}

export function isSourceAuthorized(request: SourceOperationRequest): boolean;
export function isSourceAuthorized(sourceId: SourceId, options?: SourcePolicyOptions): boolean;
export function isSourceAuthorized(
  target: SourceId | SourceOperationRequest,
  options: SourcePolicyOptions = {},
): boolean {
  return getSourcePolicy(target, options).enabled;
}

export function assertSourceAuthorized(request: SourceOperationRequest): void;
export function assertSourceAuthorized(sourceId: SourceId, options?: SourcePolicyOptions): void;
export function assertSourceAuthorized(
  target: SourceId | SourceOperationRequest,
  options: SourcePolicyOptions = {},
): void {
  const policy = getSourcePolicy(target, options);
  if (!policy.enabled) {
    const sourceId = typeof target === "string" ? target : target.sourceId;
    throw new SourceUnauthorizedError(
      sourceId,
      policy.reason,
      policy.status,
      policy.authRecordId,
    );
  }
}

/**
 * Resolves the data source category for a given SKU.
 * Throws a fail-closed SourceUnauthorizedError for any unclassified or unrecognized SKU.
 */
export function sourceForSku(sku: string): SourceId {
  if (sku.startsWith("reddit.")) return "reddit";
  if (sku.startsWith("twitter.")) return "x";
  if (sku.startsWith("google.")) return "google_scraped_serp";
  throw new SourceUnauthorizedError(
    "unclassified",
    `Unrecognized or unclassified SKU '${sku}'. Access fails closed by default.`,
    "BLOCKED",
  );
}

/** Lists the current policy state across all tracked data sources. */
export function allSourcePolicies(options?: SourcePolicyOptions): SourcePolicy[] {
  return (
    [
      "reddit",
      "x",
      "google_scraped_serp",
      "google_official_api",
      "website_crawler",
    ] as SourceId[]
  ).map((id) => getSourcePolicy(id, options));
}
