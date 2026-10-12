import { db, unwrap } from "../dal";
import { connectionById, connectionFor, isNotSetUp, NotSetUpError, type Connection } from "./connections";
import { crmChangeWords, moneyWords, plannable, type CrmChange } from "./crm";
import { changePrefill, dealPrefill, type ChangePrefill, type DealPrefill } from "./crm-prefill";
import { amountText, changesKey, CRM_DEAL_COLUMNS, rowChanges, type CrmDealRow } from "./crm-store";
import { pagesRead, type SyncCursor } from "./cursors";
import { PROVIDER_LABELS, type ProviderId } from "./provider";
import { connectionStatus, type StatusView } from "./status";

/**
 * What a CRM's deals look like to a person (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11, H12,
 * H13, H16, H17, H20), read in the workspace's scope: the list on Bills & receivables, the card in Settings, a deal's
 * changes on its page, and the New deal form's prefill. Nothing here writes; nothing carries a token.
 */

/** Throws `NotSetUpError` before migration 0105 has run (H17). */
export async function crmReady(): Promise<void> {
  const probe = await db().from("crm_deals").select("id").limit(1);
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}

/** A deal of the list, as the browser shows it. */
export interface CrmRowView {
  id: string;
  name: string;
  company: string | null;
  /** In its currency for a person; null for none, or a currency never named. */
  amount: string | null;
  closeOn: string | null;
  stage: string | null;
  plan: { ok: true } | { ok: false; reason: string };
  linkedDeal: { id: string; title: string; status: "active" | "cancelled" } | null;
  /** What changed in the CRM since the deal was planned, in words. */
  changes: string[];
}

/** A customer's billing email the CRM has, for a person to confirm (H13). */
export interface CrmEmailView {
  counterpartyId: string;
  name: string;
  email: string;
}

export type CrmReviewView =
  | { state: "hidden" }
  | { state: "list"; connectionId: string; label: string; organisation: string | null; won: CrmRowView[]; open: CrmRowView[]; emails: CrmEmailView[] };

/** The most deals the list reads. */
export const MAX_LISTED = 300;

type LinkedDeal = { id: string; title: string; status: "active" | "cancelled" };

function rowView(row: CrmDealRow, linked: LinkedDeal | null, label: string): CrmRowView {
  const amount = amountText(row.amount);
  const changes: CrmChange[] = linked ? rowChanges(row, linked.status) : [];
  return {
    id: row.id,
    name: row.name,
    company: row.company_name,
    amount: amount === null ? null : moneyWords(amount, row.currency),
    closeOn: row.close_on ? String(row.close_on).slice(0, 10) : null,
    stage: row.stage_label,
    plan: plannable(
      { stage: row.stage_state, sourceStatus: row.source_status, dealId: row.deal_id, amount, companyExternalId: row.company_external_id },
      label
    ),
    linkedDeal: linked,
    changes: changes.map((change) => crmChangeWords(change, label)),
  };
}

async function linkedDeals(rows: readonly CrmDealRow[]): Promise<Map<string, LinkedDeal>> {
  const ids = rows.flatMap((row) => (row.deal_id ? [row.deal_id] : []));
  if (ids.length === 0) return new Map();
  const deals = unwrap(await db().from("deals").select("id, title, status").in("id", ids)) as LinkedDeal[];
  return new Map(deals.map((deal) => [deal.id, deal]));
}

/** The CRM's list on Bills & receivables: hidden before migration 0105, without a connection, and once disconnected. */
export async function crmReview(connection: Connection | null): Promise<CrmReviewView> {
  if (!connection || connection.status === "revoked") return { state: "hidden" };
  const label = PROVIDER_LABELS[connection.provider];
  const rows = unwrap(
    await db()
      .from("crm_deals")
      .select(CRM_DEAL_COLUMNS)
      .eq("connection_id", connection.id)
      .or("stage_state.neq.lost,deal_id.not.is.null")
      .order("close_on", { ascending: false, nullsFirst: false })
      .limit(MAX_LISTED)
  ) as CrmDealRow[];
  const deals = await linkedDeals(rows);
  const views = rows.map((row) => ({ row, view: rowView(row, row.deal_id ? (deals.get(row.deal_id) ?? null) : null, label) }));
  // A deal planned is listed whatever happens to it in the CRM; one not planned only while the CRM still has it.
  const won = views.filter(({ row }) => row.deal_id !== null || (row.stage_state === "won" && row.source_status === "present")).map(({ view }) => view);
  const open = views.filter(({ row }) => row.deal_id === null && row.stage_state === "open" && row.source_status === "present").map(({ view }) => view);
  return { state: "list", connectionId: connection.id, label, organisation: connection.externalOrgName, won, open, emails: await emailsToConfirm(connection, rows) };
}

