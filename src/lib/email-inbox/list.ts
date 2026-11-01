import { db, unwrap } from "../dal";

/**
 * The invoices still to decide on Bills & receivables (email invoices design E7): newest first, what was read and why it
 * cannot be added when it cannot. Never the stored draft: the page shows what was read, and the command adds what was
 * stored. An emailed invoice and a file from the workspace's Google Drive folder wait in the same list
 * (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD8): a Drive row names its file, and who last changed
 * it in Drive, their email masked when it was read (kept in `from_address`), as information, never authority. Runs
 * inside the workspace's scope.
 */

/** What the inbox shows of a read: the fields, what to check, and whether the sender is the counterparty's known one. */
export interface ShownRead {
  counterpartyName: string | null;
  vendorName: string | null;
  amount: string | null;
  currency: string | null;
  dueDate: string | null;
  poReference: string | null;
  invoiceNumber: string | null;
  memo: string | null;
  warnings: string[];
  modelNote: string | null;
  reader: string;
  knownSender: boolean;
  /**
   * What the form that finishes it starts from, and the document its entry names (reader follow-up F5, F6). Absent on
   * emails read before 2026-10-04.
   */
  counterpartyId?: string | null;
  earlyPayDiscountPct?: string | null;
  discountDeadline?: string | null;
  /** A late fee as read (late fees LF2), when it named one. */
  lateFeeKind?: string;
  lateFeeValue?: string;
  lateFeeStartsOn?: string | null;
  document?: { kind: "pdf" | "email" | "text"; sha256: string };
  /** The 0x address the document asked to be paid to (invoice pay-to hold IP1); absent when it named none. */
  payTo?: string;
}

export type InboxStatus = "received" | "ready" | "needs_details" | "unreadable";

/** What brought a document to the review list (0148): an email to the invoice address, or a file in the Drive folder. */
export type InboxSource = "email" | "google_drive";

export interface InboxEmailView {
  id: string;
  source: InboxSource;
  /** An email's sender; null for a file from Google Drive. */
  from: string | null;
  /** An email's subject; null for a file from Google Drive. */
  subject: string | null;
  /** When it arrived, or when the file was found in the folder. */
  receivedAt: string;
  status: InboxStatus;
  reasons: string[];
  read: ShownRead | null;
  /** The sender's checks; null for a file from Google Drive, which has no sender. */
  authentication: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  /** A file from Google Drive's name; null for an email. */
  fileName: string | null;
  /** Who last changed the file in Drive, their email masked ("du***@gmail.com"); null for an email, or when Drive did not say. */
  lastModifiedBy: string | null;
}

const STILL_TO_DECIDE: InboxStatus[] = ["received", "ready", "needs_details", "unreadable"];

/**
 * Whether a read failed only for a column migration 0148 adds (Google Drive intake GD3), not there until it runs: then
 * every row is an email, read without them, so the emails go on showing and being decided in the meantime.
 */
export function before0148(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

interface Row {
  id: string;
  source: InboxSource | null;
  file_name: string | null;
  from_address: string | null;
  subject: string | null;
  received_at: string;
  status: InboxStatus;
  reasons: string[] | null;
  read: ShownRead | null;
  authentication: InboxEmailView["authentication"];
}

export async function inboxEmailsToDecide(limit = 50): Promise<InboxEmailView[]> {
  const read = (columns: string) =>
    db()
      .from("inbox_emails")
      .select(`id, ${columns}from_address, subject, received_at, status, reasons, read, authentication`)
      .in("status", STILL_TO_DECIDE)
      .order("received_at", { ascending: false })
      .limit(limit);
  const first = await read("source, file_name, ");
  const rows = unwrap(before0148(first.error) ? await read("") : first) as unknown as Row[];
  return rows.map((row) => {
    const drive = row.source === "google_drive";
    return {
      id: row.id,
      source: drive ? "google_drive" : "email",
      from: drive ? null : row.from_address,
      subject: drive ? null : row.subject,
      receivedAt: row.received_at,
      status: row.status,
      reasons: row.reasons ?? [],
      read: row.read,
      authentication: drive ? null : row.authentication,
      fileName: drive ? row.file_name : null,
      lastModifiedBy: drive ? row.from_address : null,
    };
  });
}
