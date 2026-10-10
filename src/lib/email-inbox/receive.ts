import { orgHref } from "../auth/org-paths";
import { db, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { chatDraftOf } from "../invoice-document/chat-draft";
import { readInvoiceDraft, type InvoiceDraftRead } from "../invoice-document/draft";
import { DocumentReadError, MAX_DOCUMENT_BYTES, type DocumentInput, type DocumentReadErrorCode } from "../invoice-document/read";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { maskEmail } from "../payment-notices";
import { takeDocumentReadToken } from "../rate-limit";
import { postToWebhook } from "../slack/api";
import { mrkdwn } from "../slack/blocks";
import { workspaceOf } from "../slack/commands";
import { installFor, webhookUrlOf } from "../slack/installs";
import { inboxOfCode, type InvoiceInbox } from "./inboxes";
import type { ShownRead } from "./list";
import { downloadAttachment, fetchReceivedEmail, type ReceivedAttachment, type ReceivedEmail } from "./resend";
import { codeOfAddress, type InboxSettings } from "./settings";
import { svixRequestOf, verifySvix } from "./verify";

/**
 * An email at a workspace's address (email invoices design E3–E6, E9, E10). The webhook is believed only with
 * Resend's Svix signature, checked before anything is read. The email is stored at once, one row per Resend email and
 * workspace, so a redelivery stores nothing new, and the route answers 200; the reading runs after the response
 * (`defer`): the email and its first invoice file from Resend, read the way From a document reads one, held to the
 * draft rule every chat shares. The row ends `ready`, `needs_details` or `unreadable`, with the reasons a person reads:
 * nothing is lost silently, and nothing is added by itself. The workspace's Slack channel is told.
 */

export interface InboundDeps {
  settings: InboxSettings;
  /** The deployment's origin, for the link in Slack. */
  origin: string;
  fetchImpl?: typeof fetch;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  now?: () => Date;
}

type Status = "ready" | "needs_details" | "unreadable";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READABLE_TYPES = ["application/pdf", "message/rfc822", "text/plain"];

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The address in `Name <address>`, or the string itself, lowercased. */
function bareAddress(from: string): string {
  return (/<([^<>]+)>\s*$/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

const readable = (attachment: ReceivedAttachment) =>
  /\.(pdf|eml|txt)$/i.test(attachment.filename) || READABLE_TYPES.includes(attachment.contentType.toLowerCase());

/** A picture attached to the email, not shown in its body: a photo or a scan of an invoice, which is not read. */
const attachedImage = (attachment: ReceivedAttachment) =>
  !attachment.inline && (attachment.contentType.toLowerCase().startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp)$/i.test(attachment.filename));

const UNREACHABLE = "Resend did not give Vestiarion this email. Forward it again in a moment.";
const NOT_FETCHED = "Its attachment could not be fetched from Resend. Forward it again in a moment.";
const NOTHING_TO_READ = "Attach the invoice as a PDF, an .eml or a .txt file, or put its text in the email.";
const TOO_LARGE = "Its attachment is larger than 4 MB. Add the invoice in Vestiarion instead.";
const SLOW_DOWN = "Five invoices are read a minute, and this one came in over that. Forward it again in a minute.";
const UNREADABLE = "The invoice could not be read. Forward it again in a moment.";
const IMAGE = (filename: string) =>
  `Its invoice is attached as an image (${filename.slice(0, 80) || "a picture"}), which Vestiarion cannot read yet. Ask the sender for the PDF, or type it in with Finish and add.`;

/** Why a document could not be read, in the words that fit an email: the inbox has no text box to paste into (F4). */
const READ_REFUSALS: Partial<Record<DocumentReadErrorCode, string>> = {
  scan: "Its PDF has no text to read; it may be a scan. Ask the sender for the invoice as a PDF with text, or type it in with Finish and add.",
  unsupported: "Its PDF could not be read. Ask the sender to send it again, or type it in with Finish and add.",
  empty: NOTHING_TO_READ,
  too_large: TOO_LARGE,
};

type Chosen = { ok: true; input: DocumentInput } | { ok: false; reason: string };

/** What to read: the email's first invoice file, fetched from Resend; else its text; else why there is nothing. */
async function documentOf(email: ReceivedEmail, orgId: string, deps: InboundDeps): Promise<Chosen> {
  const attachment = email.attachments.find(readable);
  if (attachment) {
    if (attachment.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: TOO_LARGE };
    const fetched = await downloadAttachment(deps.settings.apiKey, email.id, attachment.id, MAX_DOCUMENT_BYTES, deps.fetchImpl);
    if (!fetched.ok && fetched.reason === "too_large") return { ok: false, reason: TOO_LARGE };
    if (!fetched.ok) {
      // The person is told to forward it again; why it failed is for whoever runs the deployment.
      console.error("email inbox: attachment not fetched", orgId, fetched.reason);
      return { ok: false, reason: NOT_FETCHED };
    }
    return { ok: true, input: { bytes: fetched.bytes, name: attachment.filename, type: attachment.contentType || fetched.contentType } };
  }
  if (email.text.trim()) return { ok: true, input: { text: email.text } };
  const image = email.attachments.find(attachedImage);
  return { ok: false, reason: image ? IMAGE(image.filename) : NOTHING_TO_READ };
}

/** Whether the sender is the billing email the matched counterparty has on file: information, never authority (E6). */
async function knownSender(counterpartyId: string | null, from: string): Promise<boolean> {
  if (!counterpartyId || !from) return false;
  const row = await db().from("counterparties").select("notice_email").eq("id", counterpartyId).maybeSingle<{ notice_email: string | null }>();
  return !row.error && !!row.data?.notice_email && row.data.notice_email.trim().toLowerCase() === from;
}

/** What the inbox shows of a read: the fields, what to check, and whether the sender is known. */
function shown(read: InvoiceDraftRead, known: boolean): ShownRead {
  const { draft } = read;
  return {
    counterpartyName: read.counterpartyName,
    vendorName: draft.vendorName,
    amount: draft.amount,
    currency: draft.currency,
    dueDate: draft.dueDate,
    poReference: draft.poReference,
    invoiceNumber: draft.invoiceNumber,
    memo: draft.memo,
    warnings: read.warnings,
    modelNote: read.modelNote,
    reader: read.reader,
    knownSender: known,
    counterpartyId: draft.counterpartyId,
    earlyPayDiscountPct: draft.earlyPayDiscountPct,
    discountDeadline: draft.discountDeadline,
    document: { kind: read.document.kind, sha256: read.document.sha256 },
  };
}

/** The channel's message about an email that arrived: what it holds, and the link to decide it (E9). */
function slackMessage(status: Status, from: string, read: InvoiceDraftRead | null, reasons: string[], url: string) {
  const who = read?.counterpartyName ?? read?.draft.vendorName ?? from;
  // Slack mrkdwn: `&amp;` shows as &.
  const line =
    status === "ready" && read
      ? `New invoice by email from *${mrkdwn(who)}*: ${mrkdwn(`${read.draft.amount ?? "?"} ${read.draft.currency ?? "USDC"}`)}, due ${mrkdwn(read.draft.dueDate ?? "?")}. A person adds it in Bills &amp; receivables; nothing is paid until then.`
      : status === "needs_details"
        ? `New invoice by email from *${mrkdwn(who)}*, but it cannot be added as it was read: ${mrkdwn(reasons[0] ?? "a field is missing")}. Finish it in Bills &amp; receivables.`
        : `An email arrived at the invoice address from ${mrkdwn(from)}, but it could not be read: ${mrkdwn(reasons[0] ?? UNREADABLE)}`;
  return {
    text: line,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: line } },
      { type: "actions", elements: [{ type: "button", action_id: "vx_open", text: { type: "plain_text", text: "Review in Bills & receivables", emoji: false }, url }] },
    ],
  };
}

