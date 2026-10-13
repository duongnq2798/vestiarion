import { siteOrigin } from "../auth/env";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { collectionOfRows, type CollectionRows } from "../deals/collection";
import { readDealCollections } from "../deals/collection-read";
import { paidOnArc } from "../deals/money";
import { readDeals, type DealRecord } from "../deals/read";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkOf, type Network } from "../network";
import { isNotSetUp, NotSetUpError } from "./connections";
import { evidenceUrl, readConflicts, readReceiptFields, receiptFields, type ReceiptFields } from "./crm-receipts";
import type { LinkedDealFields, ReceiptStore, ReceiptWriteRow, WritePatch, WriteState } from "./crm-receipts-run";

/**
 * The receipts' database (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1, R5, R7), in the workspace's own
 * scope through the DAL: the deals planned from the CRM with what they collected, read as the deal's own page reads it
 * (`readDealCollections`); and the outbox of writes (`crm_receipt_writes`, migration 0107). Before 0107 has run, every
 * read says it is not set up. No token is read here.
 */

export const WRITE_COLUMNS =
  "id, connection_id, crm_deal_id, deal_id, external_deal_id, fields, network, shadow, account_type, account_test, state, reason, message, attempts, next_attempt_at, sending_until, conflicts, overwrite, overwrite_by, overwrite_at, read_back, sent_at, written_at, created_at";

export interface WriteDbRow {
  id: string;
  connection_id: string;
  crm_deal_id: string;
  deal_id: string;
  external_deal_id: string;
  fields: unknown;
  network: string;
  shadow: boolean;
  account_type: string | null;
  account_test: boolean | null;
  state: WriteState;
  reason: string | null;
  message: string | null;
  attempts: number;
  next_attempt_at: string | null;
  sending_until: string | null;
  conflicts: unknown;
  overwrite: unknown;
  overwrite_by: string | null;
  overwrite_at: string | null;
  read_back: unknown;
  sent_at: string | null;
  written_at: string | null;
  created_at: string;
}

const EMPTY = readReceiptFields({}) as ReceiptFields;

function textRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function toWrite(row: WriteDbRow): ReceiptWriteRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    crmDealId: row.crm_deal_id,
    dealId: row.deal_id,
    externalDealId: row.external_deal_id,
    fields: readReceiptFields(row.fields) ?? EMPTY,
    network: networkOf(row.network),
    shadow: row.shadow,
    accountType: row.account_type,
    accountTest: row.account_test,
    state: row.state,
    reason: row.reason,
    message: row.message,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at,
    sendingUntil: row.sending_until,
    conflicts: readConflicts(row.conflicts),
    overwrite: textRecord(row.overwrite),
    overwriteBy: row.overwrite_by,
    overwriteAt: row.overwrite_at,
    readBack: row.read_back === null ? null : readReceiptFields(row.read_back),
    sentAt: row.sent_at,
    writtenAt: row.written_at,
    createdAt: row.created_at,
  };
}

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error)) throw new NotSetUpError();
  throw new Error(error.message);
}

function patchColumns(patch: Partial<WritePatch>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  const map: Record<keyof WritePatch, string> = {
    reason: "reason",
    message: "message",
    attempts: "attempts",
    nextAttemptAt: "next_attempt_at",
    sendingUntil: "sending_until",
    conflicts: "conflicts",
    overwrite: "overwrite",
    overwriteBy: "overwrite_by",
    overwriteAt: "overwrite_at",
    readBack: "read_back",
    sentAt: "sent_at",
    writtenAt: "written_at",
    accountType: "account_type",
    accountTest: "account_test",
  };
  for (const [key, column] of Object.entries(map) as Array<[keyof WritePatch, string]>) {
    if (patch[key] !== undefined) columns[column] = patch[key];
  }
  return columns;
}

