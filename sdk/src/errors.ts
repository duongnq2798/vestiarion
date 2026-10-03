import type { ApiErrorCode } from "./types.js";

/** What went wrong: one of the API's own codes, or what happened before an answer arrived. */
export type VestiarionErrorCode = ApiErrorCode | "network_error" | "timeout" | "invalid_response";

/**
 * Every failed request (TypeScript SDK design R5): the HTTP status (0 when no answer arrived), a code to branch on,
 * the API's own message, and how long the API's `Retry-After` asked to wait, in seconds.
 */
export class VestiarionError extends Error {
  readonly name = "VestiarionError";

  constructor(
    readonly status: number,
    readonly code: VestiarionErrorCode,
    message: string,
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}