/** Reads one stored email; runs inside its workspace's scope, after the response. */
async function readInboxEmail(inbox: InvoiceInbox, rowId: string, emailId: string, deps: InboundDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let status: Status = "unreadable";
  let reasons: string[] = [];
  let read: InvoiceDraftRead | null = null;
  let draft: unknown = null;
  let shownRead: unknown = null;
  let from = "";

  const email = await fetchReceivedEmail(deps.settings.apiKey, emailId, deps.fetchImpl);
  if (!email) {
    reasons = [UNREACHABLE];
  } else {
    from = bareAddress(email.from);
    const chosen = await documentOf(email, inbox.orgId, deps);
    if (!chosen.ok) {
      reasons = [chosen.reason];
    } else if (!takeDocumentReadToken(inbox.orgId)) {
      reasons = [SLOW_DOWN];
    } else {
      try {
        read = await readInvoiceDraft(chosen.input, now.toISOString().slice(0, 10));
        const verdict = chatDraftOf(read);
        status = verdict.stored ? "ready" : "needs_details";
        reasons = verdict.reasons;
        draft = verdict.stored;
        shownRead = shown(read, await knownSender(read.draft.counterpartyId, from));
        // The email's own words were read because nothing attached could be: when they do not hold the invoice and a
        // picture is attached, the picture is why, and is said first.
        const image = "text" in chosen.input ? email.attachments.find(attachedImage) : undefined;
        if (status !== "ready" && image) reasons = [IMAGE(image.filename), ...reasons];
      } catch (error) {
        reasons = [error instanceof DocumentReadError ? (READ_REFUSALS[error.code] ?? error.message) : UNREADABLE];
        if (!(error instanceof DocumentReadError)) {
          console.error("email inbox: invoice read failed", inbox.orgId, error instanceof Error ? error.message : "unknown error");
        }
      }
    }
  }

  unwrap(
    await db()
      .from("inbox_emails")
      .update({ status, reasons, read: shownRead, draft, authentication: email?.authentication ?? null })
      .eq("id", rowId)
      .select("id")
  );
  await appendLedgerEntryBestEffort(inbox.orgId, {
    actor: "system",
    domain: "ap",
    action: "invoice_email_received",
    summary:
      status === "ready"
        ? "An invoice arrived by email, read into a draft for a person to add"
        : status === "needs_details"
          ? "An invoice arrived by email; it cannot be added as it was read"
          : "An email arrived at the invoice address; it could not be read",
    detail: {
      inboxEmailId: rowId,
      from: from ? maskEmail(from) : null,
      authentication: email?.authentication ?? null,
      read: status,
      document: read ? { kind: read.document.kind, sha256: read.document.sha256 } : null,
    },
  });

  // Best effort: the email is decided in Bills & receivables whether or not the channel hears of it.
  try {
    const install = await installFor(inbox.orgId);
    if (install) {
      const workspace = await workspaceOf(inbox.orgId);
      const url = `${deps.origin}${orgHref(workspace.slug, "/invoices")}#email-inbox`;
      await postToWebhook(webhookUrlOf(install), slackMessage(status, from || "an unknown sender", read, reasons, url), deps.fetchImpl);
    }
  } catch (error) {
    console.error("email inbox: Slack not told", inbox.orgId, error instanceof Error ? error.message : "unknown error");
  }
}

