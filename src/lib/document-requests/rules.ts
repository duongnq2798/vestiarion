import { utcDay } from "../copy";

/**
 * Asking a vendor for the document a bill is missing (docs/superpowers/specs/2026-10-23-document-requests-design.md): what
 * code decides, and what the cards say. Pure, and safe in client components: the cycle's stage, the vendor's page, the
 * Approvals and Bills cards and Settings all read it the same way. Nothing here pays, or changes a bill. What the
 * cycle's check found in a document (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK13) is
 * said here too: only the cycle's document_checks stage adds a purchase order, and a person approves the payment.
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
/**
 * The largest PDF a member attaches, as the cycle reads one (document checks DK3, DK11): invoice-document/read's
 * MAX_DOCUMENT_BYTES, said here so the client's dialog refuses a larger one before it is sent.
 */
export const MAX_ATTACHED_DOCUMENT_BYTES = 4_000_000;
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
  poReference: `A purchase order number is plain text on one line, of at most ${MAX_DOCUMENT_PO} characters, with no link.`,
  note: `A note has at most ${MAX_DOCUMENT_NOTE} characters.`,
} as const;

/**
 * A purchase order number's own refusals, as a payee lock's record has them: a control or format character (U+202E
 * reverses how the text after it reads, a zero-width one hides), a line or paragraph separator (U+2028, U+2029), which
 * breaks its one line and which 0142's answer_document_request refuses as a control character, and a link, which a
 * purchase order never needs and a member might open from the card or Add details.
 */
const PO_UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LINK = /:\/\/|www\./i;
/** A line break as a vendor's text may carry one: CR LF, a lone CR, or a line or paragraph separator. */
const LINE_BREAK = /\r\n?|[\p{Zl}\p{Zp}]/gu;

/**
 * What the vendor typed beside the file (ER5): a purchase order number and a note, both optional, trimmed, within limits.
 * A note's line breaks are read as `\n`, the only control character answer_document_request lets through.
 */
export function readDocumentFields(input: { poReference: string; note: string }):
  | { ok: true; poReference: string | null; note: string | null }
  | { ok: false; field: "poReference" | "note"; message: string } {
  const po = input.poReference.trim();
  if (po.length > MAX_DOCUMENT_PO || PO_UNSEEN.test(po) || LINK.test(po)) return { ok: false, field: "poReference", message: DOCUMENT_FIELD_MESSAGES.poReference };
  const note = input.note.replace(LINE_BREAK, "\n").trim();
  if (note.length > MAX_DOCUMENT_NOTE || /\p{Cc}/u.test(note.replaceAll("\n", ""))) return { ok: false, field: "note", message: DOCUMENT_FIELD_MESSAGES.note };
  return { ok: true, poReference: po || null, note: note || null };
}

/** Who sent a document: its vendor, through the request's link, or a member, who attached it (document checks DK11). */
export type DocumentSource = "vendor" | "member";

/**
 * What the cycle's check found in a document, as its bill's card says it (document checks DK13): waiting for the next
 * cycle; a match, with the purchase order compared (null when none was), whether the check added it, and whether it was
 * checked in shadow while the bill lacked it; or a mismatch, a file it could not read, or a skip, with the sentence 0144
 * kept, which carries only Vestiarion's own words, the counterparty's name, a purchase order, figures and 0x hex.
 */
export type DocumentCheckView =
  | { outcome: "pending" }
  | { outcome: "matched"; po: string | null; added: boolean; shadowLeftPo: boolean }
  | { outcome: "mismatched" | "unreadable" | "skipped"; reason: string };

/** A request the vendor answered, or a document a member attached: what was sent, as a bill's card shows it (ER6). */
export interface DocumentReceivedView {
  state: "answered";
  id?: string;
  missing: MissingDocument[];
  answeredAt: string;
  poReference?: string | null;
  note?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  /** The vendor when absent, as every request before migration 0144. */
  source?: DocumentSource;
  /** What the check found; absent before migration 0144, and for a document not checked while vendor requests are off. */
  check?: DocumentCheckView;
}

/**
 * A bill's latest request, as its card on Approvals and Bills shows it (ER3, ER4, ER6). A newer request than the one a
 * vendor answered carries that answer as `received`, so its file and purchase order stay on the card.
 */
export type DocumentRequestView =
  | { state: "would_ask"; missing: MissingDocument[]; received?: DocumentReceivedView }
  | { state: "asked"; id?: string; missing: MissingDocument[]; sentAt: string; expiresAt: string; received?: DocumentReceivedView }
  | DocumentReceivedView
  | { state: "expired"; missing: MissingDocument[]; sentAt: string; expiresAt: string; received?: DocumentReceivedView };

/** What the vendor sent with the bill's latest answered request, if any: the request itself, or an earlier one. */
export function documentReceivedOf(view: DocumentRequestView): DocumentReceivedView | null {
  return view.state === "answered" ? view : (view.received ?? null);
}

/** The purchase order number the vendor typed with what it sent, filled into Add details (ER6); null with none. */
export function suggestedPoOf(view: DocumentRequestView | undefined): string | null {
  return (view ? documentReceivedOf(view)?.poReference : null) ?? null;
}

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
      return view.source === "member" ? `A member attached ${vendorName}'s document on ${shortDay(view.answeredAt)}.` : `${vendorName} sent a document on ${shortDay(view.answeredAt)}.`;
    case "expired":
      return `Asked ${vendorName} for ${what} on ${shortDay(view.sentAt)}; the link expired ${shortDay(view.expiresAt)} with no answer.`;
  }
}

/** What the matched lines say first: the purchase order compared, or none. */
const matchedLead = (po: string | null) => (po ? `Vendor, amount and purchase order ${po} match the bill.` : "Vendor and amount match the bill.");
/** What a match says while the bill's goods are not marked received: the check never marks them (DK6). */
const GOODS_TO_MARK = " Only your team can mark the goods received: do it in Add details once you have them.";

/**
 * The card's one line on what the check found (DK13), under the document's headline. The matched lines follow the bill as
 * it is now (`goodsReceived`): only a person marks its goods received, and a person approves a bill whose purchase order
 * the check added (DK6, DK8).
 */
export function documentCheckLine(check: DocumentCheckView, vendorName: string, goodsReceived: boolean): string {
  switch (check.outcome) {
    case "pending":
      return "Vestiarion checks it against the bill at its next cycle, usually within a minute.";
    case "matched":
      if (check.added) {
        return goodsReceived
          ? `${matchedLead(check.po)} Vestiarion added the purchase order and checked the bill again. A person approves the payment: the agent does not pay it on its own.`
          : `${matchedLead(check.po)} Vestiarion added the purchase order. Only your team can mark the goods received: do it in Add details once you have them, and a person then approves the payment.`;
      }
      if (check.shadowLeftPo) return `${matchedLead(check.po)} Vendor requests are in shadow, so the bill was left as it is: add the purchase order yourself.`;
      return `${matchedLead(check.po)}${goodsReceived ? "" : GOODS_TO_MARK}`;
    case "mismatched":
      return `${check.reason} The bill still waits: check it with ${vendorName}, or add the details yourself.`;
    case "unreadable":
      return `Vestiarion could not check it. ${check.reason} Open it, and add the details yourself.`;
    case "skipped":
      return check.reason;
  }
}
