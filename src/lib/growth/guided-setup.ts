import crypto from "node:crypto";
import { z } from "zod";
import type { MasterKey } from "../secrets";
import type { FirstTouch } from "./attribution";
import { dedupeKey, type NewLead } from "./csv";

/**
 * The guided setup request on /studios: a studio asks the team to set up a call, and the request lands as one inbound
 * lead in the founder dashboard's approval queue (src/lib/growth/inbound.ts writes it). Pure: the fields, their checks,
 * the signed form token and the lead row, each tested on its own.
 *
 * There is no shared rate limiter to lean on (src/lib/rate-limit.ts keeps its buckets in one instance's memory), so a
 * bot is kept out by three checks that need no store: a honeypot field a person never sees, a token signed when the page
 * was drawn that must be at least `MIN_FILL_MS` old, and a cap on the whole submission's length. A bot that trips one
 * is thanked like a person and nothing is written, so it learns nothing.
 */

export const CONTRACTOR_COUNTS = [
  { value: "1-3", label: "1–3" },
  { value: "4-10", label: "4–10" },
  { value: "11-30", label: "11–30" },
  { value: "30+", label: "30+" },
] as const;

export const INVOICE_ARRIVALS = [
  { value: "email", label: "Email" },
  { value: "chat", label: "Chat (WhatsApp, Telegram, Zalo, Slack)" },
  { value: "pdf_portal", label: "PDF or a portal" },
  { value: "other", label: "Other" },
] as const;

export const MESSAGE_MAX = 500;

/** The line under the form's button, which the privacy page repeats. */
export const CONSENT = "We use these details only to set up a call with you about Vestiarion.";

/** The hidden field a person never fills: anything in it marks a bot. */
export const HONEYPOT_FIELD = "nickname";
export const TOKEN_FIELD = "form_token";

/** A person takes longer than this to fill five fields; a bot posting at once does not. */
export const MIN_FILL_MS = 3_000;
/** A token older than this is refused with a word to reload, since a person may leave a tab open for a while. */
export const TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Every field's characters together: the form's own limits come to well under this. */
export const MAX_SUBMISSION_CHARS = 4_000;

const PURPOSE = "guided-setup-form";
const TOKEN = /^vx1\.([A-Za-z0-9_-]{8,200})\.([A-Za-z0-9_-]{43})$/;

function mac(master: MasterKey, body: string): Buffer {
  const key = Buffer.from(crypto.hkdfSync("sha256", master.key, Buffer.alloc(0), `vestiarion/${PURPOSE}/v1`, 32));
  return crypto.createHmac("sha256", key).update(`${PURPOSE}.${body}`, "utf8").digest();
}

/**
 * The form's token: when the page was drawn, signed `vx1.<base64url JSON>.<base64url HMAC-SHA256>` as the GitHub and
 * Slack states are, with a key of its own derived by HKDF from the current master key.
 */
export function guidedSetupToken(keys: MasterKey[], nowMs: number = Date.now()): string {
  const current = keys[0];
  if (!current) throw new Error("no master key to sign with");
  const body = Buffer.from(JSON.stringify({ t: nowMs }), "utf8").toString("base64url");
  return `vx1.${body}.${mac(current, body).toString("base64url")}`;
}

export type TokenCheck = "ok" | "invalid" | "too_fast" | "expired";

/** Whether a token is one we signed, with any master key, and was drawn long enough ago but not too long. */
export function checkGuidedSetupToken(token: string, keys: MasterKey[], nowMs: number = Date.now()): TokenCheck {
  const match = TOKEN.exec(token);
  if (!match) return "invalid";
  const [, body, signature] = match;
  const given = Buffer.from(signature, "base64url");
  const signed = keys.some((key) => {
    const expected = mac(key, body);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  if (!signed) return "invalid";
  let issued: unknown;
  try {
    issued = (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: unknown }).t;
  } catch {
    return "invalid";
  }
  if (typeof issued !== "number" || !Number.isFinite(issued) || issued > nowMs) return "invalid";
  if (nowMs - issued < MIN_FILL_MS) return "too_fast";
  if (nowMs - issued > TOKEN_TTL_MS) return "expired";
  return "ok";
}

/** Characters a single-line answer never needs, line breaks among them: they become spaces. */
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const line = (max: number, required: string) =>
  z
    .string({ error: required })
    .transform((value) => value.replace(CONTROL, " ").trim())
    .pipe(z.string().min(1, required).max(max, `At most ${max} characters.`));

const website = z
  .string()
  .optional()
  .transform((value) => (value ?? "").trim())
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".") && value.length <= 500;
    } catch {
      return false;
    }
  }, "An address starting with http:// or https://, such as https://yourstudio.com.")
  .transform((value) => (value === "" ? null : value));