/**
 * Linked customers without a billing email whose company's main contact has one (H13): the email of the deal HubSpot
 * gave last, as `emailToFill` takes it, so Use this email fills the one shown.
 */
async function emailsToConfirm(connection: Connection, rows: readonly CrmDealRow[]): Promise<CrmEmailView[]> {
  const latest = new Map<string, { email: string; at: string }>();
  for (const row of rows) {
    if (!row.company_external_id || !row.company_email) continue;
    const at = row.external_updated_at ? new Date(row.external_updated_at).toISOString() : "";
    const kept = latest.get(row.company_external_id);
    if (!kept || at > kept.at) latest.set(row.company_external_id, { email: row.company_email, at });
  }
  const byCompany = new Map([...latest].map(([company, { email }]) => [company, email]));
  if (byCompany.size === 0) return [];
  const links = unwrap(
    await db()
      .from("external_links")
      .select("external_id, local_id")
      .eq("connection_id", connection.id)
      .eq("object_type", "company")
      .not("local_id", "is", null)
      .in("external_id", [...byCompany.keys()])
  ) as Array<{ external_id: string; local_id: string }>;
  if (links.length === 0) return [];
  const customers = unwrap(
    await db().from("counterparties").select("id, name, notice_email").in("id", links.map((link) => link.local_id))
  ) as Array<{ id: string; name: string; notice_email: string | null }>;
  return links.flatMap((link) => {
    const customer = customers.find((candidate) => candidate.id === link.local_id);
    const email = byCompany.get(link.external_id);
    return customer && email && !customer.notice_email?.trim() ? [{ counterpartyId: customer.id, name: customer.name, email }] : [];
  });
}

export type CrmPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | {
      state: "connection";
      connectionId: string;
      status: StatusView;
      connected: boolean;
      revoked: boolean;
      organisation: string | null;
      /** Won deals that can be planned now. */
      toPlan: number;
      /** Planned deals changed in the CRM since. */
      changed: number;
    };

/**
 * Planned deals with changes recorded, whose Vestiarion deal is not cancelled (H12): a deal cancelled since shows none,
 * though its record is cleared only at the next sync.
 */
async function changedPlanned(connectionId: string): Promise<number> {
  const flagged = unwrap(
    await db().from("crm_deals").select("deal_id").eq("connection_id", connectionId).not("deal_id", "is", null).not("flagged", "is", null).limit(MAX_LISTED)
  ) as Array<{ deal_id: string }>;
  if (flagged.length === 0) return 0;
  const deals = unwrap(await db().from("deals").select("id, status").in("id", flagged.map((row) => row.deal_id))) as Array<{ id: string; status: string }>;
  return deals.filter((deal) => deal.status !== "cancelled").length;
}

/** The CRM's card in Settings (H16, H17). */
export async function crmPanelView(provider: ProviderId, nowMs: number = Date.now()): Promise<CrmPanelView> {
  let connection;
  try {
    connection = await connectionFor(provider);
    await crmReady();
  } catch (error) {
    if (error instanceof NotSetUpError) return { state: "not_set_up" };
    throw error;
  }
  if (!connection) return { state: "not_connected" };
  const revoked = connection.status === "revoked";
  const count = (result: { count: number | null }) => result.count ?? 0;
  const [toPlan, changed, cursors] = await Promise.all([
    revoked
      ? 0
      : db()
          .from("crm_deals")
          .select("id", { count: "exact", head: true })
          .eq("connection_id", connection.id)
          .eq("stage_state", "won")
          .eq("source_status", "present")
          .is("deal_id", null)
          .not("amount", "is", null)
          .gt("amount", 0)
          .not("company_external_id", "is", null)
          .then(count),
    revoked ? 0 : changedPlanned(connection.id),
    db().from("accounting_sync_cursors").select("page").eq("connection_id", connection.id).not("page", "is", null),
  ]);
  const read = ((cursors.data ?? []) as Array<{ page: number }>).reduce((sum, row) => sum + pagesRead({ page: row.page } as SyncCursor), 0);
  return {
    state: "connection",
    connectionId: connection.id,
    status: connectionStatus(
      {
        providerLabel: PROVIDER_LABELS[provider],
        status: connection.status,
        externalOrgName: connection.externalOrgName,
        lastSyncedAt: connection.lastSyncedAt,
        lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt,
        syncing: read > 0 ? { pagesRead: read } : null,
      },
      nowMs
    ),
    connected: connection.status === "connected",
    revoked,
    organisation: connection.externalOrgName,
    toPlan,
    changed,
  };
}

