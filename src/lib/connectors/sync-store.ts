import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { StagedBill } from "./bills";
import { CONNECTION_COLUMNS, toConnection, type ConnectionRow } from "./connections";
import { NEW_CURSOR, type SyncCursor } from "./cursors";
import { PROVIDER_LABELS, type ExternalBill, type ExternalContact, type SourceStatus } from "./provider";
import type { SyncDb, SyncFinish } from "./sync";

/**
 * The sync runner's database (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2, X7, X10), in the
 * workspace's own scope through the DAL: the connection's sync lease, the cursors, the bills kept for review, the
 * supplier links, and how each run ended. No token is read here.
 */

interface CursorRow {
  phase: SyncCursor["phase"];
  since: string | null;
  page: number | null;
  high_water: string | null;
  run_started_at: string | null;
  changed_in_run: boolean | null;
  run_total: number | null;
  backfill_started_at: string | null;
  completed_at: string | null;
}

const isoOrNull = (value: string | null) => (value === null ? null : new Date(value).toISOString());

function toCursor(row: CursorRow): SyncCursor {
  return {
    phase: row.phase,
    since: isoOrNull(row.since),
    page: row.page,
    highWater: isoOrNull(row.high_water),
    backfillStartedAt: isoOrNull(row.backfill_started_at),
    runStartedAt: isoOrNull(row.run_started_at),
    changedInRun: row.changed_in_run === true,
    total: typeof row.run_total === "number" ? row.run_total : null,
    completedAt: isoOrNull(row.completed_at),
  };
}

function billFacts(bill: ExternalBill) {
  return {
    contact_external_id: bill.contactExternalId,
    contact_name: bill.contactName,
    number: bill.number,
    reference: bill.reference,
    currency: bill.currency,
    total: bill.total,
    amount_due: bill.amountDue,
    issued_on: bill.issuedOn,
    due_on: bill.dueOn,
    source_status: bill.status,
    external_version: bill.version,
    external_updated_at: bill.updatedAt,
  };
}

const CLOSED_WORDS: Partial<Record<SourceStatus, string>> = { paid: "paid", voided: "voided", deleted: "deleted" };

