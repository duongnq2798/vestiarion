import { createHash } from "node:crypto";
import type { LedgerEntryInput } from "../ledger";
import type { Network } from "../network";
import { failureDelayMs } from "./backoff";
import type { Connection } from "./connections";
import type { CrmAccountFacts, CrmReceiptWriter } from "./crm";
import {
  differing,
  fieldConflicts,
  fieldWords,
  RECEIPT_FIELDS,
  RECEIPT_GROUP,
  RECEIPT_LABELS,
  RECEIPT_PROPERTIES,
  receiptReality,
  receiptRealityRefusal,
  type FieldConflict,
  type ReceiptFields,
} from "./crm-receipts";
import { hasScopes } from "./posting";
import { ProviderError } from "./provider";

/**
 * Receipts written back to the CRM, run by run (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R5, R6, R7, R8):
 * queueing a write for each deal planned from the CRM whose figures changed, and sending the writes due, each read back
 * after it is written. The CRM and the database are injected (`crm-receipts-store.ts` is the real store), so every
 * branch is tested without either. No call to the CRM happens inside a database write; each transition is a
 * compare-and-set on the write's state, followed by its signed entry. Nothing here moves money, and nothing that moves
 * money reads it: a CRM that is down leaves writes waiting, never a payment sent again.
 */

export type WriteState = "queued" | "sending" | "sent" | "written" | "failed" | "conflict" | "refused" | "superseded";

/** A write as the runs read it. */
export interface ReceiptWriteRow {
  id: string;
  connectionId: string;
  crmDealId: string;
  dealId: string;
  externalDealId: string;
  fields: ReceiptFields;
  network: Network;
  shadow: boolean;
  accountType: string | null;
  accountTest: boolean | null;
  state: WriteState;
  reason: string | null;
  message: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  sendingUntil: string | null;
  conflicts: FieldConflict[];
  /** What the CRM held when a person chose to write Vestiarion's figures over it. */
  overwrite: Record<string, string> | null;
  overwriteBy: string | null;
  overwriteAt: string | null;
  /** The CRM's acknowledgement: the fields as read back after writing them. */
  readBack: ReceiptFields | null;
  sentAt: string | null;
  writtenAt: string | null;
  createdAt: string;
}

/** A deal planned from the CRM, with the fields its collections give now. */
export interface LinkedDealFields {
  crmDealId: string;
  dealId: string;
  externalDealId: string;
  title: string;
  fields: ReceiptFields;
  network: Network;
  shadow: boolean;
}

/** The columns a transition writes. */
export interface WritePatch {
  reason: string | null;
  message: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  sendingUntil: string | null;
  conflicts: FieldConflict[] | null;
  overwrite: Record<string, string> | null;
  overwriteBy: string | null;
  overwriteAt: string | null;
  readBack: ReceiptFields | null;
  sentAt: string;
  writtenAt: string;
  accountType: string | null;
  accountTest: boolean | null;
}

export interface ReceiptStore {
  /** The connection's deals planned from the CRM, still in it, with their fields now. */
  linkedDeals(connection: Connection): Promise<LinkedDealFields[]>;
  /** The latest write of each of these CRM deals that was not superseded. */
  latest(connectionId: string, crmDealIds: readonly string[]): Promise<Map<string, ReceiptWriteRow>>;
  /** What Vestiarion owns on the deal: the fields of its last write read back, or null before its first. */
  owned(crmDealId: string): Promise<ReceiptFields | null>;
  /** Queues a write; null when another is in hand for the deal (one per deal). */
  insert(connection: Connection, deal: LinkedDealFields): Promise<ReceiptWriteRow | null>;
  /**
   * Moves a write to `to` from one of `from`, as a compare-and-set: the row after, or null when it was in none of them.
   * `sending` counts as a `from` only once its lease ran out, at `leaseOverAt`.
   */
  move(row: ReceiptWriteRow, from: readonly WriteState[], to: WriteState, patch: Partial<WritePatch>, options?: { leaseOverAt?: string }): Promise<ReceiptWriteRow | null>;
  /** What a run sends: queued; failed whose time came; sending past its lease; sent and not read back. Oldest first. */
  due(connectionId: string, nowIso: string, limit: number): Promise<ReceiptWriteRow[]>;
  /** Appends a signed entry, best effort: the transition stands either way. */
  record(entry: LedgerEntryInput): Promise<void>;
}

export interface ReceiptDeps {
  connection: Connection;
  writer: CrmReceiptWriter;
  /** "HubSpot" */
  label: string;
  store: ReceiptStore;
  accessToken: () => Promise<string | null>;
  now?: () => number;
}

