import { CYCLE_IN_PROGRESS_MS } from "../agent/balances";
import { currentOrgId } from "../context";
import { db, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { DOCUMENT_REQUESTS_SETTINGS, documentRequestsSettingOf, type DocumentRequestsSetting } from "./rules";

/**
 * Whether the agent asks vendors for a bill's missing document (docs/superpowers/specs/2026-10-23-document-requests-design.md
 * ER1): off by default; shadow records which vendors it would ask and sends nothing (ER3); on asks them (ER4). An owner
 * (`approval.policy`) changes it in Settings, beside the payee lock; who may is the caller's check. Every export runs
 * inside an organization scope. In shadow and on, the cycle also checks each document a vendor sends, or a member
 * attaches, against its bill, once migration 0144 has run
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK1).
 */

/**
 * The column is 0142's: before it runs, a select names a column the table does not have (42703, Postgres's own), and
 * an upsert one PostgREST's schema cache does not know (PGRST204). Only those codes: any other failure throws.
 */
export function documentRequestsColumnMissing(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/** The workspace's setting, and whether its database has it at all (`ready`); off with no row, and before 0142. */
export async function readDocumentRequestsSetting(orgDb: OrgDb): Promise<{ setting: DocumentRequestsSetting; ready: boolean }> {
  const result = await orgDb.from("approval_policies").select("document_requests").limit(1);
  if (result.error) {
    if (documentRequestsColumnMissing(result.error)) return { setting: "off", ready: false };
    throw new Error(`approval_policies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Array<{ document_requests: string | null }>)[0];
  return { setting: documentRequestsSettingOf(row?.document_requests), ready: true };
}

/** Postgres's or PostgREST's "no such table or column": migration 0144 has not run here yet (document checks DK15). */
function checksMissing(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

/** The setting, and whether this workspace's database checks documents (`checks`: migration 0144 ran). */
export interface DocumentChecksStatus {
  setting: DocumentRequestsSetting;
  ready: boolean;
  checks: boolean;
}

/**
 * The setting, and whether documents are checked here (DK11, DK15): migration 0144's columns are there. Settings' copy,
 * Attach a document, the cycle event and the members' email follow `checks`. Any other failure throws.
 */
export async function readDocumentChecksStatus(orgDb: OrgDb): Promise<DocumentChecksStatus> {
  const status = await readDocumentRequestsSetting(orgDb);
  if (!status.ready) return { ...status, checks: false };
  const probe = await orgDb.from("document_requests").select("checked_at").limit(1);
  if (probe.error) {
    if (checksMissing(probe.error)) return { ...status, checks: false };
    throw new Error(`document_requests not read: ${probe.error.message}`);
  }
  return { ...status, checks: true };
}

/** How a document attached or sent now is checked (DK1, DK11): in shadow or on; null while off, or before 0144. */
export function documentChecksMode(status: DocumentChecksStatus): "shadow" | "on" | null {
  return status.checks && status.setting !== "off" ? status.setting : null;
}

export type DocumentRequestsErrorCode = "invalid" | "unchanged" | "cycle_running" | "not_ready";

const MESSAGES: Record<DocumentRequestsErrorCode, string> = {
  invalid: "Choose off, shadow or on.",
  unchanged: "Vendor requests are already set this way.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  not_ready: "Asking vendors for missing documents is not available in this workspace yet.",
};

export class DocumentRequestsError extends Error {
  constructor(readonly code: DocumentRequestsErrorCode) {
    super(MESSAGES[code]);
    this.name = "DocumentRequestsError";
  }
}

const SUMMARY: Record<DocumentRequestsSetting, string> = {
  off: "Vestiarion no longer asks vendors for missing documents",
  shadow: "Vestiarion now records which vendors it would ask for a missing document, and sends nothing",
  on: "Vestiarion now asks vendors for a bill's missing purchase order or goods receipt",
};
/** On, once documents are checked (DK1). */
const SUMMARY_ON_CHECKED = "Vestiarion now asks vendors for a bill's missing purchase order or goods receipt, and checks what they send against the bill";

/**
 * An owner sets it to off, shadow or on (ER1), signed as `document_requests_changed { by, from, to }`, best effort, as the
 * payee lock's change is. Refused while a cycle runs: the cycle read the setting when it began. Turning it off leaves
 * requests already out answering until they expire. Says whether documents are checked here (`checks`), which the
 * summary and the save message follow.
 */
export async function changeDocumentRequests(input: {
  actorId: string;
  to: DocumentRequestsSetting;
}): Promise<{ from: DocumentRequestsSetting; to: DocumentRequestsSetting; checks: boolean }> {
  if (!(DOCUMENT_REQUESTS_SETTINGS as readonly string[]).includes(input.to)) throw new DocumentRequestsError("invalid");
  const { setting: from, ready, checks } = await readDocumentChecksStatus(db());
  if (!ready) throw new DocumentRequestsError("not_ready");
  if (from === input.to) throw new DocumentRequestsError("unchanged");

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new DocumentRequestsError("cycle_running");

  // A write that asks for nothing back: only its error says whether it happened.
  const write = await db()
    .from("approval_policies")
    .upsert({ document_requests: input.to, updated_by: input.actorId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (write.error) {
    if (documentRequestsColumnMissing(write.error)) throw new DocumentRequestsError("not_ready");
    throw new Error(write.error.message);
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "document_requests_changed",
    summary: input.to === "on" && checks ? SUMMARY_ON_CHECKED : SUMMARY[input.to],
    detail: { by: input.actorId, from, to: input.to },
  });
  return { from, to: input.to, checks };
}