const oneOf = <T extends ReadonlyArray<{ value: string }>>(options: T, message: string) =>
  z
    .string({ error: message })
    .refine((value) => options.some((option) => option.value === value), message)
    .transform((value) => value as T[number]["value"]);

export const guidedSetupSchema = z.object({
  name: line(100, "Write your name."),
  email: z
    .string({ error: "Write your work email." })
    .trim()
    .min(1, "Write your work email.")
    .max(200, "At most 200 characters.")
    .pipe(z.email("That email address does not look right.")),
  studio: line(200, "Write your studio's name."),
  website,
  contractors: oneOf(CONTRACTOR_COUNTS, "Choose how many contractors you pay a month."),
  arrival: oneOf(INVOICE_ARRIVALS, "Choose how invoices reach you."),
  message: z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim())
    .pipe(z.string().max(MESSAGE_MAX, `At most ${MESSAGE_MAX} characters.`))
    .transform((value) => (value === "" ? null : value)),
});

export type GuidedSetupRequest = z.infer<typeof guidedSetupSchema>;
export type GuidedSetupField = keyof GuidedSetupRequest;

export const contractorsLabel = (value: GuidedSetupRequest["contractors"]) => CONTRACTOR_COUNTS.find((option) => option.value === value)?.label ?? value;
export const arrivalLabel = (value: GuidedSetupRequest["arrival"]) => INVOICE_ARRIVALS.find((option) => option.value === value)?.label ?? value;

export const INBOUND_SIGNAL = "Asked for a guided setup on /studios";

/** The first touch's tags as one line, `utm_source=x, utm_campaign=y, landing=/studios`; null without a first touch. */
export function firstTouchLine(touch: FirstTouch | null): string | null {
  if (!touch) return null;
  const parts = (["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"] as const).flatMap((key) => (touch[key] ? [`${key}=${touch[key]}`] : []));
  if (touch.landing_path) parts.push(`landing=${touch.landing_path}`);
  if (touch.referrer_host) parts.push(`referrer=${touch.referrer_host}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The request as growth_import_leads takes a lead: source inbound, from the website form, the email as the contact,
 * needing review at `discovered` (it has no evidence address, so it is not `verified`, as the CSV import rules). The
 * campaign is the first touch's utm_campaign only when `campaignExists` says it names a campaign; the first touch's
 * tags are kept in source_detail either way. The person's name and their answers go in the notes.
 */
export function inboundLead(request: GuidedSetupRequest, touch: FirstTouch | null, campaignExists: boolean, today: string): NewLead {
  const tags = firstTouchLine(touch);
  const notes = [
    `Name: ${request.name}`,
    `Contractors paid a month: ${contractorsLabel(request.contractors)}`,
    `Invoices arrive by: ${arrivalLabel(request.arrival)}`,
    ...(request.message ? [`Message: ${request.message}`] : []),
  ].join("\n");
  return {
    business_name: request.studio,
    company_url: request.website,
    sector: null,
    geography: null,
    size_estimate: null,
    size_uncertain: true,
    prospect_role: null,
    contact_channel: "website_form",
    contact_handle: request.email,
    signal: INBOUND_SIGNAL,
    evidence_url: null,
    evidence_date: today,
    inferred_pain: null,
    evidence_confidence: null,
    existing_solution: null,
    outreach_angle: null,
    draft_message: null,
    campaign_id: campaignExists && touch?.utm_campaign ? touch.utm_campaign : null,
    segment: "other",
    source: "inbound",
    source_detail: (tags ? `Guided setup form on /studios; first touch: ${tags}` : "Guided setup form on /studios").slice(0, 500),
    notes,
    dedupe_key: dedupeKey(request.studio, request.website),
    stage: "discovered",
  };
}
