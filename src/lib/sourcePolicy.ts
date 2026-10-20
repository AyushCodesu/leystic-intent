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

export type SourceUsageScope =
  | "read_only_audit"
  | "commercial_indexing"
  | "search_discovery"
  | "social_intent_monitoring"
  | "test_scope";

export type TrustedAuthRecord = {
  recordId: string;
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus;
  authorizedPurposes: string[];
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

export type SourcePolicy = {
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus;
  enabled: boolean;
  authRecordId: string | null;
  commercialUsePermitted: boolean;
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
      "Commercial lead generation",
      "Competitor dissatisfaction tracking",
      "SEO ranking opportunity detection",
    ],
    scopes: ["commercial_indexing"],
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
    authorizedPurposes: ["Social buyer intent discovery"],
    scopes: ["social_intent_monitoring"],
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
    authorizedPurposes: ["Web search phrasing discovery"],
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
    authorizedPurposes: ["Web search phrasing discovery"],
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
    authorizedPurposes: ["First-party customer landing page and sitemap inspection"],
    scopes: ["read_only_audit"],
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

const registryStore = new Map<string, TrustedAuthRecord>();

function initRegistry(): void {
  registryStore.clear();
  for (const record of DEFAULT_TRUSTED_REGISTRY) {
    registryStore.set(record.recordId, record);
  }
}

initRegistry();

/** Looks up a trusted record by its stable identifier. */
export function getTrustedRecord(recordId: string): TrustedAuthRecord | null {
  return registryStore.get(recordId.trim()) ?? null;
}

/** Registers or updates an authorization record in the trusted store. */
export function registerTrustedAuthRecord(record: TrustedAuthRecord): void {
  registryStore.set(record.recordId, record);
}

/** Resets the trusted registry to defaults (for test isolation). */
export function resetTrustedRegistry(): void {
  initRegistry();
}

/** Returns all currently registered trusted authorization records. */
export function listTrustedRecords(): TrustedAuthRecord[] {
  return Array.from(registryStore.values());
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

/** Validates scope coverage of an authorization record. */
export function isRecordScopeValid(
  record: TrustedAuthRecord,
  requiredScope?: SourceUsageScope,
): { valid: boolean; reason?: string } {
  if (!requiredScope) {
    return { valid: true };
  }
  if (!record.scopes.includes(requiredScope)) {
    return {
      valid: false,
      reason: `Authorization record '${record.recordId}' does not cover required scope '${requiredScope}' (authorized: [${record.scopes.join(", ")}]).`,
    };
  }
  return { valid: true };
}

export type SourcePolicyOptions = {
  now?: Date;
  requiredScope?: SourceUsageScope;
};

/**
 * Resolves the authoritative source authorization policy.
 *
 * Fail-Closed Invariants:
 * 1. A source is enabled if and only if:
 *    - The source feature flag is on.
 *    - The record ID is present, non-placeholder, and recognized in the trusted registry.
 *    - The record source matches the requested source.
 *    - The record status is explicitly APPROVED.
 *    - The current time is within [effectiveDate, expirationDate].
 *    - The required usage scope is authorized by the record.
 * 2. In any other case, access is denied (status is PENDING, BLOCKED, or EXPIRED; enabled is false).
 * 3. Software gates enforce technical restriction; human operators remain responsible for legal contracts.
 */
export function getSourcePolicy(
  sourceId: SourceId,
  options: SourcePolicyOptions = {},
): SourcePolicy {
  const now = options.now ?? new Date();
  const requiredScope = options.requiredScope;
  const cfg = config();

  // Route alias: google_serp evaluates the active AnyAPI scraped SERP route
  if (sourceId === "google_serp" || sourceId === "google_scraped_serp") {
    const isFlagOn = cfg.GOOGLE_SERP_SOURCE_ENABLED ?? false;
    const rawRecordId = cfg.GOOGLE_SERP_AUTH_RECORD_ID?.trim() ?? null;
    const recordId = rawRecordId ?? "REC-GOOGLE-ANYAPI-SCRAPED";

    if (!isFlagOn) {
      return {
        sourceId: "google_scraped_serp",
        name: "Google Search (AnyAPI Scraped SERP)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
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
        status: dateCheck.status ?? "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        reason: dateCheck.reason ?? "Record date invalid.",
        legalDisclaimer: "Technical gate enforced: Temporal validity check failed.",
        record,
      };
    }

    const scopeCheck = isRecordScopeValid(record, requiredScope);
    if (!scopeCheck.valid) {
      return {
        sourceId: "google_scraped_serp",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: rawRecordId,
        commercialUsePermitted: false,
        reason: scopeCheck.reason ?? "Record scope invalid.",
        legalDisclaimer: "Technical gate enforced: Scope check failed.",
        record,
      };
    }

    return {
      sourceId: "google_scraped_serp",
      name: record.name,
      status: "APPROVED",
      enabled: true,
      authRecordId: rawRecordId,
      commercialUsePermitted: true,
      reason: `Operator enabled with verified, approved authorization record: ${rawRecordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${rawRecordId}'. Operator is responsible for external legal validity.`,
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
      reason:
        "Official Google Custom Search JSON API is not configured in this environment. Direct Google Cloud commercial API key and Search Engine ID are required.",
      legalDisclaimer:
        "Technical gate enforced: Official Google API route requires configured credentials and executed Google Cloud agreement.",
      record,
    };
  }

  if (sourceId === "reddit") {
    const isFlagOn = cfg.REDDIT_SOURCE_ENABLED ?? false;
    const recordId = cfg.REDDIT_AUTH_RECORD_ID?.trim() ?? null;

    if (!isFlagOn) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason:
          "Commercial Reddit data access is disabled by configuration (REDDIT_SOURCE_ENABLED=false). No verified commercial agreement has been authorized.",
        legalDisclaimer:
          "Technical gate enforced: Reddit data access, caching reuse, and serving are disabled.",
      };
    }

    if (!recordId || PLACEHOLDER_RECORD_IDS.has(recordId.toLowerCase())) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
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
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' is not recognized in the trusted registry. Arbitrary or fabricated identifiers fail closed.`,
        legalDisclaimer: "Technical gate enforced: Unrecognized authorization record fails closed.",
      };
    }

    if (record.sourceId !== "reddit") {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' is registered for source '${record.sourceId}', not 'reddit'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched source record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "reddit",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' has status '${record.status}'. Commercial access requires status 'APPROVED'. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "reddit",
        name: record.name,
        status: dateCheck.status ?? "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: dateCheck.reason ?? "Record date invalid.",
        legalDisclaimer: "Technical gate enforced: Temporal validity check failed.",
        record,
      };
    }

    const scopeCheck = isRecordScopeValid(record, requiredScope);
    if (!scopeCheck.valid) {
      return {
        sourceId: "reddit",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: scopeCheck.reason ?? "Record scope invalid.",
        legalDisclaimer: "Technical gate enforced: Scope check failed.",
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
      reason: `Operator enabled with verified, approved authorization record: ${recordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${recordId}'. Software cannot verify external legal sufficiency; operator is responsible for legal contract validity.`,
      record,
    };
  }

  if (sourceId === "x") {
    const isFlagOn = cfg.X_LEADS ?? false;
    const recordId = cfg.X_AUTH_RECORD_ID?.trim() ?? null;

    if (!isFlagOn) {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: "X leads feature is disabled by configuration (X_LEADS=false).",
        legalDisclaimer: "Technical gate enforced: X data collection and serving are disabled.",
      };
    }

    if (!recordId || PLACEHOLDER_RECORD_IDS.has(recordId.toLowerCase())) {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "PENDING",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason:
          "X leads feature is enabled, but X_AUTH_RECORD_ID is missing or pending review. Access to paid calls, cache reuse, and X-derived data is disabled while PENDING.",
        legalDisclaimer:
          "Technical gate enforced: Pending authorization denies access to paid calls and data serving.",
      };
    }

    const record = getTrustedRecord(recordId);
    if (!record) {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' is not recognized in the trusted registry. Arbitrary or fabricated identifiers fail closed.`,
        legalDisclaimer: "Technical gate enforced: Unrecognized authorization record fails closed.",
      };
    }

    if (record.sourceId !== "x") {
      return {
        sourceId: "x",
        name: "X / Twitter (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' is registered for source '${record.sourceId}', not 'x'. Cross-source authorization attempts fail closed.`,
        legalDisclaimer: "Technical gate enforced: Mismatched source record fails closed.",
      };
    }

    if (record.status !== "APPROVED") {
      return {
        sourceId: "x",
        name: record.name,
        status: record.status,
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: `Authorization record '${recordId}' has status '${record.status}'. Access is denied while not APPROVED. Notes: ${record.approvalProvenance.notes}`,
        legalDisclaimer: `Technical gate enforced: Record status is ${record.status}.`,
        record,
      };
    }

    const dateCheck = isRecordDateValid(record, now);
    if (!dateCheck.valid) {
      return {
        sourceId: "x",
        name: record.name,
        status: dateCheck.status ?? "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: dateCheck.reason ?? "Record date invalid.",
        legalDisclaimer: "Technical gate enforced: Temporal validity check failed.",
        record,
      };
    }

    const scopeCheck = isRecordScopeValid(record, requiredScope);
    if (!scopeCheck.valid) {
      return {
        sourceId: "x",
        name: record.name,
        status: "BLOCKED",
        enabled: false,
        authRecordId: recordId,
        commercialUsePermitted: false,
        reason: scopeCheck.reason ?? "Record scope invalid.",
        legalDisclaimer: "Technical gate enforced: Scope check failed.",
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
      reason: `Operator enabled with verified, approved authorization record: ${recordId}. Approved by: ${record.approvalProvenance.approvedBy}.`,
      legalDisclaimer: `Software verified technical registry status and record reference '${recordId}'. Software cannot verify external legal sufficiency; operator is responsible for legal contract validity.`,
      record,
    };
  }

  if (sourceId === "website_crawler") {
    const record = getTrustedRecord("REC-WEBSITE-CRAWLER-FIRST-PARTY");
    return {
      sourceId: "website_crawler",
      name: "Target Website Web Crawler",
      status: "APPROVED",
      enabled: true,
      authRecordId: "REC-WEBSITE-CRAWLER-FIRST-PARTY",
      commercialUsePermitted: true,
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
    reason: `Source '${sourceId}' is unclassified. Access fails closed by default.`,
    legalDisclaimer: "Technical gate enforced: Unclassified source fails closed.",
  };
}

export function isSourceAuthorized(
  sourceId: SourceId,
  options?: SourcePolicyOptions,
): boolean {
  return getSourcePolicy(sourceId, options).enabled;
}

export function assertSourceAuthorized(
  sourceId: SourceId,
  options?: SourcePolicyOptions,
): void {
  const policy = getSourcePolicy(sourceId, options);
  if (!policy.enabled) {
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