/** A planned deal's changes in the CRM, for its page (H12): what changed, in words, and the Change deal form's start. */
export interface CrmDealChanges {
  rowId: string;
  label: string;
  changes: CrmChange[];
  words: string[];
  prefill: ChangePrefill;
  /** These changes' `changesKey`, sent back by Keep the deal as it is and Change deal, which act on them alone. */
  seen: string;
}

export async function crmChangesFor(deal: { id: string; status: "active" | "cancelled"; currency: string }): Promise<CrmDealChanges | null> {
  const found = await db().from("crm_deals").select(CRM_DEAL_COLUMNS).eq("deal_id", deal.id).limit(1);
  if (found.error) {
    if (isNotSetUp(found.error)) return null;
    throw new Error(found.error.message);
  }
  const row = ((found.data ?? []) as unknown as CrmDealRow[])[0];
  if (!row) return null;
  const connection = await connectionById(row.connection_id);
  if (!connection) return null;
  const label = PROVIDER_LABELS[connection.provider];
  const changes = rowChanges(row, deal.status);
  if (changes.length === 0) return null;
  return {
    rowId: row.id,
    label,
    changes,
    words: changes.map((change) => crmChangeWords(change, label)),
    prefill: changePrefill(changes, { currency: deal.currency }, label),
    seen: changesKey(changes),
  };
}

/** A deal of the list as the New deal form, prefilled (H11); or why it cannot be planned now. */
export type CrmPrefillRead =
  | { ok: true; rowId: string; label: string; name: string; prefill: DealPrefill }
  | { ok: false; message: string };

export async function crmPrefillFor(input: {
  rowId: string;
  customers: ReadonlyArray<{ id: string; name: string }>;
  workspace: { shadowOn: boolean };
  today: string;
}): Promise<CrmPrefillRead> {
  const found = await db().from("crm_deals").select(CRM_DEAL_COLUMNS).eq("id", input.rowId).limit(1);
  if (found.error) {
    if (isNotSetUp(found.error)) return { ok: false, message: "Deals from a CRM are not set up on this deployment yet." };
    throw new Error(found.error.message);
  }
  const row = ((found.data ?? []) as unknown as CrmDealRow[])[0];
  const connection = row ? await connectionById(row.connection_id) : null;
  if (!row || !connection || connection.status === "revoked") return { ok: false, message: "That deal is no longer in the list." };
  const label = PROVIDER_LABELS[connection.provider];
  const amount = amountText(row.amount);
  const check = plannable({ stage: row.stage_state, sourceStatus: row.source_status, dealId: row.deal_id, amount, companyExternalId: row.company_external_id }, label);
  if (!check.ok) return { ok: false, message: `${row.name} cannot be planned: ${check.reason.toLowerCase()}.` };
  // The customers this account's companies are linked to: this company's, and the others', which a name never takes.
  const links = unwrap(
    await db()
      .from("external_links")
      .select("external_id, local_id")
      .eq("connection_id", connection.id)
      .eq("object_type", "company")
      .not("local_id", "is", null)
      .limit(5000)
  ) as Array<{ external_id: string; local_id: string }>;
  const own = links.find((link) => link.external_id === row.company_external_id);
  const prefill = dealPrefill({
    deal: {
      externalId: row.external_id,
      name: row.name,
      amount,
      currency: row.currency,
      closeOn: row.close_on ? String(row.close_on).slice(0, 10) : null,
      company: row.company_external_id ? { externalId: row.company_external_id, name: row.company_name ?? "Unnamed company" } : null,
    },
    linkedCustomerId: own?.local_id ?? null,
    customers: input.customers,
    linkedElsewhere: new Set(links.filter((link) => link.external_id !== row.company_external_id).map((link) => link.local_id)),
    workspace: input.workspace,
    today: input.today,
    label,
  });
  return { ok: true, rowId: row.id, label, name: row.name, prefill };
}
