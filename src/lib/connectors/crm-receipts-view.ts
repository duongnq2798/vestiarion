import { currentOrgConfig } from "../context";
import { db } from "../dal";
import { networkOf, networkProfile, type Network } from "../network";
import { connectionById, isNotSetUp, type Connection } from "./connections";
import { dayWords } from "./crm";
import { fieldWords, RECEIPT_FIELDS, RECEIPT_LABELS, receiptRealityRefusal, type ReceiptFields } from "./crm-receipts";
import { conflictKey, writeGate, type ReceiptWriteRow, type WriteGate } from "./crm-receipts-run";
import { toWrite, WRITE_COLUMNS, writesSwitch, type WriteDbRow } from "./crm-receipts-store";
import { PROVIDER_LABELS, type ProviderId } from "./provider";

/**
 * What receipts written to a CRM look like to a person (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R8),
 * read in the workspace's scope: on a deal's page, what was written and when, and where the next write stands; on the
 * CRM's card in Settings, whether writing is on and how the writes stand. Nothing here writes; nothing carries a token.
 */

export type ReceiptStatus = "written" | "waiting" | "failed" | "conflict" | "not_allowed" | "refused";

export interface FieldLine {
  label: string;
  value: string;
  /** A link field's address: the transaction on Arc's explorer, the deal in Vestiarion. */
  href?: string;
}

export interface ConflictLine {
  label: string;
  ours: string;
  theirs: string;
  next: string;
}

export interface CrmReceiptView {
  /** The CRM, for the action its card's form calls; HubSpot when absent. */
  provider?: ProviderId;
  label: string;
  status: ReceiptStatus;
  title: string;
  detail: string[];
  /** The fields as the CRM read them back at the last write, and when. */
  lastWritten: { at: string; fields: FieldLine[] } | null;
  /** What the next write holds, while it waits, failed or is in conflict. */
  pending: FieldLine[] | null;
  conflicts: ConflictLine[];
  /** The conflicts' `conflictKey`, sent back by Write Vestiarion's figures. */
  seen: string | null;
  /** What a person can do about a write not allowed: allow writing (a reconnect) or turn it on, in Settings. */
  fix: "allow" | "turn_on" | "reconnect" | null;
}

