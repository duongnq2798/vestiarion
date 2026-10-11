import { currentOrgId } from "./context";
import { db, type OrgDb } from "./dal";
import { appendLedgerEntry, assertLedgerCanSign } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { generateReportShareToken } from "./report-share-token";
import { shareOptionWords, type ShareOptions } from "./shared-report";

/**
 * Sharing the workspace report by a public link (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S10,
 * S13), in the workspace in scope. A share is a row of `report_shares` (0095) holding the SHA-256 of its link's secret
 * and what it shows; the link itself is returned once. Each share is a signed `report_shared` entry, and a link whose
 * entry cannot be written is stopped at once, so no link stays live without its record. Stopping sets `revoked_at`
 * first, so it takes effect even when the ledger cannot be written, then records `report_unshared` best effort. Who may
 * share or stop (`report.share`) is the command's check.
 *
 * Until migration 0095 runs, listing answers `available: false` and sharing or stopping refuses with `not_ready`.
 */

export const REPORT_SHARE_ACTIONS = { shared: "report_shared", unshared: "report_unshared" } as const;
/** How many links may be live at once: one for each of the people a business shows its report to. */
export const REPORT_SHARE_LIMIT = 10;

export type ReportShareErrorCode = "not_ready" | "options" | "limit" | "not_recorded" | "not_found" | "already_stopped";

export const REPORT_SHARE_MESSAGES: Record<ReportShareErrorCode, string> = {
  not_ready: "Sharing the report is not set up on this deployment yet.",
  options: "Choose what the shared report shows: supplier names or labels, amounts or not, and its title.",
  limit: `This workspace has ${REPORT_SHARE_LIMIT} live links to its report. Stop sharing one before you make another.`,
  not_recorded: "The link could not be recorded in the ledger, so it was stopped at once. Try again in a moment.",
  not_found: "That link is not one of this workspace's.",
  already_stopped: "That link was stopped already.",
};

export class ReportShareError extends Error {
  constructor(readonly code: ReportShareErrorCode) {
    super(REPORT_SHARE_MESSAGES[code]);
    this.name = "ReportShareError";
  }
}

export interface ReportShare {
  id: string;
  options: ShareOptions;
  /** Who made it: a member's user id, or null once they deleted their account. */
  createdBy: string | null;
  createdAt: string;
}

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01): migration 0095 has not run here yet. */
export function missingTable(error: PostgrestError, table: string): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return error.code === "PGRST205" || error.code === "42P01" || (message.includes(table) && /schema cache|does not exist/.test(message));
}

const COLUMNS = "id, show_names, show_amounts, show_workspace_name, created_by, created_at, revoked_at";

type ShareRow = {
  id: string;
  show_names: boolean;
  show_amounts: boolean;
  show_workspace_name: boolean;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
};

export function optionsOf(row: Pick<ShareRow, "show_names" | "show_amounts" | "show_workspace_name">): ShareOptions {
  return { names: row.show_names ? "shown" : "labels", amounts: row.show_amounts ? "shown" : "hidden", title: row.show_workspace_name ? "workspace" : "neutral" };
}

function validOptions(options: ShareOptions): boolean {
  return (
    (options.names === "labels" || options.names === "shown") &&
    (options.amounts === "shown" || options.amounts === "hidden") &&
    (options.title === "workspace" || options.title === "neutral")
  );
}

/** The workspace's live links, newest first, and how many were stopped. `available: false` before migration 0095. */
export async function listReportShares(orgDb: OrgDb): Promise<{ available: false } | { available: true; live: ReportShare[]; stopped: number }> {
  const read = await orgDb.from("report_shares").select(COLUMNS).order("created_at", { ascending: false });
  if (read.error) {
    if (missingTable(read.error, "report_shares")) return { available: false };
    throw new Error(read.error.message);
  }
  const rows = ((read.data ?? []) as ShareRow[]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return {
    available: true,
    live: rows.filter((row) => row.revoked_at === null).map((row) => ({ id: row.id, options: optionsOf(row), createdBy: row.created_by, createdAt: row.created_at })),
    stopped: rows.filter((row) => row.revoked_at !== null).length,
  };
}

export async function shareReport(input: { actorId: string; options: ShareOptions }): Promise<{ token: string; shareId: string }> {
  const { options } = input;
  if (!validOptions(options)) throw new ReportShareError("options");
  // An unreadable signing key refuses the share before its row is written, rather than leave a link unrecorded.
  assertLedgerCanSign();

  const live = await db().from("report_shares").select("id").is("revoked_at", null);
  if (live.error) {
    if (missingTable(live.error, "report_shares")) throw new ReportShareError("not_ready");
    throw new Error(live.error.message);
  }
  if ((live.data ?? []).length >= REPORT_SHARE_LIMIT) throw new ReportShareError("limit");

  const { token, secretHash } = generateReportShareToken();
  const stored = await db()
    .from("report_shares")
    .insert({
      token_hash: secretHash,
      show_names: options.names === "shown",
      show_amounts: options.amounts === "shown",
      show_workspace_name: options.title === "workspace",
      created_by: input.actorId,
    })
    .select("id")
    .single<{ id: string }>();
  if (stored.error) {
    if (missingTable(stored.error, "report_shares")) throw new ReportShareError("not_ready");
    throw new Error(stored.error.message);
  }
  const shareId = stored.data.id;

  try {
    await appendLedgerEntry({
      actor: "human",
      domain: "system",
      action: REPORT_SHARE_ACTIONS.shared,
      summary: `Shared the report by a public link: ${shareOptionWords(options).join(", ")}`,
      detail: { by: input.actorId, shareId, options: { names: options.names, amounts: options.amounts, title: options.title } },
    });
  } catch {
    // A link with no entry never stays live (S10): stop it now, and ask the person to try again.
    console.error("report share not recorded; stopping its link", currentOrgId());
    const revoked = await db().from("report_shares").update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId }).eq("id", shareId);
    if (revoked.error) console.error("report share could not be stopped after its entry failed", currentOrgId(), revoked.error.message);
    throw new ReportShareError("not_recorded");
  }
  return { token, shareId };
}

export async function stopSharingReport(input: { actorId: string; shareId: string }): Promise<void> {
  const found = await db().from("report_shares").select("id, revoked_at").eq("id", input.shareId).limit(1);
  if (found.error) {
    if (missingTable(found.error, "report_shares")) throw new ReportShareError("not_ready");
    // Not a uuid: no link of this workspace's has that id.
    if (found.error.code === "22P02") throw new ReportShareError("not_found");
    throw new Error(found.error.message);
  }
  const share = ((found.data ?? []) as Array<{ id: string; revoked_at: string | null }>)[0];
  if (!share) throw new ReportShareError("not_found");
  if (share.revoked_at) throw new ReportShareError("already_stopped");

  // Revoked first: stopping takes effect even when the ledger cannot be written.
  const revoked = await db()
    .from("report_shares")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId })
    .eq("id", share.id)
    .is("revoked_at", null)
    .select("id");
  if (revoked.error) {
    if (/report_share_revoked/.test(revoked.error.message ?? "")) throw new ReportShareError("already_stopped");
    if (missingTable(revoked.error, "report_shares")) throw new ReportShareError("not_ready");
    throw new Error(revoked.error.message);
  }
  // Someone else stopped it between the read and this write.
  if ((revoked.data ?? []).length === 0) throw new ReportShareError("already_stopped");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: REPORT_SHARE_ACTIONS.unshared,
    summary: "Stopped sharing the report by a public link",
    detail: { by: input.actorId, shareId: share.id },
  });
}
