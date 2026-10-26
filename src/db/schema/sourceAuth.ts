import { randomUUID } from "node:crypto";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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

export type OperatorRole = "system_administrator" | "compliance_officer" | "legal_counsel";

/**
 * Authoritative persisted operator credentials.
 * Binds cryptographic secret hashes to verified identities and permitted roles.
 */
export const operatorCredentials = pgTable(
  "operator_credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    operatorId: text("operator_id").notNull(),
    role: text("role").notNull().$type<OperatorRole>(),
    secretHash: text("secret_hash").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revocationReason: text("revocation_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("operator_credentials_operator_id_idx").on(t.operatorId),
    index("operator_credentials_role_idx").on(t.role),
    index("operator_credentials_revoked_idx").on(t.revoked),
  ],
);

/**
 * Durable append-only audit trail recording all operator credential
 * provisioning, registration, rotation, and revocation events.
 */
export const operatorCredentialAuditEvents = pgTable(
  "operator_credential_audit_events",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => operatorCredentials.credentialId, { onDelete: "restrict" }),
    action: text("action").notNull(), // "PROVISION" | "REGISTER" | "ROTATE" | "REVOKE"
    performedBy: text("performed_by").notNull(),
    actorRole: text("actor_role").notNull(),
    reason: text("reason").notNull(),
    previousState: jsonb("previous_state").$type<Record<string, unknown>>(),
    newState: jsonb("new_state").$type<Record<string, unknown>>().notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("operator_credential_audit_events_credential_id_idx").on(t.credentialId),
    index("operator_credential_audit_events_created_at_idx").on(t.createdAt),
  ],
);

/**
 * Authoritative persisted operator bootstrap singleton state.
 * Enforces first-use-only bootstrap constraint and tracks recovery operations.
 */
export const operatorBootstrapState = pgTable("operator_bootstrap_state", {
  id: text("id").primaryKey(),
  isBootstrapped: boolean("is_bootstrapped").notNull().default(false),
  bootstrappedAt: timestamp("bootstrapped_at", { withTimezone: true }),
  bootstrappedBy: text("bootstrapped_by"),
  recoveryCount: integer("recovery_count").notNull().default(0),
  lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true }),
  lastRecoveryReason: text("last_recovery_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only durable audit trail recording administrative and customer deletion actions.
 * Records target type, target ID, actor identity, timestamp, and safe metadata.
 * Strictly avoids retaining deleted post text, comment text, or personal profiles.
 */
export const deletionAuditLog = pgTable(
  "deletion_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    action: text("action").notNull(), // e.g. "DELETE_POST" | "ERASE_AUTHOR" | "DELETE_PROJECT" | "TTL_BATCH_CLEANUP"
    actor: text("actor").notNull(), // operator ID, user ID, or system service name
    actorRole: text("actor_role").notNull(), // "system_administrator" | "compliance_officer" | "project_owner" | "system_service"
    targetType: text("target_type").notNull(), // "reddit_post" | "reddit_author" | "x_post" | "x_author" | "project" | "retention_batch"
    targetId: text("target_id").notNull(),
    outcome: text("outcome").notNull(), // "SUCCESS" | "NOT_FOUND" | "DENIED"
    reasonCode: text("reason_code").notNull(), // e.g. "OPERATOR_DELETION" | "AUTHOR_ERASURE_REQUEST" | "USER_REQUEST" | "ROUTINE_TTL_EXPIRY"
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deletion_audit_log_target_idx").on(t.targetType, t.targetId),
    index("deletion_audit_log_actor_idx").on(t.actor),
    index("deletion_audit_log_created_at_idx").on(t.createdAt),
  ],
);

/**
 * Alias for deletionAuditLog referenced across operator audit documentation.
 */
export const operatorAuditLog = deletionAuditLog;