const at = (value: string) => `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const LINK_WORDS: Partial<Record<(typeof RECEIPT_FIELDS)[number], (href: string) => string>> = {
  vestiarion_last_receipt_link: (href) => {
    const hash = href.split("/").at(-1) ?? "";
    return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `Transaction ${hash.slice(0, 10)}…${hash.slice(-6)}` : href;
  },
  vestiarion_evidence_link: () => "This deal in Vestiarion",
};

function lines(fields: ReceiptFields): FieldLine[] {
  const currency = fields.vestiarion_currency || null;
  return RECEIPT_FIELDS.filter((field) => field !== "vestiarion_currency").map((field) => {
    const value = fields[field];
    const link = LINK_WORDS[field];
    if (link && /^https:\/\//.test(value)) return { label: RECEIPT_LABELS[field], value: link(value), href: value };
    if (field === "vestiarion_last_receipt_date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { label: RECEIPT_LABELS[field], value: dayWords(value) };
    return { label: RECEIPT_LABELS[field], value: fieldWords(field, value, currency) };
  });
}

const NOT_ALLOWED: Record<Exclude<WriteGate, { ok: true }>["reason"], (label: string) => { title: string; detail: string; fix: CrmReceiptView["fix"] }> = {
  off: (label) => ({ title: `Not written to ${label}: writing is off`, detail: `An owner or admin turns on Write receipts to ${label} in Settings.`, fix: "turn_on" }),
  scope: (label) => ({ title: `Not written to ${label} yet: ${label} has not allowed Vestiarion to write`, detail: `An owner or admin uses Allow writing to ${label} in Settings.`, fix: "allow" }),
  reconnect: (label) => ({ title: `Not written to ${label}: ${label} needs you to reconnect`, detail: `An owner or admin reconnects ${label} in Settings.`, fix: "reconnect" }),
  disconnected: (label) => ({ title: `Not written to ${label}: ${label} is disconnected`, detail: "What was written before stays there.", fix: null }),
};

/** A deal's receipts in the CRM (R8), from its writes and its connection; null when it was not planned from a CRM that writes. */
export function receiptView(input: {
  label: string;
  gate: WriteGate;
  latest: ReceiptWriteRow | null;
  lastWritten: ReceiptWriteRow | null;
}): CrmReceiptView {
  const { label, latest } = input;
  const lastWritten = input.lastWritten?.writtenAt && input.lastWritten.readBack ? { at: input.lastWritten.writtenAt, fields: lines(input.lastWritten.readBack) } : null;
  const base = { label, lastWritten, pending: null, conflicts: [], seen: null, fix: null } satisfies Partial<CrmReceiptView>;
  if (latest?.state === "refused") {
    return { ...base, status: "refused", title: `Not written to ${label}`, detail: [latest.message ?? receiptRealityRefusal(label)] };
  }
  if (latest?.state === "conflict") {
    return {
      ...base,
      status: "conflict",
      title: `Not written: someone changed it in ${label}`,
      detail: [
        `${label} holds other figures than the ones Vestiarion last wrote. Nothing was written over them.`,
        "Write Vestiarion's figures to put them back, or leave it: later receipts wait here too until someone chooses.",
      ],
      pending: lines(latest.fields),
      conflicts: latest.conflicts.map((conflict) => {
        const currency = latest.fields.vestiarion_currency || null;
        return {
          label: RECEIPT_LABELS[conflict.field],
          ours: fieldWords(conflict.field, conflict.ours, currency),
          theirs: fieldWords(conflict.field, conflict.theirs, currency),
          next: fieldWords(conflict.field, conflict.next, currency),
        };
      }),
      seen: conflictKey(latest.conflicts),
    };
  }
  if (!input.gate.ok) {
    const words = NOT_ALLOWED[input.gate.reason](label);
    return { ...base, status: "not_allowed", title: words.title, detail: [words.detail], pending: latest && latest.state !== "written" ? lines(latest.fields) : null, fix: words.fix };
  }
  if (!latest) {
    return { ...base, status: "waiting", title: `Waiting to be written to ${label}`, detail: [`The next sync writes it, within 15 minutes, or now with Sync now in Settings.`] };
  }
  switch (latest.state) {
    case "written":
      return {
        ...base,
        status: "written",
        title: `Written to ${label}`,
        detail: [`${label} read it back the same at ${at(latest.writtenAt ?? latest.createdAt)}. Only payments confirmed on Arc and applied to this deal's invoices are counted.`],
      };
    case "failed":
      return {
        ...base,
        status: "failed",
        title: `Not written to ${label} yet`,
        detail: [latest.message ?? `${label} did not take it.`, latest.nextAttemptAt ? `Vestiarion tries again at ${at(latest.nextAttemptAt)}.` : "Vestiarion tries again at the next sync."],
        pending: lines(latest.fields),
      };
    case "sent":
      return { ...base, status: "waiting", title: `Sent to ${label}, reading it back`, detail: [`${label} took it at ${at(latest.sentAt ?? latest.createdAt)}. It counts as written once ${label} reads it back the same.`], pending: lines(latest.fields) };
    default:
      return {
        ...base,
        status: "waiting",
        title: `Waiting to be written to ${label}`,
        detail: [`Queued at ${at(latest.createdAt)}. The next sync writes it, within 15 minutes.`],
        pending: lines(latest.fields),
      };
  }
}

