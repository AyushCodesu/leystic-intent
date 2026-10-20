import { config } from "./config";

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
  "read_only_audit",
  "academic_research",
] as const;

export type SourceUsagePurpose = (typeof SOURCE_USAGE_PURPOSES)[number];

export const SOURCE_USAGE_SCOPES = [
  "search_discovery",
  "social_content_read",
  "comments_read",
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
};

export type SourceOperationRequest = {
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
const DEFAULT_TRUSTED_REGISTRY: TrustedAuthRecord[] = [
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
];

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
    throw new InvalidAuthRecordError(`approvalProvenance.reviewedAt must be a valid date ('${String(prov.reviewedAt)}').`);
  }
  if (typeof prov.notes !== "string" || !prov.notes.trim()) {
    throw new InvalidAuthRecordError("approvalProvenance.notes must be a non-empty string.");
  }

  return {
    recordId,
    sourceId,
    name: r.name.trim(),
    status,
    authorizedPurposes,
    scopes,
    effectiveDate,
    expirationDate,
    evidenceReference: r.evidenceReference.trim(),
    approvalProvenance: {
      approvedBy: prov.approvedBy.trim(),
      reviewedAt: prov.reviewedAt,
      notes: prov.notes.trim(),
    },
  };
}

const registryStore = new Map<string, TrustedAuthRecord>();

function initRegistry(): void {
  registryStore.clear();
  for (const record of DEFAULT_TRUSTED_REGISTRY) {
    const validated = validateTrustedAuthRecord(record);
    registryStore.set(validated.recordId, cloneAndFreezeRecord(validated));
  }
}

initRegistry();

/** Looks up a trusted record by its stable identifier. Returns an immutable frozen clone. */
export function getTrustedRecord(recordId: string): TrustedAuthRecord | null {
  const found = registryStore.get(recordId.trim());
  return found ? cloneAndFreezeRecord(found) : null;
}

/** Registers or updates an authorization record in the trusted store with strict schema validation. */
export function registerTrustedAuthRecord(record: TrustedAuthRecord): void {
  const validated = validateTrustedAuthRecord(record);
  registryStore.set(validated.recordId, cloneAndFreezeRecord(validated));
}

/** Revokes an authorization record by changing its status to BLOCKED or EXPIRED with audit trail. */
export function revokeTrustedAuthRecord(
  recordId: string,
  revocation: {
    status: "BLOCKED" | "EXPIRED";
    reason: string;
    revokedBy: string;
    revokedAt?: string;
  },
): TrustedAuthRecord {
  const existing = registryStore.get(recordId.trim());
  if (!existing) {
    throw new Error(`Cannot revoke record '${recordId}': record not found in trusted registry.`);
  }
  const updated: TrustedAuthRecord = {
    ...existing,
    status: revocation.status,
    approvalProvenance: {
      approvedBy: revocation.revokedBy,
      reviewedAt: revocation.revokedAt ?? new Date().toISOString(),
      notes: `REVOKED (${revocation.status}): ${revocation.reason}. Prior notes: ${existing.approvalProvenance.notes}`,
    },
  };
  const validated = validateTrustedAuthRecord(updated);
  const frozen = cloneAndFreezeRecord(validated);
  registryStore.set(recordId.trim(), frozen);
  return frozen;
}

/** Resets the trusted registry to defaults (for test isolation). */
export function resetTrustedRegistry(): void {
  initRegistry();
}

/** Returns all currently registered trusted authorization records as immutable frozen clones. */
export function listTrustedRecords(): TrustedAuthRecord[] {
  return Array.from(registryStore.values()).map(cloneAndFreezeRecord);
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
 *
 * Operation-Specific Fail-Closed Invariants:
 * 1. An operation is enabled if and only if:
 *    - Explicit purpose and scope are provided in the operation request.
 *    - The source feature flag is on (when applicable).
 *    - The record ID is present, non-placeholder, and recognized in the trusted registry.
 *    - The record source matches the requested source.
 *    - The record status is explicitly APPROVED.
 *    - The current time is within [effectiveDate, expirationDate].
 *    - The requested purpose is included in record.authorizedPurposes.
 *    - The requested scope is included in record.scopes.
 * 2. If purpose or scope is omitted (a display/status query):
 *    - enabled is ALWAYS false (cannot authorize data access or execution without specific operation).
 *    - status returns the record's current state for UI rendering.
 * 3. In any other case, access is denied (status is PENDING, BLOCKED, or EXPIRED; enabled is false).
 * 4. Software gates enforce technical restriction; human operators remain responsible for legal contracts.
 */
export function getSourcePolicy(
  target: SourceId | SourceOperationRequest,
  options: SourcePolicyOptions = {},
): SourcePolicy {
  const isOperationRequest = typeof target === "object" && target !== null && "purpose" in target && "scope" in target;
  const sourceId: SourceId = typeof target === "string" ? target : target.sourceId;
  const now = (isOperationRequest ? target.now : options.now) ?? options.now ?? new Date();
  const requestedPurpose: SourceUsagePurpose | undefined = isOperationRequest
    ? target.purpose
    : options.purpose;
  const requestedScope: SourceUsageScope | undefined = isOperationRequest
    ? target.scope
    : options.scope;
  const authRecordIdOverride = (isOperationRequest ? target.authRecordIdOverride : options.authRecordIdOverride) ?? options.authRecordIdOverride;

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
