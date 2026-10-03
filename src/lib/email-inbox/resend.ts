/**
 * The two calls the inbox makes to Resend's receiving API (email invoices design E5), through its HTTP API as the
 * sending side does: a received email, and one of its attachments through the expiring download link Resend gives.
 * Each has a deadline; a failure is reported, never thrown. The key goes only to Resend's API, never to the download
 * link, which is fetched only on Resend's own domains: received attachments are served from cdn.resend.app.
 */

const API = "https://api.resend.com";
export const RESEND_DEADLINE_MS = 10_000;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReceivedAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** A received email as the inbox reads it: who sent it, the text, what Resend's checks said, and the attachments. */
export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  authentication: { spf: string | null; dkim: string | null; dmarc: string | null };
  attachments: ReceivedAttachment[];
}

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const orNull = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

async function getJson(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(RESEND_DEADLINE_MS) });
    if (!response.ok) return null;
    return record(await response.json());
  } catch {
    return null;
  }
}

function decodeDataUri(value: string): string {
  const comma = value.indexOf(",");
  if (comma < 0) return "";
  const meta = value.slice(5, comma);
  const data = value.slice(comma + 1);
  try {
    return meta.endsWith(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
  } catch {
    return "";
  }
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** An email's text: its plain text when it has some, else its HTML (or a `data:` URI of it) without the markup. */
export function emailText(email: { text: string | null; html: string | null }): string {
  if (email.text?.trim()) return email.text.trim();
  if (!email.html) return "";
  const html = email.html.startsWith("data:") ? decodeDataUri(email.html) : email.html;
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return entity;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** `GET /emails/receiving/{id}`: the email, or null for an id that is not one, a refusal, or an outage. */
export async function fetchReceivedEmail(apiKey: string, emailId: string, fetchImpl: typeof fetch = fetch): Promise<ReceivedEmail | null> {
  if (!ID.test(emailId)) return null;
  const body = await getJson(`${API}/emails/receiving/${emailId}`, apiKey, fetchImpl);
  if (!body || text(body.id) !== emailId) return null;
  const auth = record(body.authentication);
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).flatMap((item) => {
    const attachment = record(item);
    const id = text(attachment?.id);
    if (!attachment || !ID.test(id)) return [];
    return [{ id, filename: text(attachment.filename), contentType: text(attachment.content_type), size: typeof attachment.size === "number" ? attachment.size : 0 }];
  });
  return {
    id: emailId,
    from: text(body.from),
    to: (Array.isArray(body.to) ? body.to : []).filter((value): value is string => typeof value === "string"),
    subject: text(body.subject),
    text: emailText({ text: orNull(body.text), html: orNull(body.html) }),
    authentication: { spf: orNull(auth?.spf), dkim: orNull(auth?.dkim), dmarc: orNull(auth?.dmarc) },
    attachments,
  };
}

export type AttachmentResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: "not_found" | "not_resend" | "too_large" | "unreachable" };

const RESEND_DOMAINS = ["resend.com", "resend.app"];

/** A download link on Resend's own domains, over https: anything else is not fetched. */
function onResend(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && RESEND_DOMAINS.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/** `GET /emails/receiving/{id}/attachments/{aid}`, then its `download_url`: at most `maxBytes`. */
export async function downloadAttachment(
  apiKey: string,
  emailId: string,
  attachmentId: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch
): Promise<AttachmentResult> {
  if (!ID.test(emailId) || !ID.test(attachmentId)) return { ok: false, reason: "not_found" };
  let meta: Record<string, unknown> | null;
  try {
    const response = await fetchImpl(`${API}/emails/receiving/${emailId}/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(RESEND_DEADLINE_MS),
    });
    if (!response.ok) return { ok: false, reason: "not_found" };
    meta = record(await response.json());
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const url = text(meta?.download_url);
  if (!meta || !url) return { ok: false, reason: "not_found" };
  if (typeof meta.size === "number" && meta.size > maxBytes) return { ok: false, reason: "too_large" };
  if (!onResend(url)) return { ok: false, reason: "not_resend" };
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(RESEND_DEADLINE_MS) });
    if (!response.ok) return { ok: false, reason: "not_found" };
    if (Number(response.headers.get("content-length") ?? "0") > maxBytes) return { ok: false, reason: "too_large" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
    const contentType = (response.headers.get("content-type") ?? text(meta.content_type)).split(";")[0].trim().toLowerCase();
    return { ok: true, bytes, contentType };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