export const syncStore: SyncDb = {
  async claim(connectionId, nowIso, untilIso) {
    const rows = unwrap(
      await db()
        .from("accounting_connections")
        .update({ sync_lease_until: untilIso })
        .eq("id", connectionId)
        .eq("status", "connected")
        .or(`sync_lease_until.is.null,sync_lease_until.lte.${nowIso}`)
        .select(CONNECTION_COLUMNS)
    ) as unknown as ConnectionRow[];
    return rows[0] ? toConnection(rows[0]) : null;
  },

  async readCursor(connectionId, type) {
    const rows = unwrap(
      await db()
        .from("accounting_sync_cursors")
        .select("phase, since, page, high_water, run_started_at, changed_in_run, run_total, backfill_started_at, completed_at")
        .eq("connection_id", connectionId)
        .eq("object_type", type)
        .limit(1)
    ) as CursorRow[];
    return rows[0] ? toCursor(rows[0]) : NEW_CURSOR;
  },

  async writeCursor(connectionId, type, cursor) {
    unwrap(
      await db()
        .from("accounting_sync_cursors")
        .upsert(
          {
            connection_id: connectionId,
            object_type: type,
            phase: cursor.phase,
            since: cursor.since,
            page: cursor.page,
            high_water: cursor.highWater,
            run_started_at: cursor.runStartedAt,
            changed_in_run: cursor.changedInRun,
            run_total: cursor.total,
            backfill_started_at: cursor.backfillStartedAt,
            completed_at: cursor.completedAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "org_id,connection_id,object_type" }
        )
        .select("id")
    );
  },

  async stagedBills(connectionId, externalIds) {
    if (externalIds.length === 0) return new Map();
    const rows = unwrap(
      await db()
        .from("accounting_bills")
        .select("id, external_id, external_version, source_status, review_state, contact_name, number")
        .eq("connection_id", connectionId)
        .in("external_id", externalIds)
    ) as Array<{
      id: string;
      external_id: string;
      external_version: string | null;
      source_status: StagedBill["sourceStatus"];
      review_state: StagedBill["reviewState"];
      contact_name: string;
      number: string | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.external_id,
        { id: row.id, externalVersion: row.external_version, sourceStatus: row.source_status, reviewState: row.review_state, contactName: row.contact_name, number: row.number },
      ])
    );
  },

  async insertBill(connection, bill) {
    // A row already there (a run that stopped after writing it) is left for the next update to follow.
    unwrap(
      await db()
        .from("accounting_bills")
        .upsert({ connection_id: connection.id, external_id: bill.externalId, ...billFacts(bill) }, { onConflict: "org_id,connection_id,external_id", ignoreDuplicates: true })
        .select("id")
    );
  },

  async updateBill(_connection, staged, bill) {
    // A bill the provider names by its id alone (deleted, Q8) keeps the facts its row has: only what the provider says
    // of it, and its version, change.
    const values =
      bill.factsKnown === false
        ? { source_status: bill.status, external_version: bill.version, external_updated_at: bill.updatedAt }
        : billFacts(bill);
    unwrap(await db().from("accounting_bills").update({ ...values, changed_at: new Date().toISOString() }).eq("id", staged.id).select("id"));
  },

  async billClosed(connection, bill) {
    const links = unwrap(
      await db()
        .from("external_links")
        .select("local_id")
        .eq("connection_id", connection.id)
        .eq("object_type", "bill")
        .eq("external_id", bill.externalId)
        .limit(1)
    ) as Array<{ local_id: string | null }>;
    const label = PROVIDER_LABELS[connection.provider];
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "system",
      domain: "system",
      action: "accounting_bill_closed",
      summary: `${label} says bill ${bill.number ?? bill.externalId} from ${bill.contactName} was ${CLOSED_WORDS[bill.status] ?? bill.status} there, after it was added`,
      detail: {
        provider: connection.provider,
        connectionId: connection.id,
        externalOrgId: connection.externalOrgId,
        billId: bill.externalId,
        invoiceId: links[0]?.local_id ?? null,
        invoiceNumber: bill.number,
        sourceStatus: bill.status,
        at: bill.updatedAt,
      },
    });
  },

  async applyContacts(connection, contacts) {
    if (contacts.length === 0) return;
    const known = unwrap(
      await db()
        .from("external_links")
        .select("external_id, external_version")
        .eq("connection_id", connection.id)
        .eq("object_type", "contact")
        .in("external_id", contacts.map((contact) => contact.externalId))
    ) as Array<{ external_id: string; external_version: string | null }>;
    const versions = new Map(known.map((row) => [row.external_id, row.external_version]));
    const changed = contacts.filter((contact) => {
      const version = versions.get(contact.externalId);
      return version === undefined || version === null || contact.version > version;
    });
    if (changed.length === 0) return;
    // A link's local row is never set here: a supplier is linked when a person adds one of its bills.
    unwrap(
      await db()
        .from("external_links")
        .upsert(
          changed.map((contact: ExternalContact) => ({
            connection_id: connection.id,
            provider: connection.provider,
            external_org_id: connection.externalOrgId,
            object_type: "contact",
            external_id: contact.externalId,
            label: contact.name,
            external_version: contact.version,
            external_updated_at: contact.updatedAt,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: "org_id,provider,external_org_id,object_type,external_id" }
        )
        .select("id")
    );
  },

  async finish(connectionId, outcome: SyncFinish) {
    const done = { sync_lease_until: null };
    if (outcome.kind === "released") {
      unwrap(await db().from("accounting_connections").update(done).eq("id", connectionId).select("id"));
      return;
    }
    const values =
      outcome.kind === "synced"
        ? { ...done, last_synced_at: outcome.at, last_error: null, last_error_at: null, failures: 0, next_sync_after: null }
        : outcome.kind === "partial"
          ? { ...done, last_error: null, last_error_at: null, failures: 0, next_sync_after: null }
          : outcome.kind === "failed"
            ? { ...done, last_error: outcome.error, last_error_at: outcome.at, failures: outcome.failures, next_sync_after: outcome.nextSyncAfter }
            : { ...done, status: "needs_reconnect", last_error: outcome.error, last_error_at: outcome.at, next_sync_after: null };
    unwrap(await db().from("accounting_connections").update(values).eq("id", connectionId).select("id"));
  },
};