/** Whether writing is on for a connection (0107), or null before 0107 has run: nothing is written then. */
export async function writesSwitch(connectionId: string): Promise<{ on: boolean; by: string | null; at: string | null } | null> {
  const result = await db().from("accounting_connections").select("writes_on, writes_by, writes_at").eq("id", connectionId).limit(1);
  if (result.error) {
    if (isNotSetUp(result.error) || result.error.code === "42703" || result.error.code === "PGRST204" || /writes_on/.test(result.error.message ?? "")) return null;
    throw new Error(result.error.message);
  }
  const row = ((result.data ?? []) as Array<{ writes_on: boolean; writes_by: string | null; writes_at: string | null }>)[0];
  return row ? { on: row.writes_on === true, by: row.writes_by, at: row.writes_at } : null;
}

/** Every row of a read of ids, a hundred ids at a time. */
async function byIds<T>(ids: readonly string[], read: (batch: string[]) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let at = 0; at < ids.length; at += 100) {
    const result = await read(ids.slice(at, at + 100));
    if (result.error) raise(result.error);
    rows.push(...((result.data ?? []) as T[]));
  }
  return rows;
}

/**
 * The fields written for a deal (R1, R2), from rows already read: what it collected, as its own page shows it
 * (`collectionOfRows`), and the deal's page in Vestiarion as its evidence.
 */
export function dealFields(input: { deal: Pick<DealRecord, "facts" | "digits">; today: string; evidence: string } & CollectionRows): ReceiptFields {
  return receiptFields(collectionOfRows(input.deal, input, input.today), input.evidence);
}

/** The workspace's slug, for the evidence link. */
async function workspaceSlug(): Promise<string> {
  const found = await platformDb().from("orgs").select("slug").eq("id", currentOrgId()).limit(1);
  if (found.error) throw new Error(found.error.message);
  const slug = ((found.data ?? []) as Array<{ slug: string }>)[0]?.slug;
  if (!slug) throw new Error("the workspace has no slug");
  return slug;
}

