import { parseRetryAfter } from "../connectors/backoff";

/**
 * Google over HTTP for Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS12): the
 * five addresses, named here once. Every request goes to one of their hosts and nowhere else, over https, follows no
 * redirect, stores nothing and has a timeout. A refusal becomes a `GoogleError` from Google's short reason code, never
 * from its message, so no payee's name, email or token reaches a log.
 */

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const SHEETS_API = "https://sheets.googleapis.com/v4";

/** The hosts a request may go to: the token, revoke, Drive and Sheets addresses'. The authorize page is the browser's. */
const HOSTS: ReadonlySet<string> = new Set([GOOGLE_TOKEN, GOOGLE_REVOKE, DRIVE_API, SHEETS_API].map((address) => new URL(address).hostname));

export interface GoogleHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How a call to Google did not go: `rate_limited` with the wait Google asked for; `unauthorized` an access token it no
 * longer takes; `reconnect` a grant without the Drive permission; `forbidden` an account or administrator that refused;
 * `drive_full` a Drive with no space; `gone` a file deleted or out of this grant's reach; `unavailable` a 5xx, a timeout
 * or no answer; `bad_response` anything else, or an answer that does not read.
 */
export type GoogleFailure = "rate_limited" | "unauthorized" | "reconnect" | "forbidden" | "drive_full" | "gone" | "unavailable" | "bad_response";

export class GoogleError extends Error {
  constructor(
    readonly failure: GoogleFailure,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

const TIMEOUT_MS = 20_000;
/** A rate limit that names no wait waits this long. */
const DEFAULT_RATE_WAIT_MS = 30_000;

export async function googleFetch(url: string, init: RequestInit, label: string, deps: GoogleHttp = {}): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new GoogleError("bad_response", `Google ${label}: not an address`);
  }
  if (target.protocol !== "https:" || !HOSTS.has(target.hostname)) throw new GoogleError("bad_response", `Google ${label}: not Google's address`);
  try {
    return await (deps.fetchImpl ?? fetch)(target.toString(), { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleError("unavailable", `Google ${label}: no answer`);
  }
}

/** The most of a refusal's body read for its reason code. */
const REASON_BODY_BYTES = 8_000;
const REASON = /^[A-Za-z_]{1,64}$/;

/** The first `bytes` of a body as text, the rest never read. */
async function startOf(response: Response, bytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all.subarray(0, bytes));
}

/**
 * Google's short reason codes for a refusal, never its message: Drive's `error.errors[].reason`, the Sheets API's
 * `error.details[].reason` and `error.status`, each kept only when it is a code.
 */
async function reasonsOf(response: Response): Promise<string[]> {
  let body: unknown;
  try {
    body = JSON.parse(await startOf(response, REASON_BODY_BYTES));
  } catch {
    return [];
  }
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== "object" || error === null) return [];
  const { errors, details, status } = error as { errors?: unknown; details?: unknown; status?: unknown };
  const listed = (value: unknown) => (Array.isArray(value) ? value.map((item) => (typeof item === "object" && item !== null ? (item as { reason?: unknown }).reason : undefined)) : []);
  return [...listed(errors), ...listed(details), status].filter((reason): reason is string => typeof reason === "string" && REASON.test(reason));
}

const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED"]);
const NO_DRIVE_PERMISSION = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

/**
 * A refused call, by its status and Google's reason code (GS12). `onFile`: the call names one file, so a 404, or a 403
 * `insufficientFilePermissions` (a grant made again may not reach the files of the one before it), is that file `gone`.
 * Reads the body, so it is called once, in place of cancelling it. Logs the call, the status and the reason code.
 */
export async function googleFailure(response: Response, label: string, nowMs: number, onFile = false): Promise<GoogleError> {
  const status = response.status;
  const reasons = await reasonsOf(response);
  const reason = reasons[0] ?? null;
  const said = `Google ${label}: ${status}${reason ? ` ${reason}` : ""}`;
  console.error(`google sheets: ${label} answered ${status}${reason ? ` ${reason}` : ""}`);
  const has = (codes: ReadonlySet<string> | string) => reasons.some((one) => (typeof codes === "string" ? one === codes : codes.has(one)));
  if (status === 429 || has(RATE_LIMITED)) return new GoogleError("rate_limited", said, parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? DEFAULT_RATE_WAIT_MS);
  if (status === 401) return new GoogleError("unauthorized", said);
  if (status === 403 && has("storageQuotaExceeded")) return new GoogleError("drive_full", said);
  if (status === 403 && has(NO_DRIVE_PERMISSION)) return new GoogleError("reconnect", said);
  if (onFile && (status === 404 || (status === 403 && has("insufficientFilePermissions")))) return new GoogleError("gone", said);
  if (status === 403) return new GoogleError("forbidden", said);
  if (status >= 500) return new GoogleError("unavailable", said);
  return new GoogleError("bad_response", said);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GoogleError("bad_response", `Google ${label}: an answer that is not JSON`);
  }
}

/** A form for the token endpoint: the client id and secret in the body, never in the URL. */
export function oauthForm(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** A call to the Drive or Sheets API with a bearer token, and a JSON body when there is one. */
export function apiInit(accessToken: string, method: "GET" | "POST" | "PATCH", body?: unknown): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** The longest wait a rate limit is waited out inside a call, before it is tried once more (GS12). */
export const WAIT_IN_CALL_MS = 10_000;

/**
 * One call with at most one retry (GS12): a rate limit asking for 10 seconds or less is waited out and the call sent
 * again; a 5xx or no answer sends it again only when `repeatable` (a read, or the values write, which is idempotent),
 * never for a create, a rename or a format: the next export finds the file by its tag instead. A 401 is the caller's,
 * which refreshes the token once. Answers the response when it is ok, else throws its `GoogleError`.
 */
export async function googleCall(
  input: { url: string; init: RequestInit; label: string; repeatable: boolean; onFile?: boolean },
  deps: GoogleHttp = {}
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    let failure: GoogleError;
    try {
      const response = await googleFetch(input.url, input.init, input.label, deps);
      if (response.ok) return response;
      failure = await googleFailure(response, input.label, now(), input.onFile === true);
    } catch (error) {
      if (!(error instanceof GoogleError)) throw error;
      failure = error;
    }
    if (attempt > 0) throw failure;
    if (failure.failure === "rate_limited" && failure.retryAfterMs !== null && failure.retryAfterMs <= WAIT_IN_CALL_MS) {
      await sleep(failure.retryAfterMs);
      continue;
    }
    if (failure.failure === "unavailable" && input.repeatable) continue;
    throw failure;
  }
}