/** The writes of a deal: the latest not superseded, and the last read back. */
async function writesOfDeal(dealId: string): Promise<{ latest: ReceiptWriteRow | null; lastWritten: ReceiptWriteRow | null } | null> {
  const found = await db().from("crm_receipt_writes").select(WRITE_COLUMNS).eq("deal_id", dealId).neq("state", "superseded").order("created_at", { ascending: false }).limit(20);
  if (found.error) {
    if (isNotSetUp(found.error)) return null;
    throw new Error(found.error.message);
  }
  const rows = ((found.data ?? []) as unknown as WriteDbRow[]).map(toWrite);
  return { latest: rows[0] ?? null, lastWritten: rows.find((row) => row.state === "written") ?? null };
}

/**
 * A deal's receipts in the CRM it was planned from, for its page (R8); null when it was not planned from one, the CRM
 * writes nothing (`writeScopes` null), or migration 0107 has not run.
 */
export async function crmReceiptFor(
  dealId: string,
  writeScopesOf: (connection: Connection) => readonly string[] | null,
  /** False for a CRM that names no test account (Pipedrive connector P12): a workspace that never writes to it says so. */
  testAccountsOf: (connection: Connection) => false | undefined = () => undefined
): Promise<CrmReceiptView | null> {
  const linked = await db().from("crm_deals").select("connection_id").eq("deal_id", dealId).limit(1);
  if (linked.error) {
    if (isNotSetUp(linked.error)) return null;
    throw new Error(linked.error.message);
  }
  const connectionId = ((linked.data ?? []) as Array<{ connection_id: string }>)[0]?.connection_id;
  if (!connectionId) return null;
  const connection = await connectionById(connectionId);
  const writeScopes = connection ? writeScopesOf(connection) : null;
  if (!connection || !writeScopes) return null;
  const [writes, switched] = await Promise.all([writesOfDeal(dealId), writesSwitch(connection.id)]);
  if (!writes || !switched) return null;
  const label = PROVIDER_LABELS[connection.provider];
  const view = { ...receiptView({ label, gate: writeGate({ ...connection, writesOn: switched.on }, writeScopes), ...writes }), provider: connection.provider };
  if (testAccountsOf(connection) === false && (view.status === "not_allowed" || view.status === "waiting")) {
    // Never written from this workspace, whatever a person turns on: said as it is, with nothing to press.
    const reality = await workspaceReality();
    if (!realPayments(reality)) return { ...view, status: "refused", title: `Not written to ${label}`, detail: [noTestAccountRule(label, reality)], pending: null, fix: null };
  }
  return view;
}

/** Receipts on the CRM's card in Settings (R3, R8). */
export interface CrmReceiptsPanel {
  on: boolean;
  /** Every write scope granted. */
  allowed: boolean;
  counts: { written: number; waiting: number; failed: number; conflicts: number; refused: number };
  lastWrittenAt: string | null;
  /** What the CRM last said of the account, in words; null before the first write tried. */
  account: string | null;
  /** The reality rule for this workspace, in words; null when its payments may go to any account. */
  rule: string | null;
  /**
   * Writing cannot be turned on for this workspace: the CRM names no test account, and the workspace pays on Arc testnet
   * or keeps shadow mode (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P12).
   */
  blocked?: boolean;
}

/**
 * The workspace's payments: its network, and whether it keeps shadow mode (R4). Shadow mode not read counts as on: this
 * gates writing, and only ever more strictly.
 */
export async function workspaceReality(): Promise<{ network: Network; shadow: boolean }> {
  const network = networkOf(currentOrgConfig().network);
  const shadow = await db().from("shadow_modes").select("org_id").limit(1);
  return { network, shadow: shadow.error ? true : (shadow.data ?? []).length > 0 };
}

/** Payments on Arc mainnet outside shadow mode: real money, written to any account (R4). */
export const realPayments = (reality: { network: Network; shadow: boolean }) => reality.network === "arc-mainnet" && !reality.shadow;

