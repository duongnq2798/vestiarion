import { utcDay } from "../copy";

/**
 * Asking a vendor for the document a bill is missing (docs/superpowers/specs/2026-10-23-document-requests-design.md): what
 * code decides, and what the cards say. Pure, and safe in client components: the cycle's stage, the vendor's page, the
 * Approvals and Bills cards and Settings all read it the same way. Nothing here pays, or changes a bill (ER7).
 */

/** How long a request's link answers (ER4). */
export const DOCUMENT_REQUEST_TTL_DAYS = 14;
/** The most requests a workspace makes, and emails, in 24 hours (ER2). */
export const DOCUMENT_REQUESTS_PER_DAY = 20;
/** How long a bill waits after a request was answered or expired before it is asked again (ER2). */
export const DOCUMENT_REQUEST_COOLDOWN_DAYS = 7;
/** How many times a request's email is tried, one cycle each (ER4). */
export const DOCUMENT_REQUEST_ATTEMPTS = 3;
/** The largest file a vendor may send (ER5). */
export const MAX_VENDOR_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_PO = 100;
export const MAX_DOCUMENT_NOTE = 500;

const DAY_MS = 86_400_000;

/** The owner's setting (ER1): off, shadow (record what would be asked, send nothing) or on. */
export const DOCUMENT_REQUESTS_SETTINGS = ["off", "shadow", "on"] as const;
export type DocumentRequestsSetting = (typeof DOCUMENT_REQUESTS_SETTINGS)[number];

/** The setting as stored; anything else, or none, reads as off. */
export function documentRequestsSettingOf(value: unknown): DocumentRequestsSetting {
  return (DOCUMENT_REQUESTS_SETTINGS as readonly unknown[]).includes(value) ? (value as DocumentRequestsSetting) : "off";
}

/** What a bill lacks for its three-way match, as a vendor can send it. */
export type MissingDocument = "purchase_order" | "goods_receipt";

/** What `missingDetails` (../added-details) names, as documents to ask for: none when nothing is missing. */
export function missingDocuments(missing: { poReference: boolean; goodsReceived: boolean } | null): MissingDocument[] {
  if (!missing) return [];
  return [...(missing.poReference ? (["purchase_order"] as const) : []), ...(missing.goodsReceived ? (["goods_receipt"] as const) : [])];
}

const WORDS: Record<MissingDocument, string> = { purchase_order: "the purchase order", goods_receipt: "the goods receipt" };

/** "the purchase order", "the goods receipt", or both. */
export function missingWords(missing: readonly MissingDocument[]): string {
  return missing.map((kind) => WORDS[kind]).join(" and ");
}

/** The kinds stored in a request's `missing`, as read back; anything else is left out. */
export function missingOf(value: unknown): MissingDocument[] {
  if (!Array.isArray(value)) return [];
  return (["purchase_order", "goods_receipt"] as const).filter((kind) => value.includes(kind));
}

export type DocumentRequestStatus = "drafted" | "open" | "answered" | "expired" | "revoked";

/** A bill's earlier request, as the stage weighs asking again. */
export interface RequestHistory {
  status: DocumentRequestStatus;
  createdAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  answeredAt: string | null;
}

export type DocumentRequestRefusal = "not_waiting" | "nothing_missing" | "no_email" | "frozen" | "high_risk" | "open_request" | "cooling_down" | "revoked";

/**
 * Whether the cycle may ask this bill's vendor now (ER2): the bill waits for information and lacks a purchase order or a
 * goods receipt; its vendor has a billing email, is not frozen and is not screened high risk; and it has no request
 * drafted or open, none answered or expired in the last 7 days, and none an owner or admin revoked, which is not made
 * again for that bill.
 */
export function documentRequestAllowed(facts: {
  status: string;
  missing: readonly MissingDocument[];
  noticeEmail: string | null;
  frozen: boolean;
  riskLevel: string;
  requests: readonly RequestHistory[];
  now: number;
}): { allowed: true } | { allowed: false; because: DocumentRequestRefusal } {
  const refuse = (because: DocumentRequestRefusal) => ({ allowed: false as const, because });
  if (facts.status !== "awaiting_info") return refuse("not_waiting");
  if (facts.missing.length === 0) return refuse("nothing_missing");
  if (!facts.noticeEmail || !emailDomainOf(facts.noticeEmail)) return refuse("no_email");
  if (facts.frozen) return refuse("frozen");
  if (facts.riskLevel === "high") return refuse("high_risk");
  const since = facts.now - DOCUMENT_REQUEST_COOLDOWN_DAYS * DAY_MS;
  const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
  for (const request of facts.requests) {
    if (request.status === "revoked") return refuse("revoked");
    if (request.status === "drafted") return refuse("open_request");
    if (request.status === "open" && at(request.expiresAt) > facts.now) return refuse("open_request");
  }
  const recent = facts.requests.some(
    (request) =>
      (request.status === "answered" && at(request.answeredAt) > since) ||
      ((request.status === "expired" || request.status === "open") && at(request.expiresAt) > since)
  );
  return recent ? refuse("cooling_down") : { allowed: true };
}

