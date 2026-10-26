/**
 * Strictly validated business and compliance deletion reason codes.
 * Arbitrary free-form text, usernames, and provider snippets are strictly prohibited
 * from entering append-only audit ledgers through this field.
 */
export const ALLOWED_DELETION_REASON_CODES = [
  "ROUTINE_TTL_EXPIRY",
  "ROUTINE_TTL_FAILURE",
  "OPERATOR_DELETION",
  "AUTHOR_ERASURE_REQUEST",
  "USER_REQUEST",
  "GDPR_RIGHT_TO_ERASURE",
  "CCPA_DELETION_REQUEST",
  "LEGAL_COMPLIANCE_TAKEDOWN",
  "TERMS_OF_SERVICE_VIOLATION",
  "PLATFORM_DELETION_NOTICE",
  "DATA_MINIMIZATION_AUDIT",
] as const;

export type DeletionReasonCode = (typeof ALLOWED_DELETION_REASON_CODES)[number];

/**
 * Validates and normalizes audit reason codes against an allowlist of business and compliance codes.
 * Rejects arbitrary free-form text, usernames, or provider-derived snippets, falling back to a safe default.
 */
export function validateDeletionReasonCode(
  reason: string | undefined,
  defaultCode: DeletionReasonCode,
): DeletionReasonCode {
  if (!reason) return defaultCode;
  const normalized = reason.trim().toUpperCase();
  if ((ALLOWED_DELETION_REASON_CODES as readonly string[]).includes(normalized)) {
    return normalized as DeletionReasonCode;
  }
  return defaultCode;
}
