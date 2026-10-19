/** The wire shape of the public API: one envelope for errors, one cost header. */

/**
 * Reading this API is free. The header says so on every response, including
 * errors, because the whole point of the product is that data costs money and
 * reading what you already paid for does not.
 */
export const COST_HEADER = "X-Request-Cost-Usd";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "internal_error"
  | "source_disabled";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  internal_error: 500,
  source_disabled: 403,
};

/** An error a handler can throw from anywhere and have serialized once. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.headers = headers;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function apiJson(data: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(data, { headers: { [COST_HEADER]: "0", ...headers } });
}

export function apiErrorResponse(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers: { [COST_HEADER]: "0", ...error.headers } },
  );
}

/** Turns anything thrown by a handler into the one error envelope. */
export function toApiErrorResponse(thrown: unknown): Response {
  if (thrown instanceof ApiError) {
    return apiErrorResponse(thrown);
  }
  const message = thrown instanceof Error ? thrown.message : "Unexpected error";
  return apiErrorResponse(new ApiError("internal_error", message));
}
