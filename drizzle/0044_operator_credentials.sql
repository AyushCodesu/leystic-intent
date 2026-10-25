CREATE TABLE IF NOT EXISTS "operator_credentials" (
  "credential_id" text PRIMARY KEY NOT NULL,
  "operator_id" text NOT NULL,
  "role" text NOT NULL,
  "secret_hash" text NOT NULL,
  "revoked" boolean DEFAULT false NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "revocation_reason" text,
  "expires_at" timestamp with time zone,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "operator_credentials_operator_id_idx" ON "operator_credentials" ("operator_id");
CREATE INDEX IF NOT EXISTS "operator_credentials_role_idx" ON "operator_credentials" ("role");
CREATE INDEX IF NOT EXISTS "operator_credentials_revoked_idx" ON "operator_credentials" ("revoked");

CREATE TABLE IF NOT EXISTS "operator_credential_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "credential_id" text NOT NULL REFERENCES "operator_credentials"("credential_id") ON DELETE RESTRICT,
  "action" text NOT NULL,
  "performed_by" text NOT NULL,
  "actor_role" text NOT NULL,
  "reason" text NOT NULL,
  "previous_state" jsonb,
  "new_state" jsonb NOT NULL,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "operator_credential_audit_events_credential_id_idx" ON "operator_credential_audit_events" ("credential_id");
CREATE INDEX IF NOT EXISTS "operator_credential_audit_events_created_at_idx" ON "operator_credential_audit_events" ("created_at");

-- Database-level immutability enforcement: audit trail is strictly append-only
CREATE OR REPLACE FUNCTION prevent_operator_credential_audit_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'operator_credential_audit_events is an append-only audit ledger: UPDATE and DELETE operations are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_operator_credential_audit_events_mutation ON "operator_credential_audit_events";
CREATE TRIGGER trg_prevent_operator_credential_audit_events_mutation
BEFORE UPDATE OR DELETE ON "operator_credential_audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_operator_credential_audit_events_mutation();

CREATE OR REPLACE FUNCTION prevent_operator_credential_audit_events_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'operator_credential_audit_events is an append-only audit ledger: TRUNCATE is prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_operator_credential_audit_events_truncate ON "operator_credential_audit_events";
CREATE TRIGGER trg_prevent_operator_credential_audit_events_truncate
BEFORE TRUNCATE ON "operator_credential_audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_operator_credential_audit_events_truncate();

REVOKE TRUNCATE, DELETE, UPDATE ON "operator_credential_audit_events" FROM PUBLIC;
