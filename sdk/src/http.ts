import { VestiarionError, type VestiarionErrorCode } from "./errors.js";
import { API_ERROR_CODES, type ApiErrorCode } from "./types.js";
import { VERSION } from "./version.js";

/** The part of `fetch` the SDK uses. Pass your own to route, record or proxy its requests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
  maxRetries: number;
  timeoutMs: number;
  /** Waits that many milliseconds. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1), for the backoff's jitter. Replaced in tests. */
  random?: () => number;
  /** A fresh Idempotency-Key. Replaced in tests. */
  uuid?: () => string;
}

export interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  query?: object;
  body?: unknown;
  /** A write's key: the caller's, or a fresh one when left out. `null` sends none, for a write that keeps no outcome for one. */
  idempotencyKey?: string | null;
}

export interface Transport {
  request<T>(spec: RequestSpec): Promise<T>;
}

/** The longest `Retry-After` the SDK waits out; a longer one is thrown, so a call never blocks for minutes (R6). */
const RETRY_AFTER_CAP_S = 60;
const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRIED_STATUSES = new Set([500, 502, 503, 504]);
const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

type Outcome<T> = { value: T } | { error: VestiarionError; retryInMs: number | null };

function queryString(query: object | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function retryAfterSeconds(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
}

/** The API's own `{ error: { code, message } }`, or null for any other body. */
function apiErrorOf(text: string): { code: ApiErrorCode; message: string } | null {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof error?.code === "string" && API_CODES.has(error.code) && typeof error.message === "string") {
      return { code: error.code as ApiErrorCode, message: error.message };
    }
  } catch {
    // Not JSON: a proxy's page, or nothing.
  }
  return null;
}

/** What a status means when its body is not the API's own error. */
function codeForStatus(status: number): VestiarionErrorCode {
  const named: Record<number, VestiarionErrorCode> = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    429: "rate_limited",
    503: "unavailable",
  };
  return named[status] ?? (status >= 500 ? "internal" : "invalid_response");
}

/**
 * Sends one request to the API and reads its answer (TypeScript SDK design R4–R6): the key as a bearer token, a write's
 * body with its `Idempotency-Key`, retries after a 429, a 5xx, a timeout or a network failure, and every failure as a
 * `VestiarionError`.
 */
export function createTransport(options: TransportOptions): Transport {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  // Called as a plain function: a runtime's own fetch throws "Illegal invocation" when called on another object.
  const fetchImpl = options.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  function backoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** attempt);
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  function retryDelay(status: number, retryAfter: number | null, attempt: number, method: RequestSpec["method"]): number | null {
    const waitable = retryAfter !== null && retryAfter <= RETRY_AFTER_CAP_S;
    if (status === 429) return retryAfter === null ? backoff(attempt) : waitable ? retryAfter * 1000 : null;
    if (RETRIED_STATUSES.has(status)) return waitable ? (retryAfter as number) * 1000 : backoff(attempt);
    // The same key and body again: a conflict now means the first attempt is still being handled (R6).
    if (status === 409 && method === "POST" && attempt > 0) return backoff(attempt);
    return null;
  }

  async function attemptOnce<T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    attempt: number,
    method: RequestSpec["method"]
  ): Promise<Outcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let status: number;
      let headers: { get(name: string): string | null };
      let text: string;
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        status = response.status;
        headers = response.headers;
        text = await response.text();
      } catch {
        const error = controller.signal.aborted
          ? new VestiarionError(0, "timeout", `No answer within ${options.timeoutMs} ms.`)
          : new VestiarionError(0, "network_error", "The request did not reach the API.");
        return { error, retryInMs: backoff(attempt) };
      }
      if (status >= 200 && status < 300) {
        try {
          return { value: JSON.parse(text) as T };
        } catch {
          return { error: new VestiarionError(status, "invalid_response", "The API's answer was not JSON."), retryInMs: null };
        }
      }
      const retryAfter = retryAfterSeconds(headers.get("retry-after"));
      const own = apiErrorOf(text);
      const error = new VestiarionError(status, own?.code ?? codeForStatus(status), own?.message ?? `The API answered HTTP ${status}.`, retryAfter);
      return { error, retryInMs: retryDelay(status, retryAfter, attempt, method) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(spec: RequestSpec): Promise<T> {
    const url = `${base}${spec.path}${queryString(spec.query)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      "user-agent": `vestiarion-sdk-js/${VERSION}`,
    };
    let body: string | undefined;
    if (spec.method === "POST") {
      headers["content-type"] = "application/json";
      // Every write that keeps an outcome for a key carries one, so retrying it can never add the record twice (R6). A
      // payee link keeps none, since that would store the link: a retry makes a new link, which replaces the first.
      if (spec.idempotencyKey !== null) headers["idempotency-key"] = spec.idempotencyKey ?? uuid();
      body = JSON.stringify(spec.body ?? {});
    }
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await attemptOnce<T>(url, { method: spec.method, headers, body }, attempt, spec.method);
      if ("value" in outcome) return outcome.value;
      if (outcome.retryInMs === null || attempt >= options.maxRetries) throw outcome.error;
      await sleep(outcome.retryInMs);
    }
  }

  return { request };
}
