import crypto from "node:crypto";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";

/**
 * A workspace's address for invoices by email (email invoices design E2), in `invoice_inboxes`, a platform table the
 * service role alone reads and writes (migration 0068). The code is 12 characters of base32, 60 random bits, so an
 * address cannot be guessed; knowing one lets anyone file a draft, so the ledger records each change without it. The
 * functions that change an address run inside its workspace's scope.
 */

export interface InvoiceInbox {
  id: string;
  orgId: string;
  code: string;
  createdAt: string;
}

interface InboxRow {
  id: string;
  org_id: string;
  code: string;
  created_at: string;
}

const COLUMNS = "id, org_id, code, created_at";
const CODE = /^[a-z2-7]{12}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const toInbox = (row: InboxRow): InvoiceInbox => ({ id: row.id, orgId: row.org_id, code: row.code, createdAt: row.created_at });

/** 12 base32 characters: 256 is a multiple of 32, so each byte picks one evenly. */
function newCode(): string {
  return Array.from(crypto.randomBytes(12), (byte) => BASE32[byte % 32]).join("");
}

function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("An inbox's entry cannot be written to another workspace's ledger");
}

async function oneInbox(column: "org_id" | "code", value: string): Promise<InvoiceInbox | null> {
  const rows = unwrap(await platformDb().from("invoice_inboxes").select(COLUMNS).eq(column, value).limit(1)) as InboxRow[];
  return rows[0] ? toInbox(rows[0]) : null;
}

export function inboxFor(orgId: string): Promise<InvoiceInbox | null> {
  return oneInbox("org_id", orgId);
}

/** The inbox an address's code names; a string that is not a code asks the database nothing. */
export async function inboxOfCode(code: string): Promise<InvoiceInbox | null> {
  return CODE.test(code) ? oneInbox("code", code) : null;
}

/** Turns the address on, or keeps the one the workspace already has. */
export async function turnInboxOn(orgId: string, by: string): Promise<InvoiceInbox> {
  requireScope(orgId);
  const existing = await inboxFor(orgId);
  if (existing) return existing;
  const [row] = unwrap(
    await platformDb().from("invoice_inboxes").insert({ org_id: orgId, code: newCode(), created_by: by }).select(COLUMNS)
  ) as InboxRow[];
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "invoice_inbox_on",
    summary: "Turned on invoices by email",
    detail: { by },
  });
  return toInbox(row);
}

/** A new address in place of the old one, which stops at once; null when the workspace has none. */
export async function changeInboxAddress(orgId: string, by: string): Promise<InvoiceInbox | null> {
  requireScope(orgId);
  const rows = unwrap(await platformDb().from("invoice_inboxes").update({ code: newCode() }).eq("org_id", orgId).select(COLUMNS)) as InboxRow[];
  if (!rows[0]) return null;
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "invoice_inbox_changed",
    summary: "Gave invoices by email a new address; the old one no longer works",
    detail: { by },
  });
  return toInbox(rows[0]);
}

/** Turns the address off. The emails that already arrived stay, for a person to decide. */
export async function turnInboxOff(orgId: string, by: string): Promise<boolean> {
  requireScope(orgId);
  const deleted = unwrap(await platformDb().from("invoice_inboxes").delete().eq("org_id", orgId).select("id")) as Array<{ id: string }>;
  if (deleted.length === 0) return false;
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "invoice_inbox_off",
    summary: "Turned off invoices by email",
    detail: { by },
  });
  return true;
}
