"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LEADS_CSV_MAX_BYTES, LeadsCsvError, type LeadPreviewRow } from "@/lib/growth/csv";
import { campaignSchema, decisionSchema, firstIssue, formFields, linkSchema, revenueSchema, spendSchema, stageSchema } from "@/lib/growth/forms";
import { growthTeamUser } from "@/lib/growth/gate";
import { decideLead, GrowthInputError, importLeads, linkLead, logSpend, previewImport, recordRevenue, saveCampaign, updateLead } from "@/lib/growth/write";
import type { Stage } from "@/lib/growth/fields";

/**
 * The founder dashboard's actions (/admin/growth). An action is a public POST endpoint, so each asks the team gate
 * first, itself, whatever the page did; anyone off the team gets NOT_AVAILABLE and nothing is read or written. Each
 * writes a record for the team only: nothing here sends a message to anyone, and approving a lead records a decision.
 */

export interface GrowthResult {
  ok: boolean;
  message: string;
}

const NOT_AVAILABLE = "This is not available.";
const FAILED = "That did not work. Try again in a moment.";
const NO_LEAD = "That lead no longer exists.";
const PAGE = "/admin/growth";

/** Runs a write, turning a refusal worth saying into its words and anything else into FAILED, logged. */
async function attempt(what: string, write: () => Promise<string>): Promise<GrowthResult> {
  try {
    const message = await write();
    revalidatePath(PAGE);
    return { ok: true, message };
  } catch (error) {
    if (error instanceof GrowthInputError || error instanceof LeadsCsvError) return { ok: false, message: error.message };
    console.error(`growth: ${what} failed`, error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: FAILED };
  }
}

export async function saveCampaignAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = campaignSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("campaign", async () => {
    await saveCampaign(parsed.data);
    return `Campaign ${parsed.data.id} saved.`;
  });
}

export async function logSpendAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = spendSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("spend", async () => {
    await logSpend(parsed.data);
    return "Spend logged.";
  });
}

export async function recordRevenueAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = revenueSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("revenue", async () => {
    await recordRevenue(parsed.data);
    return "Revenue event recorded.";
  });
}

export async function changeLeadStageAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = stageSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("stage", async () => {
    if (!(await updateLead(parsed.data.lead_id, { stage: parsed.data.stage as Stage }, parsed.data.note, user.id))) throw new GrowthInputError(NO_LEAD);
    return "Stage changed and logged.";
  });
}

export async function linkLeadAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = linkSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("link", async () => {
    if (!(await linkLead(parsed.data.lead_id, parsed.data.workspace, parsed.data.note, user.id))) throw new GrowthInputError(NO_LEAD);
    return parsed.data.workspace ? "Workspace linked and logged." : "Workspace unlinked and logged.";
  });
}

export async function decideLeadAction(_previous: GrowthResult, formData: FormData): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = decisionSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return attempt("review", async () => {
    if (!(await decideLead(parsed.data.lead_id, parsed.data.decision, parsed.data.note, user.id))) throw new GrowthInputError(NO_LEAD);
    return parsed.data.decision === "approve" ? "Approved to contact. Nothing was sent." : "Rejected.";
  });
}

const csvSchema = z.string().min(1).max(LEADS_CSV_MAX_BYTES);
const TOO_BIG = "Paste or choose a CSV smaller than 1 MB.";

export async function previewLeadsCsvAction(csv: unknown): Promise<GrowthResult & { rows?: LeadPreviewRow[] }> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = csvSchema.safeParse(csv);
  if (!parsed.success) return { ok: false, message: TOO_BIG };
  try {
    return { ok: true, message: "", rows: await previewImport(parsed.data) };
  } catch (error) {
    if (error instanceof LeadsCsvError) return { ok: false, message: error.message };
    console.error("growth: CSV preview failed", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: FAILED };
  }
}

export async function importLeadsCsvAction(csv: unknown): Promise<GrowthResult> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const parsed = csvSchema.safeParse(csv);
  if (!parsed.success) return { ok: false, message: TOO_BIG };
  return attempt("import", async () => {
    const { added, skipped } = await importLeads(parsed.data, user.id);
    return `${added} ${added === 1 ? "lead" : "leads"} added for review${skipped ? `, ${skipped} not added (duplicates or rows with errors)` : ""}.`;
  });
}
