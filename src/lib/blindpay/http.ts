import { BLINDPAY_API, type BlindpaySettings } from "./settings";

/**
 * BlindPay over HTTP (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B7): `Authorization: Bearer` with the
 * instance's key, an `Idempotency-Key` on every POST that moves or makes something, and BlindPay's own error shape read
 * into a `BlindpayError` that names the call, the status and BlindPay's code, never the key or a bank number.
 */

export interface BlindpayHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;

export class BlindpayError extends Error {
  constructor(
    readonly status: number,
    /** BlindPay's `code` (e.g. `QUOTES_EXPIRED`), or null when the answer did not carry one. */
    readonly code: string | null,
    message: string,
    /** A wait BlindPay asked for (429, or an idempotency key still in flight), in milliseconds. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "BlindpayError";
  }

  /** No answer, a 5xx, a rate limit or a call still in flight: worth trying again; anything else is BlindPay's no. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.code === "idempotency_key_in_flight" || this.code === "PAYOUTS_ALLOWANCE_NOT_CONFIRMED";
  }
}

const retryAfter = (response: Response): number | null => {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
};

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * One call to BlindPay, under the instance's path (`/v1/instances/<id>…`) unless `path` starts with `/v1/e/` or
 * `/v1/available/`. Returns the JSON answer, or throws `BlindpayError`.
 */
export async function blindpayCall(
  settings: Pick<BlindpaySettings, "apiKey" | "instanceId">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; idempotencyKey?: string; label: string; timeoutMs?: number },
  deps: BlindpayHttp = {}
): Promise<unknown> {
  const instancePath = path.startsWith("/v1/") ? path.replace("{instance}", settings.instanceId) : `/v1/instances/${settings.instanceId}${path}`;
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${BLINDPAY_API}${instancePath}`, {
      method,
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey.slice(0, 255) } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new BlindpayError(0, null, `BlindPay ${options.label}: no answer`);
  }
  const body = await bodyOf(response);
  if (response.ok) return body;
  const json = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof json.code === "string" ? json.code.slice(0, 80) : typeof json.message === "string" ? json.message.slice(0, 80) : null;
  throw new BlindpayError(response.status, code, `BlindPay ${options.label}: ${response.status}${code ? ` ${code}` : ""}`, retryAfter(response));
}
