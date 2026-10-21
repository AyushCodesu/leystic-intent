import { createHash, timingSafeEqual } from "node:crypto";

export type OperatorRole = "system_administrator" | "compliance_officer" | "legal_counsel";

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
  /** SHA-256 hash of the operator secret token in hex */
  secretHash: string;
  revoked: boolean;
  revokedAt?: string | null;
  expiresAt?: string | null; // ISO 8601
  description?: string;
}

export class OperatorAuthorizationError extends Error {
  constructor(message: string) {
    super(`[Operator Authorization Error] ${message}`);
    this.name = "OperatorAuthorizationError";
  }
}

export function hashOperatorSecret(secret: string): string {
  return createHash("sha256").update(secret.trim()).digest("hex");
}

function safeCompareHashes(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

const DEFAULT_TEST_CREDENTIALS: OperatorCredentialRecord[] = [
  {
    credentialId: "cred_legal_default",
    operatorId: "legal_counsel_001",
    role: "legal_counsel",
    secretHash: hashOperatorSecret("legal_secret_key_001"),
    revoked: false,
    description: "Default test fixture for legal counsel",
  },
  {
    credentialId: "cred_compliance_default",
    operatorId: "compliance_officer_001",
    role: "compliance_officer",
    secretHash: hashOperatorSecret("compliance_secret_key_001"),
    revoked: false,
    description: "Default test fixture for compliance officer",
  },
  {
    credentialId: "cred_admin_default",
    operatorId: "sysadmin_001",
    role: "system_administrator",
    secretHash: hashOperatorSecret("admin_secret_key_001"),
    revoked: false,
    description: "Default test fixture for system administrator",
  },
];

/**
 * Server-side operator credential store binding each secret credential to a
 * verified identity and explicitly allowed administrative role.
 */
export class OperatorCredentialRegistry {
  private credentials = new Map<string, OperatorCredentialRecord>();

  constructor() {
    this.loadFromEnvironment();
  }

  loadFromEnvironment(): void {
    const raw = process.env.OPERATOR_CREDENTIALS;
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (
              item &&
              typeof item.credentialId === "string" &&
              typeof item.operatorId === "string" &&
              typeof item.role === "string" &&
              typeof item.secretHash === "string"
            ) {
              this.credentials.set(item.credentialId, {
                credentialId: item.credentialId,
                operatorId: item.operatorId,
                role: item.role as OperatorRole,
                secretHash: item.secretHash,
                revoked: Boolean(item.revoked),
                revokedAt: item.revokedAt ?? null,
                expiresAt: item.expiresAt ?? null,
                description: item.description,
              });
            }
          }
        }
      } catch {
        // Malformed environment credentials fail closed
      }
    }

    if (this.credentials.size === 0 && process.env.NODE_ENV !== "production") {
      this.seedDefaultTestCredentials();
    }
  }

  seedDefaultTestCredentials(): void {
    for (const cred of DEFAULT_TEST_CREDENTIALS) {
      this.credentials.set(cred.credentialId, { ...cred });
    }
  }

  findCredentialByToken(token: string): OperatorCredentialRecord | null {
    if (!token || typeof token !== "string" || !token.trim()) {
      return null;
    }
    const tokenHash = hashOperatorSecret(token);
    for (const cred of this.credentials.values()) {
      if (safeCompareHashes(cred.secretHash, tokenHash)) {
        return cred;
      }
    }
    return null;
  }

  getCredential(credentialId: string): OperatorCredentialRecord | null {
    return this.credentials.get(credentialId) ?? null;
  }

  registerCredential(cred: OperatorCredentialRecord): void {
    this.credentials.set(cred.credentialId, { ...cred });
  }

  revokeCredential(credentialId: string, reason?: string): void {
    const existing = this.credentials.get(credentialId);
    if (!existing) {
      throw new OperatorAuthorizationError(`Credential '${credentialId}' not found.`);
    }
    existing.revoked = true;
    existing.revokedAt = new Date().toISOString();
    if (reason) {
      existing.description = `${existing.description ?? ""}; Revoked: ${reason}`;
    }
    this.credentials.set(credentialId, existing);
  }

  count(): number {
    return this.credentials.size;
  }

  clear(): void {
    this.credentials.clear();
  }

  reset(): void {
    this.clear();
    this.loadFromEnvironment();
  }
}

export const globalOperatorCredentialRegistry = new OperatorCredentialRegistry();

/**
 * Verifies operator credentials and returns an authoritative VerifiedOperator.
 * Never grants role or identity based on caller assertions.
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
  }

  const isProduction = process.env.NODE_ENV === "production";
  const configuredMasterSecret = process.env.OPERATOR_SECRET_KEY;

  if (isProduction) {
    // In production, shared master secret is an additional mandatory control
    if (!configuredMasterSecret || !configuredMasterSecret.trim()) {
      throw new OperatorAuthorizationError(
        "Registry mutations are disabled in production: OPERATOR_SECRET_KEY is not configured.",
      );
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
  globalOperatorCredentialRegistry.registerCredential({
    credentialId: param.credentialId,
    operatorId: param.operatorId,
    role: param.role,
    secretHash: hashOperatorSecret(param.secret),
    revoked: param.revoked ?? false,
    expiresAt: param.expiresAt ?? null,
  });
}