/** How long a run's send holds its write: far longer than four calls to the CRM take. */
export const SENDING_LEASE_MS = 2 * 60_000;
/** The writes one run sends: each is three or four calls. */
export const WRITES_PER_RUN = 25;
/** A write the CRM refused for a reason no retry soon fixes (a property it will not make) waits this long. */
const SLOW_RETRY_MS = 60 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** The conflicts as shown, a digest: Write Vestiarion's figures acts only on the set the page showed (R5). */
export function conflictKey(conflicts: readonly FieldConflict[]): string {
  const canonical = JSON.stringify(conflicts.map((conflict) => [conflict.field, conflict.ours, conflict.theirs]).sort((a, b) => a[0].localeCompare(b[0])));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Whether a connection may write now (R3): connected, writing turned on by a person, and every write scope granted. */
export type WriteGate = { ok: true } | { ok: false; reason: "disconnected" | "reconnect" | "off" | "scope" };

export function writeGate(connection: Pick<Connection, "status" | "scopes"> & { writesOn: boolean }, writeScopes: readonly string[]): WriteGate {
  if (connection.status === "revoked") return { ok: false, reason: "disconnected" };
  if (connection.status !== "connected") return { ok: false, reason: "reconnect" };
  if (!connection.writesOn) return { ok: false, reason: "off" };
  if (!hasScopes(connection.scopes, writeScopes)) return { ok: false, reason: "scope" };
  return { ok: true };
}

const same = (a: ReceiptFields, b: ReceiptFields) => differing(a, b).length === 0;

function base(deps: ReceiptDeps, row: Pick<ReceiptWriteRow, "id" | "dealId" | "externalDealId">) {
  return { provider: deps.connection.provider, connectionId: deps.connection.id, externalOrgId: deps.connection.externalOrgId, writeId: row.id, dealId: row.dealId, crmDealId: row.externalDealId };
}

const summaryOf = (fields: ReceiptFields) =>
  `collected ${fieldWords("vestiarion_collected", fields.vestiarion_collected, fields.vestiarion_currency)}, still owed ${fieldWords("vestiarion_still_owed", fields.vestiarion_still_owed, fields.vestiarion_currency)}`;

/**
 * Queues a write for each deal planned from the CRM whose fields differ from its latest write (R5): the first time
 * writing is on, every one; then only what a receipt, a reversal, a release or a new version changed. A newer write
 * supersedes one still queued, failed or in conflict; one in flight is left to finish, and the next run queues after it.
 * The same figures are never queued twice, whatever happened to the last write of them.
 */
export async function queueReceipts(deps: Pick<ReceiptDeps, "connection" | "store">): Promise<{ queued: number }> {
  const deals = await deps.store.linkedDeals(deps.connection);
  if (deals.length === 0) return { queued: 0 };
  const latest = await deps.store.latest(deps.connection.id, deals.map((deal) => deal.crmDealId));
  let queued = 0;
  for (const deal of deals) {
    const last = latest.get(deal.crmDealId);
    if (last && same(last.fields, deal.fields)) continue;
    if (last && (last.state === "sending" || last.state === "sent")) continue;
    if (last && (last.state === "queued" || last.state === "failed" || last.state === "conflict")) {
      if (!(await deps.store.move(last, [last.state], "superseded", {}))) continue;
    }
    if (await deps.store.insert(deps.connection, deal)) queued += 1;
  }
  return { queued };
}

export interface SendSummary {
  written: number;
  conflicts: number;
  failed: number;
  refused: number;
  /** Left for a later run: the account not read, or the CRM asked to slow down. */
  waiting: number;
}

class Stop extends Error {}

/**
 * Sends the writes due (R6), each in order: the reality rule against the account as the CRM says it is now; a claim;
 * the Vestiarion fields made where missing, once a run; the deal's fields read, and any a person changed since
 * Vestiarion last wrote them reported as a conflict, never written over; the write; and the read-back, whose answer is
 * the acknowledgement. A timeout or a 5xx reads back before anything else: what the CRM holds decides. A rate limit ends
 * the run. Nothing is sent while the connection may not write.
 */
export async function sendReceipts(deps: ReceiptDeps & { writesOn: boolean }): Promise<SendSummary> {
  const now = deps.now ?? Date.now;
  const summary: SendSummary = { written: 0, conflicts: 0, failed: 0, refused: 0, waiting: 0 };
  if (!writeGate({ ...deps.connection, writesOn: deps.writesOn }, deps.writer.writeScopes).ok) return summary;
  const due = await deps.store.due(deps.connection.id, iso(now()), WRITES_PER_RUN);
  if (due.length === 0) return summary;
  const token = await deps.accessToken();
  if (!token) {
    summary.waiting += due.length;
    return summary;
  }
  const account = { accessToken: token, externalOrgId: deps.connection.externalOrgId };
  let facts: CrmAccountFacts | null = null;
  try {
    facts = await deps.writer.account(account);
  } catch (error) {
    // Not read: nothing whose rule needs it is sent, nor refused; the next run reads it again (R4).
    console.error("crm receipts: the account was not read", deps.connection.id, error instanceof Error ? error.message : "unknown error");
  }
  let fieldsReady: { ok: true } | { ok: false; message: string } | null = null;

  for (const [index, row] of due.entries()) {
    try {
      const outcome = await sendOne(deps, row, account, facts, now, async () => (fieldsReady ??= await deps.writer.ensureFields({ ...account, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES })));
      summary[outcome] += 1;
    } catch (error) {
      // A rate limit: this write failed with the wait the CRM asked for, and the rest wait for a later run.
      if (error instanceof Stop) {
        summary.failed += 1;
        summary.waiting += due.length - index - 1;
        break;
      }
      throw error;
    }
  }
  return summary;
}

type Outcome = keyof SendSummary;

async function sendOne(
  deps: ReceiptDeps,
  row: ReceiptWriteRow,
  account: { accessToken: string; externalOrgId: string },
  facts: CrmAccountFacts | null,
  now: () => number,
  ensure: () => Promise<{ ok: true } | { ok: false; message: string }>
): Promise<Outcome> {
  const { store, writer, label } = deps;
  const names = RECEIPT_FIELDS;

  // A write the CRM took and Vestiarion did not read back yet: only the read-back.
  if (row.state === "sent") return acknowledge(deps, row, account, now);

  const reality = receiptReality({ network: row.network, shadow: row.shadow }, facts ? facts.test : null);
  if (!reality.ok && !reality.refused) return "waiting";
  if (!reality.ok) {
    const message = receiptRealityRefusal(label);
    const refused = await store.move(
      row,
      ["queued", "failed", "sending"],
      "refused",
      { reason: "reality", message, sendingUntil: null, accountType: facts?.accountType ?? null, accountTest: facts?.test ?? null },
      { leaseOverAt: iso(now()) }
    );
    if (!refused) return "waiting";
    await store.record({
      actor: "system",
      domain: "ar",
      action: "crm_receipt_refused",
      summary: `Not written to ${label}: ${message}`,
      detail: { ...base(deps, row), reason: "reality", message, network: row.network, shadow: row.shadow, accountType: facts?.accountType ?? null },
    });
    return "refused";
  }

  const claimed = await store.move(
    row,
    ["queued", "failed", "sending"],
    "sending",
    { sendingUntil: iso(now() + SENDING_LEASE_MS), attempts: row.attempts + 1, accountType: facts?.accountType ?? null, accountTest: facts?.test ?? null },
    { leaseOverAt: iso(now()) }
  );
  if (!claimed) return "waiting";

  const fail = async (reason: string, message: string, retryInMs: number): Promise<Outcome> => {
    const failed = await store.move(claimed, ["sending"], "failed", { reason, message, sendingUntil: null, nextAttemptAt: iso(now() + retryInMs) });
    // One entry for a write's failures, at its first: an outage retried every few minutes is not recorded each time.
    if (failed && claimed.attempts === 1) {
      await store.record({
        actor: "system",
        domain: "ar",
        action: "crm_receipt_failed",
        summary: `Not written to ${label} yet: ${message}`,
        detail: { ...base(deps, claimed), reason, message, retryAt: iso(now() + retryInMs) },
      });
    }
    return "failed";
  };
  const fromError = async (error: unknown): Promise<Outcome> => {
    if (!(error instanceof ProviderError)) throw error;
    if (error.failure === "rate_limited") {
      await fail("rate_limited", `${label} asked Vestiarion to slow down.`, error.retryAfterMs ?? 60_000);
      throw new Stop();
    }
    if (error.failure === "unauthorized" || error.failure === "forbidden") {
      return fail("reconnect", `${label} refused the write: allow writing to ${label} again from Settings.`, SLOW_RETRY_MS);
    }
    return fail("no_answer", `${label} did not answer. Vestiarion tries again on its own.`, failureDelayMs(claimed.attempts));
  };

  try {
    const ready = await ensure();
    if (!ready.ok) return fail("fields", ready.message, SLOW_RETRY_MS);

    const read = await writer.readFields({ ...account, dealId: claimed.externalDealId, names });
    if (!read.found) {
      const message = `${label} no longer has this deal: nothing is written.`;
      const refused = await store.move(claimed, ["sending"], "refused", { reason: "deal_gone", message, sendingUntil: null });
      if (refused) {
        await store.record({ actor: "system", domain: "ar", action: "crm_receipt_refused", summary: `Not written to ${label}: ${message}`, detail: { ...base(deps, claimed), reason: "deal_gone", message } });
      }
      return "refused";
    }
    // Already what this write says (an earlier write that landed while its answer was lost): acknowledged as it is.
    if (differing(claimed.fields, read.values).length === 0) return written(deps, claimed, ["sending"], read.values, now, true);

    const owned = await store.owned(claimed.crmDealId);
    const conflicts = fieldConflicts({ owned, held: read.values, next: claimed.fields, seen: claimed.overwrite });
    if (conflicts.length > 0) return conflict(deps, claimed, ["sending"], conflicts);

    let answered: { ok: true } | { ok: false; message: string };
    try {
      answered = await writer.writeFields({ ...account, dealId: claimed.externalDealId, values: claimed.fields });
    } catch (error) {
      // No answer: what the CRM holds decides, read back before anything else.
      if (error instanceof ProviderError && (error.failure === "unavailable" || error.failure === "bad_response")) {
        const after = await writer.readFields({ ...account, dealId: claimed.externalDealId, names }).catch(() => null);
        if (after?.found && differing(claimed.fields, after.values).length === 0) return written(deps, claimed, ["sending"], after.values, now, false);
      }
      return fromError(error);
    }
    if (!answered.ok) return fail("refused_by_crm", answered.message, SLOW_RETRY_MS);
    const sent = await store.move(claimed, ["sending"], "sent", { sentAt: iso(now()), sendingUntil: null, reason: null, message: null });
    if (!sent) return "waiting";
    return acknowledge(deps, sent, account, now);
  } catch (error) {
    if (error instanceof Stop) throw error;
    return fromError(error);
  }
}

/** The read-back (R6): the same fields acknowledge the write; others are someone's change since; no answer waits. */
async function acknowledge(deps: ReceiptDeps, row: ReceiptWriteRow, account: { accessToken: string; externalOrgId: string }, now: () => number): Promise<Outcome> {
  let read;
  try {
    read = await deps.writer.readFields({ ...account, dealId: row.externalDealId, names: RECEIPT_FIELDS });
  } catch {
    // Left sent: the next run reads it back.
    return "waiting";
  }
  if (!read.found) {
    const failed = await deps.store.move(row, ["sent"], "failed", { reason: "deal_gone", message: `${deps.label} no longer has this deal.`, nextAttemptAt: iso(now()) });
    return failed ? "failed" : "waiting";
  }
  if (differing(row.fields, read.values).length === 0) return written(deps, row, ["sent"], read.values, now, false);
  return conflict(deps, row, ["sent"], fieldConflicts({ owned: row.fields, held: read.values, next: row.fields }));
}

async function written(
  deps: ReceiptDeps,
  row: ReceiptWriteRow,
  from: readonly WriteState[],
  values: Readonly<Record<string, string | null>>,
  now: () => number,
  adopted: boolean
): Promise<Outcome> {
  const readBack = Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, values[name] ?? ""])) as ReceiptFields;
  const at = iso(now());
  const moved = await deps.store.move(row, from, "written", { writtenAt: at, readBack, sendingUntil: null, reason: null, message: null, ...(row.sentAt ? {} : { sentAt: at }) });
  if (!moved) return "waiting";
  await deps.store.record({
    actor: "system",
    domain: "ar",
    action: "crm_receipt_written",
    summary: `Wrote to the ${deps.label} deal: ${summaryOf(row.fields)}. ${deps.label} read it back the same`,
    detail: { ...base(deps, row), fields: readBack, writtenAt: at, adopted, network: row.network, shadow: row.shadow, accountType: row.accountType },
  });
  return "written";
}

async function conflict(deps: ReceiptDeps, row: ReceiptWriteRow, from: readonly WriteState[], conflicts: FieldConflict[]): Promise<Outcome> {
  const fields = conflicts.map((item) => RECEIPT_LABELS[item.field]).join(", ");
  const message = `Someone changed ${fields} in ${deps.label} since Vestiarion last wrote it: nothing was written over it.`;
  const moved = await deps.store.move(row, from, "conflict", { conflicts, reason: "changed_in_crm", message: message.slice(0, 300), sendingUntil: null });
  if (!moved) return "waiting";
  await deps.store.record({
    actor: "system",
    domain: "ar",
    action: "crm_receipt_conflict",
    summary: `Not written to ${deps.label}: ${message}`,
    detail: { ...base(deps, row), conflicts },
  });
  return "conflicts";
}
