import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type SourceAuthStatus = "PENDING" | "APPROVED" | "BLOCKED" | "EXPIRED";

export type SourceUsagePurpose =
  | "commercial_lead_generation"
  | "competitor_intelligence"
  | "seo_opportunity_discovery"
  | "social_intent_monitoring"
  | "customer_website_coverage"
  | "compliance_audit"
  | "read_only_audit"
  | "academic_research";

export type SourceUsageScope =
  | "search_discovery"
  | "social_content_read"
  | "comments_read"
  | "profile_metadata_read"
  | "customer_domain_crawl"
  | "commercial_indexing"
  | "social_intent_monitoring"
  | "read_only_audit"
  | "test_scope";

/**
 * Authoritative persisted source authorization records.
 * Enforces technical access boundaries across application instances.
 */
export const sourceAuthRecords = pgTable(
  "source_auth_records",
  {
    recordId: text("record_id").primaryKey(),
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().$type<SourceAuthStatus>(),
    authorizedPurposes: jsonb("authorized_purposes").$type<SourceUsagePurpose[]>().notNull(),
    scopes: jsonb("scopes").$type<SourceUsageScope[]>().notNull(),
    effectiveDate: timestamp("effective_date", { withTimezone: true }).notNull(),
    expirationDate: timestamp("expiration_date", { withTimezone: true }),
    evidenceReference: text("evidence_reference").notNull(),
    approvalProvenance: jsonb("approval_provenance")
      .$type<{
        approvedBy: string;
        reviewedAt: string;
        notes: string;
      }>()
      .notNull(),
    revocationReason: text("revocation_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_auth_records_source_id_idx").on(t.sourceId),
    index("source_auth_records_status_idx").on(t.status),
  ],
);

/**
 * Durable append-only audit trail recording all registration, approval,
 * modification, and revocation events.
 */
export const sourceAuthAuditEvents = pgTable(
  "source_auth_audit_events",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id")
      .notNull()
      .references(() => sourceAuthRecords.recordId, { onDelete: "restrict" }),
    action: text("action").notNull(), // "REGISTER" | "APPROVE" | "UPDATE" | "REVOKE"
    performedBy: text("performed_by").notNull(),
    actorRole: text("actor_role").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    reason: text("reason").notNull(),
    previousStatus: text("previous_status"),
    newStatus: text("new_status").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_auth_audit_events_record_id_idx").on(t.recordId),
    index("source_auth_audit_events_created_at_idx").on(t.createdAt),
  ],
);
