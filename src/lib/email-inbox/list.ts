import { db, unwrap } from "../dal";

/**
 * The emails still to decide on AP / AR (email invoices design E7): newest first, what was read and why it cannot be
 * added when it cannot. Never the stored draft: the page shows what was read, and the command adds what was stored.
 * Runs inside the workspace's scope.
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
  document?: { kind: "pdf" | "email" | "text"; sha256: string };
}

export type InboxStatus = "received" | "ready" | "needs_details" | "unreadable";

export interface InboxEmailView {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: string;
  status: InboxStatus;
  reasons: string[];
  read: ShownRead | null;
  authentication: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
}

const STILL_TO_DECIDE: InboxStatus[] = ["received", "ready", "needs_details", "unreadable"];

interface Row {
  id: string;
  from_address: string | null;
  subject: string | null;
  received_at: string;
  status: InboxStatus;
  reasons: string[] | null;
  read: ShownRead | null;
  authentication: InboxEmailView["authentication"];
}

export async function inboxEmailsToDecide(limit = 50): Promise<InboxEmailView[]> {
  const rows = unwrap(
    await db()
      .from("inbox_emails")
      .select("id, from_address, subject, received_at, status, reasons, read, authentication")
      .in("status", STILL_TO_DECIDE)
      .order("received_at", { ascending: false })
      .limit(limit)
  ) as Row[];
  return rows.map((row) => ({
    id: row.id,
    from: row.from_address,
    subject: row.subject,
    receivedAt: row.received_at,
    status: row.status,
    reasons: row.reasons ?? [],
    read: row.read,
    authentication: row.authentication,
  }));
}
