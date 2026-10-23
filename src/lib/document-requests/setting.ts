import { CYCLE_IN_PROGRESS_MS } from "../agent/balances";
import { currentOrgId } from "../context";
import { db, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { DOCUMENT_REQUESTS_SETTINGS, documentRequestsSettingOf, type DocumentRequestsSetting } from "./rules";

/**
 * Whether the agent asks vendors for a bill's missing document (docs/superpowers/specs/2026-10-23-document-requests-design.md
 * ER1): off by default; shadow records which vendors it would ask and sends nothing (ER3); on asks them (ER4). An owner
 * (`approval.policy`) changes it in Settings, beside the payee lock; who may is the caller's check. Every export runs
 * inside an organization scope.
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

/**
 * An owner sets it to off, shadow or on (ER1), signed as `document_requests_changed { by, from, to }`, best effort, as the
 * payee lock's change is. Refused while a cycle runs: the cycle read the setting when it began. Turning it off leaves
 * requests already out answering until they expire.
 */
export async function changeDocumentRequests(input: { actorId: string; to: DocumentRequestsSetting }): Promise<{ from: DocumentRequestsSetting; to: DocumentRequestsSetting }> {
  if (!(DOCUMENT_REQUESTS_SETTINGS as readonly string[]).includes(input.to)) throw new DocumentRequestsError("invalid");
  const { setting: from, ready } = await readDocumentRequestsSetting(db());
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
    summary: SUMMARY[input.to],
    detail: { by: input.actorId, from, to: input.to },
  });
  return { from, to: input.to };
}