export const receiptStore: ReceiptStore = {
  async linkedDeals(connection) {
    const linked = unwrap(
      await db().from("crm_deals").select("id, external_id, deal_id").eq("connection_id", connection.id).not("deal_id", "is", null).eq("source_status", "present").limit(500)
    ) as Array<{ id: string; external_id: string; deal_id: string }>;
    if (linked.length === 0) return [];
    const read = await readDeals();
    if (!read.available) return [];
    const deals = read.deals.filter((deal) => linked.some((row) => row.deal_id === deal.facts.id));
    const today = new Date().toISOString().slice(0, 10);
    // What each deal collected, read as its own page reads it: one figure, wherever it is shown.
    const [collected, shadow] = await Promise.all([readDealCollections(deals, today), db().from("shadow_modes").select("org_id").limit(1)]);
    const shadowOn = !shadow.error && (shadow.data ?? []).length > 0;
    const network: Network = networkOf(currentOrgConfig().network);
    const slug = await workspaceSlug();
    return linked.flatMap((row): LinkedDealFields[] => {
      const deal = deals.find((candidate) => candidate.facts.id === row.deal_id);
      const own = deal ? collected.get(deal.facts.id) : undefined;
      if (!deal || !own) return [];
      return [
        {
          crmDealId: row.id,
          dealId: deal.facts.id,
          externalDealId: row.external_id,
          title: deal.title,
          fields: receiptFields(own.collection, evidenceUrl(siteOrigin(), slug, deal.facts.id)),
          network,
          // Shadow mode, or a deal in the business's own currency, whose invoices only shadow mode converts (D3).
          shadow: shadowOn || own.keepsOriginalCurrency || !paidOnArc(deal.facts.currency),
        },
      ];
    });
  },

  async latest(connectionId, crmDealIds) {
    if (crmDealIds.length === 0) return new Map();
    const rows = await byIds<WriteDbRow>(crmDealIds, (batch) =>
      db().from("crm_receipt_writes").select(WRITE_COLUMNS).eq("connection_id", connectionId).in("crm_deal_id", batch).neq("state", "superseded").order("created_at", { ascending: false })
    );
    const latest = new Map<string, ReceiptWriteRow>();
    for (const row of rows) if (!latest.has(row.crm_deal_id)) latest.set(row.crm_deal_id, toWrite(row));
    return latest;
  },

  async owned(crmDealId) {
    const result = await db().from("crm_receipt_writes").select("read_back").eq("crm_deal_id", crmDealId).eq("state", "written").order("written_at", { ascending: false }).limit(1);
    if (result.error) raise(result.error);
    const row = ((result.data ?? []) as Array<{ read_back: unknown }>)[0];
    return row ? readReceiptFields(row.read_back) : null;
  },

  async unacknowledged(crmDealId, exceptId) {
    const [written, tried] = await Promise.all([
      db().from("crm_receipt_writes").select("created_at").eq("crm_deal_id", crmDealId).eq("state", "written").order("created_at", { ascending: false }).limit(1),
      db()
        .from("crm_receipt_writes")
        .select("id, fields, created_at")
        .eq("crm_deal_id", crmDealId)
        .gt("attempts", 0)
        .in("state", ["failed", "superseded", "conflict"])
        .neq("id", exceptId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (written.error) raise(written.error);
    if (tried.error) raise(tried.error);
    const since = ((written.data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
    return ((tried.data ?? []) as Array<{ fields: unknown; created_at: string }>)
      .filter((row) => since === null || Date.parse(row.created_at) > Date.parse(since))
      .flatMap((row) => {
        const fields = readReceiptFields(row.fields);
        return fields ? [fields] : [];
      });
  },

  async insert(connection, deal, chosen) {
    const result = await db()
      .from("crm_receipt_writes")
      .insert({
        connection_id: connection.id,
        crm_deal_id: deal.crmDealId,
        deal_id: deal.dealId,
        provider: connection.provider,
        external_org_id: connection.externalOrgId,
        external_deal_id: deal.externalDealId,
        fields: deal.fields,
        network: deal.network,
        shadow: deal.shadow,
        ...(chosen?.overwrite ? { overwrite: chosen.overwrite, overwrite_by: chosen.overwriteBy, overwrite_at: chosen.overwriteAt } : {}),
      })
      .select(WRITE_COLUMNS);
    if (result.error) {
      // Another write is in hand for the deal (a run a moment before): this one waits for the next run.
      if (result.error.code === "23505") return null;
      raise(result.error);
    }
    const row = ((result.data ?? []) as unknown as WriteDbRow[])[0];
    return row ? toWrite(row) : null;
  },

  async move(row, from, to, patch, options) {
    let query = db()
      .from("crm_receipt_writes")
      .update({ state: to, ...patchColumns(patch) })
      .eq("id", row.id);
    const others = from.filter((state) => state !== "sending");
    if (from.includes("sending") && options?.leaseOverAt) {
      // A claim takes a write being sent only once that send's lease ran out.
      const lease = `and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${options.leaseOverAt}))`;
      query = query.or(others.length > 0 ? `state.in.(${others.join(",")}),${lease}` : lease);
    } else {
      query = query.in("state", [...from]);
    }
    // Only the write as the caller read it: each claim counts an attempt, so a send whose lease ran out never moves the
    // claim a later run took of the same write.
    query = query.eq("attempts", row.attempts);
    const result = await query.select(WRITE_COLUMNS);
    if (result.error) raise(result.error);
    const moved = ((result.data ?? []) as unknown as WriteDbRow[])[0];
    return moved ? toWrite(moved) : null;
  },

  async due(connectionId, nowIso, limit) {
    const result = await db()
      .from("crm_receipt_writes")
      .select(WRITE_COLUMNS)
      .eq("connection_id", connectionId)
      .or(`state.in.(queued,sent),and(state.eq.failed,or(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})),and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${nowIso}))`)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (result.error) raise(result.error);
    return ((result.data ?? []) as unknown as WriteDbRow[]).map(toWrite);
  },

  async record(entry) {
    await appendLedgerEntryBestEffort(currentOrgId(), entry);
  },
};
