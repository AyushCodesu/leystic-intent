import { config } from "./config";

export type SourceId = "reddit" | "x" | "google_serp" | "website_crawler";

export type SourceAuthStatus = "PENDING" | "APPROVED" | "BLOCKED" | "EXPIRED";

export type SourcePolicy = {
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus;
  enabled: boolean;
  authRecordId: string | null;
  commercialUsePermitted: boolean;
  reason: string;
  legalDisclaimer: string;
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

const PLACEHOLDER_RECORD_IDS = new Set([
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
 * Returns the effective source authorization policy for a data source.
 *
 * Fail-Closed Invariants:
 * 1. Reddit commercial access is disabled by default unless explicitly enabled AND
 *    linked to a valid, non-placeholder authorization record reference.
 * 2. An environment flag alone (REDDIT_SOURCE_ENABLED=true without record id) fails closed.
 * 3. Software verifies technical configuration and record references, but cannot verify
 *    legal sufficiency; external contracts remain required.
 */
export function getSourcePolicy(sourceId: SourceId): SourcePolicy {
  const cfg = config();

  if (sourceId === "reddit") {
    const isFlagOn = cfg.REDDIT_SOURCE_ENABLED ?? false;
    const recordId = cfg.REDDIT_AUTH_RECORD_ID?.trim() ?? null;

    if (!isFlagOn) {
      return {
        sourceId: "reddit",
        name: "Reddit (via AnyAPI Gateway)",
        status: "BLOCKED",
        enabled: false,
        authRecordId: null,
        commercialUsePermitted: false,
        reason:
          "Commercial Reddit data access is disabled by default. No verified commercial agreement has been authorized.",
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
          "REDDIT_SOURCE_ENABLED is set, but REDDIT_AUTH_RECORD_ID is missing or placeholder. An environment flag alone is not proof of permission. A verified authorization record reference from docs/source-authorization-register.md is required.",
        legalDisclaimer:
          "Technical gate enforced: Environment flag without verified authorization record reference fails closed.",
      };
    }

    return {
      sourceId: "reddit",
      name: "Reddit (via AnyAPI Gateway)",
      status: "APPROVED",
      enabled: true,
      authRecordId: recordId,
      commercialUsePermitted: true,
      reason: `Operator enabled with authorization record reference: ${recordId}`,
      legalDisclaimer: `Software verified technical configuration and record reference '${recordId}'. Software cannot verify the legal sufficiency of this authorization record; operator is responsible for external legal validity.`,
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
        authRecordId: null,
        commercialUsePermitted: false,
        reason: "X leads feature is disabled by configuration (X_LEADS=false).",
        legalDisclaimer: "Technical gate enforced: X data collection and serving are disabled.",
      };
    }

    return {
      sourceId: "x",
      name: "X / Twitter (via AnyAPI Gateway)",
      status: recordId ? "APPROVED" : "PENDING",
      enabled: isFlagOn,
      authRecordId: recordId,
      commercialUsePermitted: Boolean(recordId),
      reason: recordId
        ? `Operator enabled with authorization record reference: ${recordId}`
        : "X_LEADS is enabled under pilot review pending enterprise agreement.",
      legalDisclaimer:
        "Software cannot verify the legal sufficiency of third-party platform terms; operator is responsible for external legal validity.",
    };
  }

  if (sourceId === "website_crawler") {
    return {
      sourceId: "website_crawler",
      name: "Target Website Web Crawler",
      status: "APPROVED",
      enabled: true,
      authRecordId: "FIRST_PARTY_CUSTOMER_WEBSITE_AUDIT",
      commercialUsePermitted: true,
      reason:
        "First-party website audit initiated by authenticated project owner for their own configured website domain.",
      legalDisclaimer:
        "Connection-pinned crawler with SSRF and DNS-rebinding protection restricted to customer domains.",
    };
  }

  // google_serp
  return {
    sourceId: "google_serp",
    name: "Google Search (SERP)",
    status: "APPROVED",
    enabled: true,
    authRecordId: "SERP_SEARCH_DISCOVERY",
    commercialUsePermitted: true,
    reason:
      "Public search index queries used for phrasing discovery. Downstream Reddit thread access is governed by the Reddit source gate.",
    legalDisclaimer: "Public search engine queries.",
  };
}

export function isSourceAuthorized(sourceId: SourceId): boolean {
  return getSourcePolicy(sourceId).enabled;
}

export function assertSourceAuthorized(sourceId: SourceId): void {
  const policy = getSourcePolicy(sourceId);
  if (!policy.enabled) {
    throw new SourceUnauthorizedError(
      sourceId,
      policy.reason,
      policy.status,
      policy.authRecordId,
    );
  }
}

/** Resolves the data source category for a given SKU. */
export function sourceForSku(sku: string): SourceId | null {
  if (sku.startsWith("reddit.")) return "reddit";
  if (sku.startsWith("twitter.")) return "x";
  if (sku.startsWith("google.")) return "google_serp";
  return null;
}

/** Lists the current policy state across all tracked data sources. */
export function allSourcePolicies(): SourcePolicy[] {
  return (["reddit", "x", "google_serp", "website_crawler"] as SourceId[]).map(getSourcePolicy);
}