export async function handleInbound(request: Request, deps: InboundDeps): Promise<Response> {
  const body = await request.text();
  if (!verifySvix(svixRequestOf(request, body), deps.settings.webhookSecret, deps.now?.().getTime())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(body));
  } catch {
    payload = null;
  }
  if (!payload) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (payload.type !== "email.received") return Response.json({ ok: true });

  const data = record(payload.data);
  const emailId = text(data?.email_id);
  if (!ID.test(emailId)) return Response.json({ error: "invalid_request" }, { status: 400 });

  // The workspace is the first recipient at the inbound domain whose code is an inbox's.
  let inbox: InvoiceInbox | null = null;
  for (const recipient of [...strings(data?.to), ...strings(data?.cc), ...strings(data?.received_for)]) {
    const code = codeOfAddress(recipient, deps.settings.domain);
    inbox = code ? await inboxOfCode(code) : null;
    if (inbox) break;
  }
  if (!inbox) return Response.json({ ok: true });

  const found = inbox;
  const rowId = await withOrg(found.orgId, async () => {
    const rows = unwrap(
      await db()
        .from("inbox_emails")
        .upsert(
          {
            org_id: found.orgId,
            resend_email_id: emailId,
            from_address: text(data?.from).slice(0, 320) || null,
            subject: text(data?.subject).slice(0, 300) || null,
            status: "received",
          },
          { onConflict: "org_id,resend_email_id", ignoreDuplicates: true }
        )
        .select("id")
    ) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  });
  // A redelivery: the email is already in, and was read the first time.
  if (!rowId) return Response.json({ ok: true });

  deps.defer(async () => {
    await withOrg(found.orgId, async () => {
      try {
        await readInboxEmail(found, rowId, emailId, deps);
      } catch (error) {
        console.error("email inbox: email not read", found.orgId, error instanceof Error ? error.message : "unknown error");
        await db().from("inbox_emails").update({ status: "unreadable", reasons: [UNREADABLE] }).eq("id", rowId).eq("status", "received");
      }
    });
  });
  return Response.json({ ok: true });
}
