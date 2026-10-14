import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import type { DealSource } from "../deals/write";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { connectionById, isNotSetUp, NotSetUpError, type Connection } from "./connections";
import { CRM_DEAL_ACTIONS, CRM_DEAL_COLUMNS, rowChanges, rowFacts, type CrmDealRow } from "./crm-store";
import { PROVIDER_LABELS } from "./provider";

/**
 * What a person does with a CRM's deals, written (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11,
 * H12, H13): a planned deal linked to its row and its company to the customer, changes reviewed, and the email the
 * customer's billing email is filled from. The commands in `src/lib/commands/crm.ts` gate them; these run in the
 * workspace's scope and trust nothing from the browser.
 */

export interface CrmRowRead {
  row: CrmDealRow;
  connection: Connection;
}

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error)) throw new NotSetUpError();
  throw new Error(error.message);
}

async function withConnection(row: CrmDealRow | undefined): Promise<CrmRowRead | null> {
  if (!row) return null;
  const connection = await connectionById(row.connection_id);
  return connection ? { row, connection } : null;
}

/** A deal of the list by its row, with its connection; null when it is not this workspace's. */
export async function crmRow(rowId: string): Promise<CrmRowRead | null> {
  const found = await db().from("crm_deals").select(CRM_DEAL_COLUMNS).eq("id", rowId).limit(1);
  if (found.error) raise(found.error);
  return withConnection(((found.data ?? []) as unknown as CrmDealRow[])[0]);
}

/** The deal of the list a Vestiarion deal was planned from, with its connection; null when none was. */
export async function crmRowForDeal(dealId: string): Promise<CrmRowRead | null> {
  const found = await db().from("crm_deals").select(CRM_DEAL_COLUMNS).eq("deal_id", dealId).limit(1);
  if (found.error) raise(found.error);
  return withConnection(((found.data ?? []) as unknown as CrmDealRow[])[0]);
}

/** The CRM's ids a deal's entries carry (HubSpot connector H19, Pipedrive connector P19). */
export function sourceOf({ row, connection }: CrmRowRead): DealSource {
  if (connection.provider === "pipedrive") {
    return { provider: "pipedrive", ids: { companyId: connection.externalOrgId, dealId: row.external_id, organizationId: row.company_external_id } };
  }
  return { provider: "hubspot", ids: { hubId: connection.externalOrgId, dealId: row.external_id, companyId: row.company_external_id } };
}

/** The CRMs whose companies a customer may be linked to, for the email it may be filled from. */
const EMAIL_PROVIDERS = ["hubspot", "pipedrive"] as const;

type EmailSource = { provider: "hubspot"; ids: { hubId: string; companyId: string } } | { provider: "pipedrive"; ids: { companyId: string; organizationId: string } };

const emailSource = (connection: Connection, companyId: string): EmailSource =>
  connection.provider === "pipedrive"
    ? { provider: "pipedrive", ids: { companyId: connection.externalOrgId, organizationId: companyId } }
    : { provider: "hubspot", ids: { hubId: connection.externalOrgId, companyId } };

/**
 * Links a row to the deal planned from it, with the CRM's facts now as its baseline, and the company to the customer
 * (`external_links`, object `company`) unless either is linked already. Best effort beyond the row: the deal stands.
 */
export async function linkPlanned(read: CrmRowRead, dealId: string, customerId: string): Promise<void> {
  const { row, connection } = read;
  unwrap(
    await db()
      .from("crm_deals")
      .update({ deal_id: dealId, linked_at: new Date().toISOString(), baseline: rowFacts(row), flagged: null })
      .eq("id", row.id)
      .or(`deal_id.is.null,deal_id.eq.${dealId}`)
      .select("id")
  );
  if (!row.company_external_id) return;
  const existing = unwrap(
    await db()
      .from("external_links")
      .select("id, local_id")
      .eq("connection_id", connection.id)
      .eq("object_type", "company")
      .eq("external_id", row.company_external_id)
      .limit(1)
  ) as Array<{ id: string; local_id: string | null }>;
  if (existing[0]?.local_id) return;
  const values = { local_id: customerId, linked_at: new Date().toISOString(), label: row.company_name, updated_at: new Date().toISOString() };
  const result = existing[0]
    ? await db().from("external_links").update(values).eq("id", existing[0].id).is("local_id", null).select("id")
    : await db()
        .from("external_links")
        .insert({ connection_id: connection.id, provider: connection.provider, external_org_id: connection.externalOrgId, object_type: "company", external_id: row.company_external_id, ...values })
        .select("id");
  // The customer may be linked to another company already: it keeps that link.
  if (result.error) console.error("connector: a CRM company was not linked to its customer", row.id, result.error.message);
}

/** Marks a planned deal's changes as reviewed: the CRM's facts now become its baseline. */
export async function reviewChanges(read: CrmRowRead, by: string): Promise<void> {
  unwrap(
    await db()
      .from("crm_deals")
      .update({ baseline: rowFacts(read.row), flagged: null, reviewed_at: new Date().toISOString(), reviewed_by: by })
      .eq("id", read.row.id)
      .select("id")
  );
}

/** Keeps a deal as it is despite its changes in the CRM, with a signed `crm_deal_change_kept`. Null when nothing changed. */
export async function keepChanges(read: CrmRowRead, deal: { id: string; title: string; status: "active" | "cancelled" }, by: string): Promise<number | null> {
  const changes = rowChanges(read.row, deal.status);
  if (changes.length === 0) return null;
  await reviewChanges(read, by);
  const label = PROVIDER_LABELS[read.connection.provider];
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: CRM_DEAL_ACTIONS.kept,
    summary: `Kept the deal ${deal.title} as it is after ${label} changed it`,
    detail: { by, provider: read.connection.provider, connectionId: read.connection.id, crmDealId: read.row.external_id, dealId: deal.id, changes },
  });
  return changes.length;
}

/**
 * The email a customer's billing email may be filled from (H13): its company's main contact's, from the latest deal
 * read, while the customer has none. Null otherwise.
 */
export async function emailToFill(counterpartyId: string): Promise<{ email: string; name: string; source: EmailSource } | null> {
  const customer = unwrap(await db().from("counterparties").select("id, name, notice_email").eq("id", counterpartyId).limit(1)) as Array<{ id: string; name: string; notice_email: string | null }>;
  if (!customer[0] || customer[0].notice_email?.trim()) return null;
  const links = unwrap(
    await db().from("external_links").select("connection_id, external_id").eq("object_type", "company").in("provider", [...EMAIL_PROVIDERS]).eq("local_id", counterpartyId).limit(5)
  ) as Array<{ connection_id: string; external_id: string }>;
  for (const link of links) {
    const connection = await connectionById(link.connection_id);
    if (!connection || connection.status === "revoked") continue;
    const rows = unwrap(
      await db()
        .from("crm_deals")
        .select("company_email")
        .eq("connection_id", link.connection_id)
        .eq("company_external_id", link.external_id)
        .not("company_email", "is", null)
        .order("external_updated_at", { ascending: false })
        .limit(1)
    ) as Array<{ company_email: string }>;
    if (rows[0]) return { email: rows[0].company_email, name: customer[0].name, source: emailSource(connection, link.external_id) };
  }
  return null;
}

