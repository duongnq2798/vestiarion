import "server-only";
import { z } from "zod";
import { platformDb } from "@/lib/dal";
import { leadsToCsv, previewLeadsCsv, LEAD_EXPORT_HEADERS, type LeadPreviewRow, type NewLead } from "./csv";
import { stageIndex } from "./metrics";
import { readAll, type Campaign, type Lead } from "./read";
import type { CampaignInput, RevenueInput, SpendInput } from "./forms";
import type { Stage } from "./fields";

/**
 * The founder dashboard's writes, each a record for the team and nothing more: no message goes to anyone, and approving
 * a lead records a decision only. Every change to a lead goes through growth_update_lead or growth_import_leads
 * (migration 0099), so its trigger logs it with the note and the team member who made it. Only the actions in
 * src/app/admin/growth/actions.ts call these, after the team gate.
 */

/** A refusal worth saying in words, as opposed to a database failure, which stays in the log. */
export class GrowthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowthInputError";
  }
}

function check(error: { message: string; code?: string } | null, what: string): void {
  if (!error) return;
  if (error.code === "23503") throw new GrowthInputError(`${what}: it names something that does not exist.`);
  throw new Error(`${what}: ${error.message}`);
}

/** Adds a campaign, or changes the one with that id. */
export async function saveCampaign(input: CampaignInput): Promise<void> {
  const { error } = await platformDb().from("growth_campaigns").upsert(input, { onConflict: "id" });
  check(error, "campaign not saved");
}

export async function logSpend(input: SpendInput): Promise<void> {
  const { error } = await platformDb().from("growth_spend").insert(input);
  check(error, "spend not logged");
}

/** A workspace's id from its slug or its id, or null when there is none. */
export async function workspaceId(slugOrId: string): Promise<string | null> {
  const column = z.string().uuid().safeParse(slugOrId).success ? "id" : "slug";
  const { data, error } = await platformDb().from("orgs").select("id").eq(column, slugOrId.toLowerCase()).maybeSingle();
  if (error) throw new Error(`workspace not read: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

export async function recordRevenue(input: RevenueInput): Promise<void> {
  const { workspace, ...row } = input;
  const orgId = workspace ? await workspaceId(workspace) : null;
  if (workspace && !orgId) throw new GrowthInputError(`No workspace ${workspace}.`);
  const { error } = await platformDb().from("growth_revenue").insert({ ...row, org_id: orgId });
  check(error, "revenue not recorded");
}

type LeadChanges = Partial<{ stage: Stage; review_status: string; campaign_id: string | null; org_id: string | null; source: string }>;

/** Changes a lead's tracked fields through growth_update_lead, so each change is logged; false when there is no such lead. */
export async function updateLead(leadId: string, changes: LeadChanges, note: string | null, by: string): Promise<boolean> {
  const { data, error } = await platformDb().rpc("growth_update_lead", { p_lead: leadId, p_changes: changes, p_note: note, p_by: by });
  check(error, "lead not changed");
  return data === true;
}

export async function linkLead(leadId: string, workspace: string | null, note: string | null, by: string): Promise<boolean> {
  const orgId = workspace ? await workspaceId(workspace) : null;
  if (workspace && !orgId) throw new GrowthInputError(`No workspace ${workspace}.`);
  return updateLead(leadId, { org_id: orgId }, note, by);
}

/**
 * Approving records that the team may contact the lead, and moves it to contact_approved unless it is already there or
 * further, or out of the order (disqualified, lost). Rejecting records the review only. Neither contacts anyone.
 */
export async function decideLead(leadId: string, decision: "approve" | "reject", note: string | null, by: string): Promise<boolean> {
  const { data, error } = await platformDb().from("growth_leads").select("stage").eq("id", leadId).maybeSingle();
  if (error) throw new Error(`lead not read: ${error.message}`);
  if (!data) return false;
  const stage = (data as { stage: Stage }).stage;
  if (decision === "reject") return updateLead(leadId, { review_status: "rejected" }, note, by);
  const moves = stageIndex(stage) >= 0 && stageIndex(stage) < stageIndex("contact_approved");
  return updateLead(leadId, { review_status: "approved_to_contact", ...(moves ? { stage: "contact_approved" as const } : {}) }, note, by);
}

/** The file read against the leads and campaigns there are now. */
export async function previewImport(csv: string): Promise<LeadPreviewRow[]> {
  const [leads, campaigns] = await Promise.all([readAll<Pick<Lead, "dedupe_key">>("growth_leads", "created_at"), readAll<Pick<Campaign, "id">>("growth_campaigns", "created_at")]);
  return previewLeadsCsv(csv, new Set(leads.map((lead) => lead.dedupe_key)), new Set(campaigns.map((campaign) => campaign.id)));
}

/**
 * Saves the rows the preview reads as new, read again now; a lead someone added meanwhile is left as it is, since
 * growth_import_leads skips a dedupe key that is taken. Returns how many were added and how many were not.
 */
export async function importLeads(csv: string, by: string): Promise<{ added: number; skipped: number }> {
  const rows = await previewImport(csv);
  const fresh: NewLead[] = rows.flatMap((row) => (row.status === "new" ? [row.lead] : []));
  if (fresh.length === 0) return { added: 0, skipped: rows.length };
  const { data, error } = await platformDb().rpc("growth_import_leads", { p_rows: fresh, p_by: by });
  check(error, "leads not imported");
  const added = z.array(z.string()).parse(data).length;
  return { added, skipped: rows.length - added };
}

/** Every lead as a CSV, oldest first, with where each stands. */
export async function exportLeads(): Promise<string> {
  const leads = await readAll<Record<(typeof LEAD_EXPORT_HEADERS)[number], unknown>>("growth_leads", "created_at");
  return leadsToCsv(leads);
}
