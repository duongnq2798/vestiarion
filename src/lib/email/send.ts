/**
 * Transactional email through Resend's HTTP API (no SDK). Optional: without
 * RESEND_API_KEY nothing is sent and the caller is told so, which is how
 * invitations still work before email is configured (spec §10 step 5b).
 */

import { recordUsage } from "../usage/record";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * What the email is for, when it is metered in the workspace in scope (accountant console U1): `invitation`, `digest`,
   * `reminder`, ... A send outside a workspace's scope records nothing.
   */
  meter?: string;
  /**
   * Resend's `Idempotency-Key`: the same key sent again within 24 hours is not sent twice (notifications I11). A SHA-256
   * of the event and the recipient (`src/lib/notifications/deliveries.ts`); never an address.
   */
  idempotencyKey?: string;
}

export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

/**
 * Resend refused a send because its `Idempotency-Key` went with another email within 24 hours (409
 * `invalid_idempotent_request`): an email under that key was taken already, so it must not be sent again.
 */
export const IDEMPOTENCY_KEY_USED = "idempotency_key_used";

const DEFAULT_FROM = "Vestiarion <no-reply@vestiarion.xyz>";

/**
 * How long one send may wait for Resend before it is given up as failed. The
 * cron sends its digests inside the tick, one after another, so a slow
 * Resend must not hold the tick open.
 */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * A sender on vestiarion.xyz: either a bare address, or `Name <address>` with
 * exactly one address, inside the angle brackets. Anything else (another
 * domain, a lookalike such as `vestiarion.xyz.example.com`, a second address)
 * does not match.
 */
const VESTIARION_SENDER = /^(?:[^<>]*<[^<>\s@]+@vestiarion\.xyz>|[^<>\s@]+@vestiarion\.xyz)$/i;

export function emailSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { apiKey: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const configured = env.EMAIL_FROM?.trim();
  if (!configured) return { apiKey, from: DEFAULT_FROM };
  if (!VESTIARION_SENDER.test(configured)) {
    // Never the value itself: only that it was not used.
    console.warn("EMAIL_FROM ignored: only @vestiarion.xyz addresses may send");
    return { apiKey, from: DEFAULT_FROM };
  }
  return { apiKey, from: configured };
}

export async function sendEmail(
  message: EmailMessage,
  settings: { apiKey: string; from: string } | null = emailSettingsFromEnv(),
  fetchImpl: typeof fetch = fetch
): Promise<SendResult> {
  if (!settings) return { sent: false, reason: "not_configured" };
  const result = await deliver(message, settings, fetchImpl);
  // Every attempt Resend was asked for is metered, delivered or not; nothing about the address or the words is kept.
  if (message.meter) await recordUsage({ kind: "email", action: message.meter, provider: "resend", ok: result.sent });
  return result;
}

/** The `name` of Resend's error body, when it has one. */
async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown } | null;
    return typeof body?.name === "string" ? body.name : null;
  } catch {
    return null;
  }
}

async function deliver(message: EmailMessage, settings: { apiKey: string; from: string }, fetchImpl: typeof fetch): Promise<SendResult> {
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
        ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: settings.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 409 && message.idempotencyKey && (await errorName(response)) === "invalid_idempotent_request") return { sent: false, reason: IDEMPOTENCY_KEY_USED };
      return { sent: false, reason: `status ${response.status}` };
    }
    const body = (await response.json()) as { id?: string };
    return { sent: true, id: body.id ?? "" };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { sent: false, reason: "timeout" };
    return { sent: false, reason: error instanceof Error ? error.message : "network error" };
  }
}