/**
 * The reality rule in a CRM that names no test account (Pipedrive connector P12): a workspace on Arc testnet or in shadow
 * mode never writes to it.
 */
export function noTestAccountRule(label: string, reality: { network: Network; shadow: boolean }): string {
  const where = reality.shadow ? "This workspace is in shadow mode" : `This workspace pays on ${networkProfile(reality.network).label}`;
  return `${where}, and ${label} does not say which of its companies are developer sandboxes: Vestiarion never writes these receipts to ${label}. Reading deals and planning collections work as usual.`;
}

const ACCOUNT_WORDS: Record<string, string> = {
  DEVELOPER_TEST: "a developer test account",
  SANDBOX: "a sandbox",
  STANDARD: "a standard account",
  APP_DEVELOPER: "an app developer account",
};

/** The card's receipts part; null before migration 0107 has run, or for a connection disconnected. */
export async function crmReceiptsPanel(connection: Connection, writeScopes: readonly string[], options: { testAccounts?: false } = {}): Promise<CrmReceiptsPanel | null> {
  if (connection.status === "revoked") return null;
  const switched = await writesSwitch(connection.id);
  if (!switched) return null;
  const found = await db()
    .from("crm_receipt_writes")
    .select("crm_deal_id, state, account_type, written_at, created_at")
    .eq("connection_id", connection.id)
    .neq("state", "superseded")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (found.error) {
    if (isNotSetUp(found.error)) return null;
    throw new Error(found.error.message);
  }
  const rows = (found.data ?? []) as Array<{ crm_deal_id: string; state: string; account_type: string | null; written_at: string | null; created_at: string }>;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.crm_deal_id)) latest.set(row.crm_deal_id, row);
  const counts = { written: 0, waiting: 0, failed: 0, conflicts: 0, refused: 0 };
  for (const row of latest.values()) {
    if (row.state === "written") counts.written += 1;
    else if (row.state === "failed") counts.failed += 1;
    else if (row.state === "conflict") counts.conflicts += 1;
    else if (row.state === "refused") counts.refused += 1;
    else counts.waiting += 1;
  }
  const label = PROVIDER_LABELS[connection.provider];
  const accountType = rows.find((row) => row.account_type)?.account_type ?? null;
  const writtenAt = rows.map((row) => row.written_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const network = networkOf(currentOrgConfig().network);
  const shadow = (await db().from("shadow_modes").select("org_id").limit(1)).data?.length ?? 0;
  if (options.testAccounts === false) {
    // A CRM that names no test account (Pipedrive connector P12): its own words, and no switch where it would never write.
    const reality = await workspaceReality();
    const real = realPayments(reality);
    return {
      on: switched.on,
      allowed: writeGate({ ...connection, writesOn: true }, writeScopes).ok,
      counts,
      lastWrittenAt: writtenAt,
      account: null,
      rule: real ? null : noTestAccountRule(label, reality),
      blocked: !real,
    };
  }
  return {
    on: switched.on,
    allowed: writeGate({ ...connection, writesOn: true }, writeScopes).ok,
    counts,
    lastWrittenAt: writtenAt,
    account: accountType ? `${label} says this is ${ACCOUNT_WORDS[accountType] ?? accountType.toLowerCase().replace(/_/g, " ")}.` : null,
    rule:
      network === "arc-mainnet" && shadow === 0
        ? null
        : `${shadow > 0 ? "This workspace is in shadow mode" : `This workspace pays on ${networkProfile(network).label}`}: its receipts are written only to a ${label} developer test account or sandbox, never to a real ${label} account.`,
  };
}

/** The card's receipts part for a connection named by its id (the card's view carries the id). */
export async function crmReceiptsPanelFor(connectionId: string, writeScopes: readonly string[], options: { testAccounts?: false } = {}): Promise<CrmReceiptsPanel | null> {
  const connection = await connectionById(connectionId);
  return connection ? crmReceiptsPanel(connection, writeScopes, options) : null;
}
