-- Step 1: Sanitize any existing author usernames previously persisted in deletion_audit_log before enforcing immutability
UPDATE "deletion_audit_log"
SET "target_id" = 'anon-author-' || substr(md5("id" || '-' || "created_at"::text), 1, 16)
WHERE "action" IN ('ERASE_REDDIT_AUTHOR', 'ERASE_X_AUTHOR')
  AND "target_id" NOT LIKE 'anon-author-%';

UPDATE "deletion_audit_log"
SET "details" = "details" - 'username' - 'author'
WHERE "action" IN ('ERASE_REDDIT_AUTHOR', 'ERASE_X_AUTHOR')
  AND ("details" ? 'username' OR "details" ? 'author');

-- Step 2: Database-level immutability enforcement: deletion_audit_log is strictly append-only
CREATE OR REPLACE FUNCTION prevent_deletion_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'deletion_audit_log is an append-only audit ledger: UPDATE and DELETE operations are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_deletion_audit_log_mutation ON "deletion_audit_log";
CREATE TRIGGER trg_prevent_deletion_audit_log_mutation
BEFORE UPDATE OR DELETE ON "deletion_audit_log"
FOR EACH ROW EXECUTE FUNCTION prevent_deletion_audit_log_mutation();

CREATE OR REPLACE FUNCTION prevent_deletion_audit_log_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'deletion_audit_log is an append-only audit ledger: TRUNCATE is prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_deletion_audit_log_truncate ON "deletion_audit_log";
CREATE TRIGGER trg_prevent_deletion_audit_log_truncate
BEFORE TRUNCATE ON "deletion_audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_deletion_audit_log_truncate();

REVOKE TRUNCATE, DELETE, UPDATE ON "deletion_audit_log" FROM PUBLIC;
