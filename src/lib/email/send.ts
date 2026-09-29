/**
 * Transactional email through Resend's HTTP API (no SDK). Optional: without
 * RESEND_API_KEY nothing is sent and the caller is told so, which is how
 * invitations still work before email is configured (spec §10 step 5b).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

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
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: settings.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) return { sent: false, reason: `status ${response.status}` };
    const body = (await response.json()) as { id?: string };
    return { sent: true, id: body.id ?? "" };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { sent: false, reason: "timeout" };
    return { sent: false, reason: error instanceof Error ? error.message : "network error" };
  }
}