/**
 * A billing email's domain, the only part of the address the ledger and the request keep (ER3, ER4): in lower case, an
 * address in another script in its ASCII form. Null for anything that is not one address.
 */
export function emailDomainOf(email: string): string | null {
  const parts = email.trim().split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let host: string;
  try {
    host = new URL(`http://${parts[1]}`).hostname;
  } catch {
    return null;
  }
  return host.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export type VendorDocumentType = "application/pdf" | "image/png" | "image/jpeg";

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

/** What a file is by its first bytes, never its name or the type the browser claimed (ER5): a PDF, a PNG or a JPEG, or null. */
export function sniffDocumentType(bytes: Uint8Array): VendorDocumentType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

/** A file's kind in a word, for the card and the members' email. */
export function documentKindWord(type: string | null | undefined): string {
  return type === "application/pdf" ? "PDF" : type === "image/png" ? "PNG image" : type === "image/jpeg" ? "JPEG image" : "file";
}

/** What the vendor's page says of an expired, answered, revoked or unknown link: one sentence, naming no one (ER5). */
export const DOCUMENT_LINK_INVALID = "This link is no longer valid. If the business still needs a document, ask them for a new link.";

export const DOCUMENT_FIELD_MESSAGES = {
  poReference: `A purchase order number has at most ${MAX_DOCUMENT_PO} characters, on one line.`,
  note: `A note has at most ${MAX_DOCUMENT_NOTE} characters.`,
} as const;

/** What the vendor typed beside the file (ER5): a purchase order number and a note, both optional, trimmed, within limits. */
export function readDocumentFields(input: { poReference: string; note: string }):
  | { ok: true; poReference: string | null; note: string | null }
  | { ok: false; field: "poReference" | "note"; message: string } {
  const po = input.poReference.trim();
  if (po.length > MAX_DOCUMENT_PO || /\p{Cc}/u.test(po)) return { ok: false, field: "poReference", message: DOCUMENT_FIELD_MESSAGES.poReference };
  const note = input.note.replace(/\r\n?/g, "\n").trim();
  if (note.length > MAX_DOCUMENT_NOTE || /\p{Cc}/u.test(note.replaceAll("\n", ""))) return { ok: false, field: "note", message: DOCUMENT_FIELD_MESSAGES.note };
  return { ok: true, poReference: po || null, note: note || null };
}

/** A bill's latest request, as its card on Approvals and Bills shows it (ER3, ER4, ER6). */
export type DocumentRequestView =
  | { state: "would_ask"; missing: MissingDocument[] }
  | { state: "asked"; id?: string; missing: MissingDocument[]; sentAt: string; expiresAt: string }
  | {
      state: "answered";
      id?: string;
      missing: MissingDocument[];
      answeredAt: string;
      poReference?: string | null;
      note?: string | null;
      fileType?: string | null;
      fileSize?: number | null;
    }
  | { state: "expired"; missing: MissingDocument[]; sentAt: string; expiresAt: string };

/** Where a member opens a request's document, from its bill's card (ER6): src/app/api/document-requests/[id]/file. */
export function documentFileHref(orgSlug: string, requestId: string): string {
  return `/api/document-requests/${encodeURIComponent(requestId)}/file?org=${encodeURIComponent(orgSlug)}`;
}

/** "Oct 23": the day in UTC, without its year, built as `utcDay` is so a server render and hydration agree. */
export function shortDay(iso: string): string {
  return utcDay(iso).split(",")[0];
}

/** What a bill's card says of its request (ER3, ER4, ER6). */
export function documentRequestLine(view: DocumentRequestView, vendorName: string): string {
  const what = missingWords(view.missing);
  switch (view.state) {
    case "would_ask":
      return `Vestiarion would ask ${vendorName} for ${what}. Turn on vendor requests in Settings to send it.`;
    case "asked":
      return `Asked ${vendorName} for ${what} on ${shortDay(view.sentAt)}; the link expires ${shortDay(view.expiresAt)}.`;
    case "answered":
      return `${vendorName} sent a document on ${shortDay(view.answeredAt)}.`;
    case "expired":
      return `Asked ${vendorName} for ${what} on ${shortDay(view.sentAt)}; the link expired ${shortDay(view.expiresAt)} with no answer.`;
  }
}
