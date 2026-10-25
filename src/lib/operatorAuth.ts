import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type OperatorRole = "system_administrator" | "compliance_officer" | "legal_counsel";

export const VALID_OPERATOR_ROLES: readonly OperatorRole[] = [
  "system_administrator",
  "compliance_officer",
  "legal_counsel",
] as const;

export type OperatorCredentialAction = "PROVISION" | "REGISTER" | "ROTATE" | "REVOKE";

export interface VerifiedOperator {
  credentialId: string;
  operatorId: string;
  role: OperatorRole;
  verifiedAt: string;
}

export interface OperatorCredentialRecord {
  credentialId: string;
  operatorId: string;
  role: OperatorRole;
  /** SHA-256 hash of the operator secret token in 64 lowercase hex characters */
  secretHash: string;
  revoked: boolean;
  revokedAt?: string | null;
  revokedBy?: string | null;
  revocationReason?: string | null;
  expiresAt?: string | null; // ISO 8601
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OperatorCredentialAuditEvent {
  id: string;
  credentialId: string;
  action: OperatorCredentialAction;
  performedBy: string;
  actorRole: string;
  reason: string;
  previousState?: Record<string, unknown> | null;
  newState: Record<string, unknown>;
  details?: Record<string, unknown>;
  createdAt: string; // ISO 8601
}

export interface OperatorContext {
  operatorId?: string;
  role?: OperatorRole;
  operatorKey?: string;
  token?: string;
  masterKey?: string;
  operatorSecretKey?: string;
}

export type InvalidationCallback = (payload?: { credentialId?: string; action?: string }) => void;

export class OperatorAuthorizationError extends Error {
  constructor(message: string) {
    super(`[Operator Authorization Error] ${message}`);
    this.name = "OperatorAuthorizationError";
  }
}

export class InvalidCredentialRecordError extends Error {
  constructor(message: string) {
    super(`[Invalid Credential Record] ${message}`);
    this.name = "InvalidCredentialRecordError";
  }
}

export function hashOperatorSecret(secret: string): string {
  return createHash("sha256").update(secret.trim()).digest("hex").toLowerCase();
}

export function safeCompareHashes(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a.trim().toLowerCase(), "hex");
    const bufB = Buffer.from(b.trim().toLowerCase(), "hex");
    if (bufA.length !== 32 || bufB.length !== 32) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function safeCompareStrings(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function validateSecretTokenStrength(
  secret: string,
  isProduction = process.env.NODE_ENV === "production",
): void {
  if (!secret || typeof secret !== "string") {
    throw new OperatorAuthorizationError("Operator secret token must be a non-empty string.");
  }
  const trimmed = secret.trim();
  const minLength = isProduction ? 32 : 16;
  if (trimmed.length < minLength) {
    throw new OperatorAuthorizationError(
      `Operator secret token must be at least ${minLength} characters long (provided length: ${trimmed.length}).`,
    );
  }
  const uniqueChars = new Set(trimmed);
  const minEntropy = isProduction ? 6 : 4;
  if (uniqueChars.size < minEntropy) {
    throw new OperatorAuthorizationError(
      "Operator secret token lacks sufficient entropy (too few unique characters).",
    );
  }
}

function cloneAndFreezeCredential(cred: OperatorCredentialRecord): OperatorCredentialRecord {
  const cloned: OperatorCredentialRecord = {
    credentialId: cred.credentialId,
    operatorId: cred.operatorId,
    role: cred.role,
    secretHash: cred.secretHash,
    revoked: cred.revoked,
    revokedAt: cred.revokedAt ?? null,
    revokedBy: cred.revokedBy ?? null,
    revocationReason: cred.revocationReason ?? null,
    expiresAt: cred.expiresAt ?? null,
    description: cred.description ?? null,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
  return Object.freeze(cloned);
}

export function validateOperatorCredentialRecord(record: unknown): OperatorCredentialRecord {
  if (!record || typeof record !== "object") {
    throw new InvalidCredentialRecordError("Credential record must be a non-null object.");
  }
  const r = record as Record<string, unknown>;

  if (typeof r.credentialId !== "string" || !r.credentialId.trim()) {
    throw new InvalidCredentialRecordError("credentialId must be a non-empty string.");
  }
  const credentialId = r.credentialId.trim();

  if (typeof r.operatorId !== "string" || !r.operatorId.trim()) {
    throw new InvalidCredentialRecordError("operatorId must be a non-empty string.");
  }
  const operatorId = r.operatorId.trim();
  if (operatorId.toLowerCase() === "anon" || operatorId.toLowerCase().includes("unknown")) {
    throw new InvalidCredentialRecordError("Anonymous or unverified operatorId rejected.");
  }

  if (typeof r.role !== "string" || !VALID_OPERATOR_ROLES.includes(r.role as OperatorRole)) {
    throw new InvalidCredentialRecordError(
      `Invalid operator role '${String(r.role)}'. Allowed roles: [${VALID_OPERATOR_ROLES.join(", ")}].`,
    );
  }
  const role = r.role as OperatorRole;

  if (typeof r.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(r.secretHash.trim().toLowerCase())) {
    throw new InvalidCredentialRecordError(
      "secretHash must be a valid 64-character lowercase hex SHA-256 hash.",
    );
  }
  const secretHash = r.secretHash.trim().toLowerCase();

  if (typeof r.revoked !== "boolean") {
    throw new InvalidCredentialRecordError("revoked must be an explicit boolean.");
  }
  const revoked = r.revoked;

  let revokedAt: string | null = null;
  if (revoked) {
    if (typeof r.revokedAt !== "string" || isNaN(new Date(r.revokedAt).getTime())) {
      throw new InvalidCredentialRecordError(
        "revokedAt must be a valid date string when revoked is true.",
      );
    }
    revokedAt = r.revokedAt;
  } else {
    if (r.revokedAt !== null && r.revokedAt !== undefined) {
      throw new InvalidCredentialRecordError(
        "revokedAt must be null or undefined when revoked is false.",
      );
    }
  }

  let expiresAt: string | null = null;
  if (r.expiresAt !== null && r.expiresAt !== undefined) {
    if (typeof r.expiresAt !== "string" || isNaN(new Date(r.expiresAt).getTime())) {
      throw new InvalidCredentialRecordError("expiresAt must be a valid date string when provided.");
    }
    expiresAt = r.expiresAt;
  }

  return cloneAndFreezeCredential({
    credentialId,
    operatorId,
    role,
    secretHash,
    revoked,
    revokedAt,
    revokedBy: typeof r.revokedBy === "string" ? r.revokedBy : null,
    revocationReason: typeof r.revocationReason === "string" ? r.revocationReason : null,
    expiresAt,
    description: typeof r.description === "string" ? r.description : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
  });
}

export const DEFAULT_TEST_CREDENTIALS: readonly OperatorCredentialRecord[] = Object.freeze([
  Object.freeze({
    credentialId: "cred_legal_default",
    operatorId: "legal_counsel_001",
    role: "legal_counsel" as OperatorRole,
    secretHash: hashOperatorSecret("legal_secret_key_001"),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    expiresAt: null,
    description: "Default test fixture for legal counsel",
  }),
  Object.freeze({
    credentialId: "cred_compliance_default",
    operatorId: "compliance_officer_001",
    role: "compliance_officer" as OperatorRole,
    secretHash: hashOperatorSecret("compliance_secret_key_001"),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    expiresAt: null,
    description: "Default test fixture for compliance officer",
  }),
  Object.freeze({
    credentialId: "cred_admin_default",
    operatorId: "sysadmin_001",
    role: "system_administrator" as OperatorRole,
    secretHash: hashOperatorSecret("admin_secret_key_001"),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    expiresAt: null,
    description: "Default test fixture for system administrator",
  }),
]);

export interface OperatorCredentialStore {
  getCredential(credentialId: string): Promise<OperatorCredentialRecord | null>;
  getAllCredentials(): Promise<OperatorCredentialRecord[]>;
  saveCredential(
    credential: OperatorCredentialRecord,
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<void>;
  revokeCredential(
    credentialId: string,
    revocation: {
      revokedBy: string;
      revocationReason: string;
      revokedAt?: string;
    },
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<OperatorCredentialRecord>;
  getAuditEvents(credentialId?: string): Promise<OperatorCredentialAuditEvent[]>;
  subscribeInvalidation?(callback: InvalidationCallback): () => void;
  checkInvalidated?(sinceMs: number): boolean;
  readStateSync?(): OperatorCredentialRecord[];
  resetToDefaults?(): Promise<void>;
}

const operatorFileStoreEventBus = new EventEmitter();

/**
 * File-backed persistent storage using atomic JSON file updates.
 * Used for isolated tests and offline development environments.
 */
export class PersistentFileOperatorCredentialStore implements OperatorCredentialStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.OPERATOR_CREDENTIAL_REGISTRY_PATH ??
      path.join(os.tmpdir(), "leystic_operator_credentials.json");
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    if (!fs.existsSync(this.filePath)) {
      const credentials: Record<string, OperatorCredentialRecord> = {};
      const auditEvents: OperatorCredentialAuditEvent[] = [];

      // Production must never seed default test credentials
      if (process.env.NODE_ENV !== "production") {
        for (const cred of DEFAULT_TEST_CREDENTIALS) {
          credentials[cred.credentialId] = { ...cred };
          auditEvents.push({
            id: `seed_op_${randomUUID().slice(0, 8)}`,
            credentialId: cred.credentialId,
            action: "PROVISION",
            performedBy: "system_bootstrap",
            actorRole: "system_administrator",
            reason: `Initial test fixture provisioning: ${cred.role}`,
            previousState: null,
            newState: { ...cred },
            createdAt: new Date().toISOString(),
          });
        }
      }

      const tmp = `${this.filePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ credentials, auditEvents }, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    }
  }

  private readState(): {
    credentials: Record<string, OperatorCredentialRecord>;
    auditEvents: OperatorCredentialAuditEvent[];
  } {
    this.ensureInitialized();
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return { credentials: {}, auditEvents: [] };
    }
  }

  readStateSync(): OperatorCredentialRecord[] {
    const state = this.readState();
    return Object.values(state.credentials).map(validateOperatorCredentialRecord);
  }

  private writeState(state: {
    credentials: Record<string, OperatorCredentialRecord>;
    auditEvents: OperatorCredentialAuditEvent[];
  }): void {
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  async getCredential(credentialId: string): Promise<OperatorCredentialRecord | null> {
    const state = this.readState();
    const found = state.credentials[credentialId.trim()];
    return found ? validateOperatorCredentialRecord(found) : null;
  }

  async getAllCredentials(): Promise<OperatorCredentialRecord[]> {
    const state = this.readState();
    return Object.values(state.credentials).map(validateOperatorCredentialRecord);
  }

  async saveCredential(
    credential: OperatorCredentialRecord,
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<void> {
    const state = this.readState();
    state.credentials[credential.credentialId] = credential;
    state.auditEvents.push(auditEvent);
    this.writeState(state);
    operatorFileStoreEventBus.emit("invalidation", {
      filePath: this.filePath,
      credentialId: credential.credentialId,
      action: auditEvent.action,
    });
  }

  async revokeCredential(
    credentialId: string,
    revocation: {
      revokedBy: string;
      revocationReason: string;
      revokedAt?: string;
    },
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<OperatorCredentialRecord> {
    const state = this.readState();
    const existing = state.credentials[credentialId.trim()];
    if (!existing) {
      throw new OperatorAuthorizationError(
        `Cannot revoke credential '${credentialId}': credential not found in registry.`,
      );
    }
    const updated: OperatorCredentialRecord = {
      ...existing,
      revoked: true,
      revokedAt: revocation.revokedAt ?? new Date().toISOString(),
      revokedBy: revocation.revokedBy,
      revocationReason: revocation.revocationReason,
      updatedAt: new Date().toISOString(),
    };
    state.credentials[credentialId.trim()] = updated;
    state.auditEvents.push(auditEvent);
    this.writeState(state);
    operatorFileStoreEventBus.emit("invalidation", {
      filePath: this.filePath,
      credentialId,
      action: "REVOKE",
    });
    return validateOperatorCredentialRecord(updated);
  }

  async getAuditEvents(credentialId?: string): Promise<OperatorCredentialAuditEvent[]> {
    const state = this.readState();
    if (!credentialId) return [...state.auditEvents];
    return state.auditEvents.filter((e) => e.credentialId === credentialId.trim());
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
    operatorFileStoreEventBus.emit("invalidation", { filePath: this.filePath });
  }

  subscribeInvalidation(callback: InvalidationCallback): () => void {
    const handler = (evt: { filePath: string; credentialId?: string; action?: string }) => {
      if (evt.filePath === this.filePath) {
        callback({ credentialId: evt.credentialId, action: evt.action });
      }
    };
    operatorFileStoreEventBus.on("invalidation", handler);
    return () => {
      operatorFileStoreEventBus.off("invalidation", handler);
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
export class DrizzleOperatorCredentialStore implements OperatorCredentialStore {
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
      const { unlisten } = await client.listen("operator_credential_invalidation", (msg) => {
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

  async getCredential(credentialId: string): Promise<OperatorCredentialRecord | null> {
    const { db } = await import("@/db");
    const { operatorCredentials } = await import("@/db/schema/sourceAuth");
    const { eq } = await import("drizzle-orm");

    const rows = await db()
      .select()
      .from(operatorCredentials)
      .where(eq(operatorCredentials.credentialId, credentialId.trim()))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return validateOperatorCredentialRecord({
      credentialId: row.credentialId,
      operatorId: row.operatorId,
      role: row.role as OperatorRole,
      secretHash: row.secretHash,
      revoked: row.revoked,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedBy: row.revokedBy,
      revocationReason: row.revocationReason,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async getAllCredentials(): Promise<OperatorCredentialRecord[]> {
    const { db } = await import("@/db");
    const { operatorCredentials } = await import("@/db/schema/sourceAuth");

    const rows = await db().select().from(operatorCredentials);
    return rows.map((row) =>
      validateOperatorCredentialRecord({
        credentialId: row.credentialId,
        operatorId: row.operatorId,
        role: row.role as OperatorRole,
        secretHash: row.secretHash,
        revoked: row.revoked,
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        revokedBy: row.revokedBy,
        revocationReason: row.revocationReason,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  }

  async saveCredential(
    credential: OperatorCredentialRecord,
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<void> {
    const { db } = await import("@/db");
    const { operatorCredentials, operatorCredentialAuditEvents } = await import("@/db/schema/sourceAuth");
    const { sql } = await import("drizzle-orm");

    await db().transaction(async (tx) => {
      await tx
        .insert(operatorCredentials)
        .values({
          credentialId: credential.credentialId,
          operatorId: credential.operatorId,
          role: credential.role,
          secretHash: credential.secretHash,
          revoked: credential.revoked,
          revokedAt: credential.revokedAt ? new Date(credential.revokedAt) : null,
          revokedBy: credential.revokedBy ?? null,
          revocationReason: credential.revocationReason ?? null,
          expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
          description: credential.description ?? null,
          createdAt: credential.createdAt ? new Date(credential.createdAt) : new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: operatorCredentials.credentialId,
          set: {
            operatorId: credential.operatorId,
            role: credential.role,
            secretHash: credential.secretHash,
            revoked: credential.revoked,
            revokedAt: credential.revokedAt ? new Date(credential.revokedAt) : null,
            revokedBy: credential.revokedBy ?? null,
            revocationReason: credential.revocationReason ?? null,
            expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
            description: credential.description ?? null,
            updatedAt: new Date(),
          },
        });

      await tx.insert(operatorCredentialAuditEvents).values({
        id: auditEvent.id,
        credentialId: auditEvent.credentialId,
        action: auditEvent.action,
        performedBy: auditEvent.performedBy,
        actorRole: auditEvent.actorRole,
        reason: auditEvent.reason,
        previousState: auditEvent.previousState ?? null,
        newState: auditEvent.newState,
        details: auditEvent.details ?? null,
        createdAt: new Date(auditEvent.createdAt),
      });

      await tx.execute(
        sql`SELECT pg_notify('operator_credential_invalidation', ${JSON.stringify({ credentialId: credential.credentialId, action: auditEvent.action })});`,
      );
    });
  }

  async revokeCredential(
    credentialId: string,
    revocation: {
      revokedBy: string;
      revocationReason: string;
      revokedAt?: string;
    },
    auditEvent: OperatorCredentialAuditEvent,
  ): Promise<OperatorCredentialRecord> {
    const { db } = await import("@/db");
    const { operatorCredentials, operatorCredentialAuditEvents } = await import("@/db/schema/sourceAuth");
    const { eq, sql } = await import("drizzle-orm");

    return await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(operatorCredentials)
        .where(eq(operatorCredentials.credentialId, credentialId.trim()))
        .limit(1);

      const existing = rows[0];
      if (!existing) {
        throw new OperatorAuthorizationError(
          `Cannot revoke credential '${credentialId}': credential not found in database.`,
        );
      }

      const revokedAt = revocation.revokedAt ? new Date(revocation.revokedAt) : new Date();

      const [updatedRow] = await tx
        .update(operatorCredentials)
        .set({
          revoked: true,
          revokedAt,
          revokedBy: revocation.revokedBy,
          revocationReason: revocation.revocationReason,
          updatedAt: new Date(),
        })
        .where(eq(operatorCredentials.credentialId, credentialId.trim()))
        .returning();

      await tx.insert(operatorCredentialAuditEvents).values({
        id: auditEvent.id,
        credentialId: auditEvent.credentialId,
        action: auditEvent.action,
        performedBy: auditEvent.performedBy,
        actorRole: auditEvent.actorRole,
        reason: auditEvent.reason,
        previousState: auditEvent.previousState ?? null,
        newState: auditEvent.newState,
        details: auditEvent.details ?? null,
        createdAt: new Date(auditEvent.createdAt),
      });

      await tx.execute(
        sql`SELECT pg_notify('operator_credential_invalidation', ${JSON.stringify({ credentialId: credentialId.trim(), action: "REVOKE" })});`,
      );

      return validateOperatorCredentialRecord({
        credentialId: updatedRow.credentialId,
        operatorId: updatedRow.operatorId,
        role: updatedRow.role as OperatorRole,
        secretHash: updatedRow.secretHash,
        revoked: updatedRow.revoked,
        revokedAt: updatedRow.revokedAt ? updatedRow.revokedAt.toISOString() : null,
        revokedBy: updatedRow.revokedBy,
        revocationReason: updatedRow.revocationReason,
        expiresAt: updatedRow.expiresAt ? updatedRow.expiresAt.toISOString() : null,
        description: updatedRow.description,
        createdAt: updatedRow.createdAt.toISOString(),
        updatedAt: updatedRow.updatedAt.toISOString(),
      });
    });
  }

  async getAuditEvents(credentialId?: string): Promise<OperatorCredentialAuditEvent[]> {
    const { db } = await import("@/db");
    const { operatorCredentialAuditEvents } = await import("@/db/schema/sourceAuth");
    const { desc, eq } = await import("drizzle-orm");

    const query = db().select().from(operatorCredentialAuditEvents);
    const rows = credentialId
      ? await query
          .where(eq(operatorCredentialAuditEvents.credentialId, credentialId.trim()))
          .orderBy(desc(operatorCredentialAuditEvents.createdAt))
      : await query.orderBy(desc(operatorCredentialAuditEvents.createdAt));

    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credentialId,
      action: r.action as OperatorCredentialAction,
      performedBy: r.performedBy,
      actorRole: r.actorRole,
      reason: r.reason,
      previousState: (r.previousState as Record<string, unknown>) ?? null,
      newState: (r.newState as Record<string, unknown>) ?? {},
      details: (r.details as Record<string, unknown>) ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export function createDefaultOperatorCredentialStore(): OperatorCredentialStore {
  if (process.env.NODE_ENV === "production") {
    return new DrizzleOperatorCredentialStore();
  }
  if (
    process.env.SOURCE_AUTH_STORE === "drizzle" ||
    process.env.OPERATOR_CREDENTIAL_STORE === "drizzle"
  ) {
    return new DrizzleOperatorCredentialStore();
  }
  return new PersistentFileOperatorCredentialStore();
}

export const DEFAULT_MAX_STALENESS_MS = 2000;

/**
 * Server-side operator credential registry coordinating durable storage,
 * defensive copying, schema validation, and verified operator authorization.
 */
export class OperatorCredentialRegistry {
  private store: OperatorCredentialStore;
  private cache = new Map<string, OperatorCredentialRecord>();
  private lastSyncMs = 0;
  private readonly maxStalenessMs: number;
  private revision = 0;
  private storeHealthy = true;
  private isHydrated = false;
  private unsubscribeStore?: () => void;

  constructor(store?: OperatorCredentialStore, maxStalenessMs = DEFAULT_MAX_STALENESS_MS) {
    this.store = store ?? createDefaultOperatorCredentialStore();
    this.maxStalenessMs = maxStalenessMs;
    this.bindStoreListeners();
    if (process.env.NODE_ENV !== "production") {
      this.seedCacheDefaults();
    }
    this.loadFromEnvironment();
  }

  private bindStoreListeners(): void {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = undefined;
    }
    if (this.store.subscribeInvalidation) {
      this.unsubscribeStore = this.store.subscribeInvalidation((payload) => {
        if (payload?.credentialId) {
          this.cache.delete(payload.credentialId);
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
    // Production must never seed default or predictable test credentials
    if (process.env.NODE_ENV === "production") {
      this.storeHealthy = true;
      this.isHydrated = true;
      this.revision++;
      return;
    }
    for (const cred of DEFAULT_TEST_CREDENTIALS) {
      const validated = validateOperatorCredentialRecord(cred);
      this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
    }
    this.storeHealthy = true;
    this.isHydrated = true;
    this.revision++;
  }

  loadFromEnvironment(): void {
    const raw = process.env.OPERATOR_CREDENTIALS;
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            try {
              const validated = validateOperatorCredentialRecord(item);
              this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
            } catch {
              // Individual malformed credentials fail closed
            }
          }
        }
      } catch {
        // Malformed environment credentials fail closed
      }
    }
  }

  getStore(): OperatorCredentialStore {
    return this.store;
  }

  getRevision(): number {
    return this.revision;
  }

  isHealthy(): boolean {
    return this.storeHealthy;
  }

  setStore(store: OperatorCredentialStore): void {
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

  getCredential(credentialId: string): OperatorCredentialRecord | null {
    if (!this.storeHealthy) {
      return null;
    }
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      if (typeof this.store.readStateSync === "function") {
        try {
          const creds = this.store.readStateSync();
          this.cache.clear();
          for (const c of creds) {
            const validated = validateOperatorCredentialRecord(c);
            this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
          }
          this.lastSyncMs = Date.now();
        } catch {
          this.cache.delete(credentialId.trim());
        }
      } else {
        this.cache.delete(credentialId.trim());
      }
    }
    const found = this.cache.get(credentialId.trim());
    return found ? cloneAndFreezeCredential(found) : null;
  }

  getAllCredentials(): OperatorCredentialRecord[] {
    if (!this.storeHealthy) {
      return [];
    }
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      if (typeof this.store.readStateSync === "function") {
        try {
          const creds = this.store.readStateSync();
          this.cache.clear();
          for (const c of creds) {
            const validated = validateOperatorCredentialRecord(c);
            this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
          }
          this.lastSyncMs = Date.now();
        } catch {
          // ignore
        }
      }
    }
    return Array.from(this.cache.values()).map(cloneAndFreezeCredential);
  }

  findCredentialByToken(token: string): OperatorCredentialRecord | null {
    if (!token || typeof token !== "string" || !token.trim()) {
      return null;
    }
    if (!this.storeHealthy) {
      return null;
    }
    if (this.store.checkInvalidated && this.store.checkInvalidated(this.lastSyncMs)) {
      if (typeof this.store.readStateSync === "function") {
        try {
          const creds = this.store.readStateSync();
          this.cache.clear();
          for (const c of creds) {
            const validated = validateOperatorCredentialRecord(c);
            this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
          }
          this.lastSyncMs = Date.now();
        } catch {
          this.cache.clear();
        }
      }
    }
    const tokenHash = hashOperatorSecret(token);
    for (const cred of this.cache.values()) {
      if (safeCompareHashes(cred.secretHash, tokenHash)) {
        return cloneAndFreezeCredential(cred);
      }
    }
    return null;
  }

  async syncFromStore(): Promise<void> {
    try {
      const records = await this.store.getAllCredentials();
      this.cache.clear();
      for (const record of records) {
        const validated = validateOperatorCredentialRecord(record);
        this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
      }
      this.lastSyncMs = Date.now();
      this.isHydrated = true;
      this.storeHealthy = true;
      this.revision++;
    } catch (err) {
      this.storeHealthy = false;
      this.cache.clear();
      throw new Error(
        `Failed to synchronize operator credential registry from durable store: ${err instanceof Error ? err.message : String(err)}`,
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

  async registerCredential(
    operatorContext: unknown,
    params: {
      credentialId: string;
      operatorId: string;
      role: OperatorRole;
      secret: string;
      description?: string;
      expiresAt?: string | null;
    },
  ): Promise<OperatorCredentialRecord> {
    const verified = verifyOperatorCredentials(operatorContext, "system_administrator");
    validateSecretTokenStrength(params.secret);

    const record: OperatorCredentialRecord = {
      credentialId: params.credentialId.trim(),
      operatorId: params.operatorId.trim(),
      role: params.role,
      secretHash: hashOperatorSecret(params.secret),
      revoked: false,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      expiresAt: params.expiresAt ?? null,
      description: params.description ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const validated = validateOperatorCredentialRecord(record);
    const existing = this.cache.get(validated.credentialId);

    const auditEvent: OperatorCredentialAuditEvent = {
      id: `cred_audit_${randomUUID()}`,
      credentialId: validated.credentialId,
      action: "REGISTER",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      reason: `Operator ${verified.operatorId} registered credential for ${validated.operatorId} (${validated.role})`,
      previousState: existing ? { ...existing } : null,
      newState: { ...validated },
      createdAt: new Date().toISOString(),
    };

    await this.store.saveCredential(validated, auditEvent);
    const frozen = cloneAndFreezeCredential(validated);
    this.cache.set(validated.credentialId, frozen);
    this.revision++;
    return frozen;
  }

  async revokeCredential(
    operatorContext: unknown,
    params: {
      credentialId: string;
      reason: string;
      revokedAt?: string;
    },
  ): Promise<OperatorCredentialRecord> {
    const verified = verifyOperatorCredentials(operatorContext, [
      "system_administrator",
      "compliance_officer",
    ]);

    const existing = await this.store.getCredential(params.credentialId.trim());
    if (!existing) {
      throw new OperatorAuthorizationError(
        `Credential '${params.credentialId}' not found in registry.`,
      );
    }

    if (existing.revoked) {
      throw new OperatorAuthorizationError(
        `Credential '${params.credentialId}' has already been revoked.`,
      );
    }

    const revokedAt = params.revokedAt ?? new Date().toISOString();

    const auditEvent: OperatorCredentialAuditEvent = {
      id: `cred_audit_${randomUUID()}`,
      credentialId: params.credentialId.trim(),
      action: "REVOKE",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      reason: params.reason,
      previousState: { ...existing },
      newState: {
        ...existing,
        revoked: true,
        revokedAt,
        revokedBy: verified.operatorId,
        revocationReason: params.reason,
      },
      createdAt: revokedAt,
    };

    const revoked = await this.store.revokeCredential(
      params.credentialId.trim(),
      {
        revokedBy: verified.operatorId,
        revocationReason: params.reason,
        revokedAt,
      },
      auditEvent,
    );

    const frozen = cloneAndFreezeCredential(revoked);
    this.cache.set(params.credentialId.trim(), frozen);
    this.revision++;
    return frozen;
  }

  async rotateCredential(
    operatorContext: unknown,
    params: {
      credentialId: string;
      newSecret: string;
      reason: string;
    },
  ): Promise<OperatorCredentialRecord> {
    const verified = verifyOperatorCredentials(operatorContext, "system_administrator");
    validateSecretTokenStrength(params.newSecret);

    const existing = await this.store.getCredential(params.credentialId.trim());
    if (!existing) {
      throw new OperatorAuthorizationError(
        `Credential '${params.credentialId}' not found in registry.`,
      );
    }
    if (existing.revoked) {
      throw new OperatorAuthorizationError(
        `Cannot rotate revoked credential '${params.credentialId}'.`,
      );
    }

    const updated: OperatorCredentialRecord = {
      ...existing,
      secretHash: hashOperatorSecret(params.newSecret),
      updatedAt: new Date().toISOString(),
    };

    const validated = validateOperatorCredentialRecord(updated);

    const auditEvent: OperatorCredentialAuditEvent = {
      id: `cred_audit_${randomUUID()}`,
      credentialId: existing.credentialId,
      action: "ROTATE",
      performedBy: verified.operatorId,
      actorRole: verified.role,
      reason: params.reason,
      previousState: { ...existing },
      newState: { ...validated },
      createdAt: new Date().toISOString(),
    };

    await this.store.saveCredential(validated, auditEvent);
    const frozen = cloneAndFreezeCredential(validated);
    this.cache.set(validated.credentialId, frozen);
    this.revision++;
    return frozen;
  }

  async bootstrapCredentials(params: {
    bootstrapKey: string;
    credentials: Array<{
      credentialId: string;
      operatorId: string;
      role: OperatorRole;
      secret: string;
      description?: string;
      expiresAt?: string | null;
    }>;
    reason?: string;
  }): Promise<OperatorCredentialRecord[]> {
    const configuredKey = process.env.OPERATOR_BOOTSTRAP_KEY;
    if (!configuredKey || !configuredKey.trim()) {
      throw new OperatorAuthorizationError(
        "Bootstrap provisioning is disabled: OPERATOR_BOOTSTRAP_KEY is not configured.",
      );
    }
    if (!safeCompareStrings(configuredKey.trim(), params.bootstrapKey.trim())) {
      throw new OperatorAuthorizationError("Invalid bootstrap recovery key.");
    }

    const results: OperatorCredentialRecord[] = [];
    for (const cred of params.credentials) {
      validateSecretTokenStrength(cred.secret);
      const record: OperatorCredentialRecord = {
        credentialId: cred.credentialId.trim(),
        operatorId: cred.operatorId.trim(),
        role: cred.role,
        secretHash: hashOperatorSecret(cred.secret),
        revoked: false,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        expiresAt: cred.expiresAt ?? null,
        description: cred.description ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const validated = validateOperatorCredentialRecord(record);
      const auditEvent: OperatorCredentialAuditEvent = {
        id: `cred_audit_${randomUUID()}`,
        credentialId: validated.credentialId,
        action: "PROVISION",
        performedBy: "emergency_bootstrap",
        actorRole: "system_administrator",
        reason: params.reason ?? "Initial emergency operator bootstrap",
        previousState: null,
        newState: { ...validated },
        createdAt: new Date().toISOString(),
      };
      await this.store.saveCredential(validated, auditEvent);
      const frozen = cloneAndFreezeCredential(validated);
      this.cache.set(validated.credentialId, frozen);
      results.push(frozen);
    }
    this.revision++;
    return results;
  }

  async getAuditHistory(credentialId?: string): Promise<OperatorCredentialAuditEvent[]> {
    return this.store.getAuditEvents(credentialId);
  }

  count(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  async reset(): Promise<void> {
    this.seedCacheDefaults();
    this.loadFromEnvironment();
    this.lastSyncMs = 0;
    if (this.store.resetToDefaults) {
      await this.store.resetToDefaults();
    }
  }

  __testOnlyInjectCredential(cred: OperatorCredentialRecord): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("__testOnlyInjectCredential cannot be called in production.");
    }
    const validated = validateOperatorCredentialRecord(cred);
    this.cache.set(validated.credentialId, cloneAndFreezeCredential(validated));
  }
}

export const globalOperatorCredentialRegistry = new OperatorCredentialRegistry();

export function setGlobalOperatorCredentialStore(store: OperatorCredentialStore): void {
  globalOperatorCredentialRegistry.setStore(store);
}

export async function initOperatorCredentialRegistry(): Promise<void> {
  await globalOperatorCredentialRegistry.ensureFresh(true);
}

export async function ensureOperatorCredentialFresh(force = false): Promise<void> {
  await globalOperatorCredentialRegistry.ensureFresh(force);
}

/**
 * Authoritatively verifies operator credentials and returns a VerifiedOperator.
 * Never grants identity or role based on caller assertions.
 */
export function verifyOperatorCredentials(
  contextOrToken: unknown,
  requiredRoles?: OperatorRole | OperatorRole[],
): VerifiedOperator {
  if (!contextOrToken) {
    throw new OperatorAuthorizationError(
      "Missing operator authentication: an authorized operator credential is required.",
    );
  }

  let token: string | null = null;
  let claimedId: string | null = null;
  let claimedRole: OperatorRole | null = null;
  let callerMasterKey: string | null = null;

  if (typeof contextOrToken === "string") {
    token = contextOrToken.trim();
  } else if (typeof contextOrToken === "object" && contextOrToken !== null) {
    const c = contextOrToken as Record<string, unknown>;
    if (typeof c.operatorKey === "string" && c.operatorKey.trim()) {
      token = c.operatorKey.trim();
    } else if (typeof c.token === "string" && c.token.trim()) {
      token = c.token.trim();
    }
    if (typeof c.operatorId === "string" && c.operatorId.trim()) {
      claimedId = c.operatorId.trim();
    }
    if (typeof c.role === "string" && c.role.trim()) {
      claimedRole = c.role.trim() as OperatorRole;
    }
    if (typeof c.masterKey === "string" && c.masterKey.trim()) {
      callerMasterKey = c.masterKey.trim();
    } else if (typeof c.operatorSecretKey === "string" && c.operatorSecretKey.trim()) {
      callerMasterKey = c.operatorSecretKey.trim();
    }
  }

  const isProduction = process.env.NODE_ENV === "production";
  const configuredMasterSecret = process.env.OPERATOR_SECRET_KEY;

  if (isProduction) {
    // In production, shared master secret is an additional mandatory deployment kill switch
    if (!configuredMasterSecret || !configuredMasterSecret.trim()) {
      throw new OperatorAuthorizationError(
        "Registry mutations are disabled in production: OPERATOR_SECRET_KEY is not configured.",
      );
    }
  }

  // If caller supplied a master key, it must match configured master secret
  if (callerMasterKey) {
    if (
      !configuredMasterSecret ||
      !safeCompareStrings(configuredMasterSecret.trim(), callerMasterKey)
    ) {
      throw new OperatorAuthorizationError("Invalid master operator secret key.");
    }
  }

  if (!token) {
    throw new OperatorAuthorizationError(
      "Missing operator credentials: an explicit operatorKey token is required.",
    );
  }

  // Lookup matching credential in the server-side registry
  const cred = globalOperatorCredentialRegistry.findCredentialByToken(token);
  if (!cred) {
    throw new OperatorAuthorizationError(
      "Invalid or unknown operator credential: token does not match any registered operator.",
    );
  }

  if (cred.revoked) {
    throw new OperatorAuthorizationError(
      `Operator credential '${cred.credentialId}' for '${cred.operatorId}' has been revoked.`,
    );
  }

  if (cred.expiresAt && new Date(cred.expiresAt).getTime() < Date.now()) {
    throw new OperatorAuthorizationError(
      `Operator credential '${cred.credentialId}' for '${cred.operatorId}' expired on ${cred.expiresAt}.`,
    );
  }

  // Reject anonymous or unverified operator identity
  if (cred.operatorId === "anon" || cred.operatorId.toLowerCase().includes("unknown")) {
    throw new OperatorAuthorizationError("Anonymous or unverified operator identity rejected.");
  }

  // Caller cannot contradict verified identity or role
  if (claimedId && claimedId !== cred.operatorId) {
    throw new OperatorAuthorizationError(
      `Caller-supplied operatorId '${claimedId}' does not match verified credential identity '${cred.operatorId}'.`,
    );
  }

  if (claimedRole && claimedRole !== cred.role) {
    throw new OperatorAuthorizationError(
      `Caller-supplied role '${claimedRole}' does not match verified credential role '${cred.role}'. Role elevation prohibited.`,
    );
  }

  const verified: VerifiedOperator = {
    credentialId: cred.credentialId,
    operatorId: cred.operatorId,
    role: cred.role,
    verifiedAt: new Date().toISOString(),
  };

  if (requiredRoles) {
    const allowed = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
    if (!allowed.includes(verified.role)) {
      throw new OperatorAuthorizationError(
        `Operator role '${verified.role}' is not authorized for this action. Required role: [${allowed.join(", ")}].`,
      );
    }
  }

  return verified;
}

export async function operatorRegisterCredential(
  operatorContext: unknown,
  params: {
    credentialId: string;
    operatorId: string;
    role: OperatorRole;
    secret: string;
    description?: string;
    expiresAt?: string | null;
  },
): Promise<OperatorCredentialRecord> {
  return globalOperatorCredentialRegistry.registerCredential(operatorContext, params);
}

export async function operatorRevokeCredential(
  operatorContext: unknown,
  params: {
    credentialId: string;
    reason: string;
    revokedAt?: string;
  },
): Promise<OperatorCredentialRecord> {
  return globalOperatorCredentialRegistry.revokeCredential(operatorContext, params);
}

export async function operatorRotateCredential(
  operatorContext: unknown,
  params: {
    credentialId: string;
    newSecret: string;
    reason: string;
  },
): Promise<OperatorCredentialRecord> {
  return globalOperatorCredentialRegistry.rotateCredential(operatorContext, params);
}

export async function bootstrapOperatorCredentials(params: {
  bootstrapKey: string;
  credentials: Array<{
    credentialId: string;
    operatorId: string;
    role: OperatorRole;
    secret: string;
    description?: string;
    expiresAt?: string | null;
  }>;
  reason?: string;
}): Promise<OperatorCredentialRecord[]> {
  return globalOperatorCredentialRegistry.bootstrapCredentials(params);
}

export async function getOperatorCredentialAuditHistory(
  credentialId?: string,
): Promise<OperatorCredentialAuditEvent[]> {
  return globalOperatorCredentialRegistry.getAuditHistory(credentialId);
}

/** Test-only helper to register mock credentials during automated tests. */
export function __testOnlyRegisterOperatorCredential(param: {
  credentialId: string;
  operatorId: string;
  role: OperatorRole;
  secret: string;
  expiresAt?: string | null;
  revoked?: boolean;
}): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__testOnlyRegisterOperatorCredential cannot be called in production.");
  }
  globalOperatorCredentialRegistry.__testOnlyInjectCredential({
    credentialId: param.credentialId,
    operatorId: param.operatorId,
    role: param.role,
    secretHash: hashOperatorSecret(param.secret),
    revoked: param.revoked ?? false,
    revokedAt: param.revoked ? new Date().toISOString() : null,
    expiresAt: param.expiresAt ?? null,
  });
}
