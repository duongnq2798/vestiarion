import { createHash } from "node:crypto";
import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { changesText, crmChanges, flagDecision, readFacts, type CrmChange, type CrmFacts, type CrmProvider, type ExternalDeal, type StagedCrmDeal, type StageState } from "./crm";
import { NotSetUpError } from "./connections";
import { receiptsInScope } from "./crm-receipts-sync";
import { syncCrmConnection, type CrmSyncDb, type CrmSyncResult } from "./crm-sync";
import { PROVIDER_LABELS } from "./provider";
import { syncStore } from "./sync-store";
import { connectionTokenStore } from "./token-store";
import { recordUsage } from "../usage/record";

/**
 * The CRM runner's database (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H2, H7, H10, H12), in the
 * workspace's own scope through the DAL: the deals read (`crm_deals`), their links to Vestiarion deals, and the changes
 * of linked deals recorded once in the ledger. The connection's lease, its cursor and how each run ended are the
 * accounting store's own. No token is read here.
 */

export const CRM_DEAL_ACTIONS = { changed: "crm_deal_changed", kept: "crm_deal_change_kept" } as const;

/** A numeric column as an exact decimal: `12500.000000` or `12500` as "12500". */
export function amountText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const written = typeof value === "number" ? String(Number(value.toFixed(6))) : String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(written);
  if (!match) return null;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${match[1]}.${fraction}` : match[1];
}

export interface CrmDealRow {
  id: string;
  connection_id: string;
  external_id: string;
  name: string;
  amount: number | string | null;
  currency: string | null;
  close_on: string | null;
  pipeline_label: string | null;
  stage_label: string | null;
  stage_state: StageState;
  company_external_id: string | null;
  company_name: string | null;
  company_email: string | null;
  source_status: "present" | "deleted";
  deal_id: string | null;
  baseline: unknown;
  flagged: unknown;
  external_updated_at: string | null;
}

export const CRM_DEAL_COLUMNS =
  "id, connection_id, external_id, name, amount, currency, close_on, pipeline_label, stage_label, stage_state, company_external_id, company_name, company_email, source_status, deal_id, baseline, flagged, external_updated_at";

/** A row's facts as the CRM had them at its last read. */
export function rowFacts(row: Pick<CrmDealRow, "amount" | "currency" | "close_on" | "stage_state" | "stage_label">): CrmFacts {
  return { amount: amountText(row.amount), currency: row.currency, closeOn: row.close_on ? String(row.close_on).slice(0, 10) : null, stage: row.stage_state, stageLabel: row.stage_label };
}

/** What changed in the CRM since the row's deal was planned or its changes last reviewed. */
export function rowChanges(row: CrmDealRow, dealStatus: "active" | "cancelled"): CrmChange[] {
  return crmChanges(readFacts(row.baseline), { ...rowFacts(row), deleted: row.source_status === "deleted" }, dealStatus);
}

/**
 * The changes a page showed, as the form sends them back (H12): Keep the deal as it is and Change deal act on exactly
 * these, never on a set the CRM made since. A digest, so no amount or currency travels in the form.
 */
export function changesKey(changes: readonly CrmChange[]): string {
  return createHash("sha256").update(changesText(changes)).digest("hex");
}

function dealFacts(deal: ExternalDeal) {
  return {
    name: deal.name,
    amount: deal.amount,
    currency: deal.currency,
    close_on: deal.closeOn,
    pipeline_id: deal.pipelineId,
    pipeline_label: deal.pipelineLabel,
    stage_id: deal.stageId,
    stage_label: deal.stageLabel,
    stage_state: deal.stage,
    company_external_id: deal.company?.externalId ?? null,
    company_name: deal.company?.name ?? null,
    company_email: deal.company?.email ?? null,
    source_status: "present",
    external_version: deal.version,
    external_updated_at: deal.updatedAt,
  };
}

/**
 * The deal's owner (collections context C5), written apart from its facts so a database before migration 0110, which
 * has no column for it, keeps reading deals: there the owner is left out, and nothing else changes.
 */
async function writeOwner(rowId: string, deal: ExternalDeal): Promise<void> {
  if (deal.ownerId === undefined) return;
  const written = await db().from("crm_deals").update({ owner_external_id: deal.ownerId }).eq("id", rowId);
  if (written.error && written.error.code !== "42703" && written.error.code !== "PGRST204") throw new Error(written.error.message);
}

const KINDS: Record<CrmChange["what"], string> = { amount: "amount", close: "close date", stage: "stage", deleted: "deleted" };

export const crmStore: CrmSyncDb = {
  claim: (connectionId, nowIso, untilIso) => syncStore.claim(connectionId, nowIso, untilIso),
  readCursor: (connectionId, type) => syncStore.readCursor(connectionId, type),
  writeCursor: (connectionId, type, cursor) => syncStore.writeCursor(connectionId, type, cursor),
  finish: (connectionId, outcome) => syncStore.finish(connectionId, outcome),

  async staged(connectionId, externalIds) {
    if (externalIds.length === 0) return new Map();
    const rows = unwrap(
      await db().from("crm_deals").select("id, external_id, external_version, source_status, deal_id").eq("connection_id", connectionId).in("external_id", [...externalIds])
    ) as Array<{ id: string; external_id: string; external_version: string | null; source_status: StagedCrmDeal["sourceStatus"]; deal_id: string | null }>;
    return new Map(rows.map((row) => [row.external_id, { id: row.id, externalVersion: row.external_version, sourceStatus: row.source_status, dealId: row.deal_id }]));
  },

  async insertDeal(connection, deal) {
    // A row already there (a run that stopped after writing it) is left for the next update to follow.
    const rows = unwrap(
      await db()
        .from("crm_deals")
        .upsert({ connection_id: connection.id, external_id: deal.externalId, ...dealFacts(deal) }, { onConflict: "org_id,connection_id,external_id", ignoreDuplicates: true })
        .select("id")
    ) as Array<{ id: string }>;
    if (rows[0]) await writeOwner(rows[0].id, deal);
  },

  async updateDeal(_connection, row, deal) {
    unwrap(await db().from("crm_deals").update({ ...dealFacts(deal), changed_at: new Date().toISOString() }).eq("id", row.id).select("id"));
    await writeOwner(row.id, deal);
  },

  async linkReferences(connection, externalIds) {
    if (externalIds.length === 0) return;
    const deals = unwrap(await db().from("deals").select("id, external_ref").in("external_ref", [...externalIds])) as Array<{ id: string; external_ref: string }>;
    if (deals.length === 0) return;
    const rows = unwrap(
      await db()
        .from("crm_deals")
        .select("id, external_id, amount, currency, close_on, stage_state, stage_label")
        .eq("connection_id", connection.id)
        .in("external_id", deals.map((deal) => deal.external_ref))
        .is("deal_id", null)
    ) as Array<Pick<CrmDealRow, "id" | "external_id" | "amount" | "currency" | "close_on" | "stage_state" | "stage_label">>;
    for (const row of rows) {
      const deal = deals.find((candidate) => candidate.external_ref === row.external_id);
      if (!deal) continue;
      // A reference typed by hand as the CRM's deal id: linked, with the CRM's facts now as its baseline (H10).
      const linked = await db()
        .from("crm_deals")
        .update({ deal_id: deal.id, linked_at: new Date().toISOString(), baseline: rowFacts(row), flagged: null })
        .eq("id", row.id)
        .is("deal_id", null)
        .select("id");
      if (linked.error) console.error("connector: a CRM deal was not linked to its deal", row.id, linked.error.message);
    }
  },

  async recheckDeals(connectionId, limit) {
    const linked = unwrap(
      await db().from("crm_deals").select("external_id").eq("connection_id", connectionId).not("deal_id", "is", null).order("linked_at", { ascending: false }).limit(limit)
    ) as Array<{ external_id: string }>;
    const room = limit - linked.length;
    const offered =
      room > 0
        ? (unwrap(
            await db()
              .from("crm_deals")
              .select("external_id")
              .eq("connection_id", connectionId)
              .is("deal_id", null)
              .eq("stage_state", "won")
              .order("changed_at", { ascending: false })
              .limit(room)
          ) as Array<{ external_id: string }>)
        : [];
    return [...linked.map((row) => ({ externalId: row.external_id, linked: true })), ...offered.map((row) => ({ externalId: row.external_id, linked: false }))];
  },

  async markDeleted(connection, externalIds) {
    if (externalIds.length === 0) return 0;
    const rows = unwrap(
      await db()
        .from("crm_deals")
        .update({ source_status: "deleted", changed_at: new Date().toISOString() })
        .eq("connection_id", connection.id)
        .in("external_id", [...externalIds])
        .eq("source_status", "present")
        .select("id")
    ) as Array<{ id: string }>;
    return rows.length;
  },

  async flagChanges(connection, externalIds) {
    if (externalIds.length === 0) return 0;
    const rows = unwrap(
      await db().from("crm_deals").select(CRM_DEAL_COLUMNS).eq("connection_id", connection.id).in("external_id", [...externalIds]).not("deal_id", "is", null)
    ) as CrmDealRow[];
    if (rows.length === 0) return 0;
    const deals = unwrap(await db().from("deals").select("id, title, status").in("id", rows.map((row) => row.deal_id as string))) as Array<{ id: string; title: string; status: "active" | "cancelled" }>;
    const label = PROVIDER_LABELS[connection.provider];
    let recorded = 0;
    for (const row of rows) {
      const deal = deals.find((candidate) => candidate.id === row.deal_id);
      if (!deal) continue;
      const changes = rowChanges(row, deal.status);
      const decision = flagDecision(changes, row.flagged);
      if (decision === "none") continue;
      unwrap(await db().from("crm_deals").update({ flagged: decision === "record" ? changes : null }).eq("id", row.id).select("id"));
      if (decision === "clear") continue;
      recorded += 1;
      await appendLedgerEntryBestEffort(currentOrgId(), {
        actor: "system",
        domain: "ar",
        action: CRM_DEAL_ACTIONS.changed,
        summary: `${label} changed the deal ${deal.title} after it was planned: ${changes.map((change) => KINDS[change.what]).join(", ")}. Nothing in Vestiarion changed`,
        detail: {
          provider: connection.provider,
          connectionId: connection.id,
          externalOrgId: connection.externalOrgId,
          crmDealId: row.external_id,
          dealId: deal.id,
          changes,
        },
      });
    }
    return recorded;
  },
};

/**
 * Runs one CRM connection's sync in the workspace already in scope, with the database's stores; then its receipts
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R5): written back to the deals planned from it, while a
 * person has writing on. Best effort: a receipts step that fails never fails the sync, and before migration 0107 it has
 * nothing to do.
 */
export async function crmSyncInScope(connectionId: string, provider: CrmProvider, options: { maxPages?: number } = {}): Promise<CrmSyncResult> {
  const result = await syncCrmConnection({ connectionId, provider, db: crmStore, tokens: connectionTokenStore(currentOrgId(), connectionId), ...options });
  // Metered as an accounting tool's sync is (accountant console U1).
  if (result.outcome !== "busy") await recordUsage({ kind: "connector_sync", action: provider.id, provider: provider.id, ok: result.outcome === "synced" || result.outcome === "partial" });
  if (provider.receipts && result.outcome !== "reconnect" && result.outcome !== "busy") {
    try {
      await receiptsInScope(connectionId, provider);
    } catch (error) {
      if (!(error instanceof NotSetUpError)) console.error("crm: the receipts step failed", connectionId, error instanceof Error ? error.message : "unknown error");
    }
  }
  return result;
}
