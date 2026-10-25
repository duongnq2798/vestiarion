import { db, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { ClosePack } from "./types";

/**
 * Each close pack download is recorded (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP13, CP15): a
 * close pack is handed over, like the hand-off (`handoff_exported`) and the audit export (`ledger_exported`), so the
 * ledger keeps who took which month's books out, ties any copy to the ledger by its SHA-256, and counts downloads for
 * the brake across instances. Viewing the page and printing it record nothing.
 *
 * An export to Google Sheets is recorded the same way, with the spreadsheet's id, and so is one that failed after rows
 * may have reached Google (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS11).
 */

export const CLOSE_PACK_EXPORTED = "close_pack_exported";
/** An export to Google Sheets that failed after rows may have reached Google (close pack Sheets GS11). */
export const CLOSE_PACK_EXPORT_FAILED = "close_pack_export_failed";

/** Ten downloads and exports per person per workspace in ten minutes, counted from the ledger's own entries. */
export const CLOSE_PACK_EXPORT_LIMIT = { count: 10, windowMs: 10 * 60_000 };

/**
 * This person's close_pack_exported and close_pack_export_failed entries in the window, capped at the limit's count:
 * one brake holds downloads and Google Sheets exports together, a failed export included (close pack Sheets GS11).
 */
export async function recentClosePackExportsBy(userId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - CLOSE_PACK_EXPORT_LIMIT.windowMs).toISOString();
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("id")
      .in("action", [CLOSE_PACK_EXPORTED, CLOSE_PACK_EXPORT_FAILED])
      .gt("ts", since)
      .eq("detail->>by", userId)
      .limit(CLOSE_PACK_EXPORT_LIMIT.count)
  ) as Array<{ id: string }>;
  return rows.length;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const monthWords = (pack: ClosePack) => `${pack.month.label}${pack.ended ? "" : " so far"}`;

/**
 * Appends close_pack_exported, best effort, after the file is built and before it is sent: a failure is logged and the
 * file is still served. It names the person by id, never by email, and holds counts, the month and a hash: nothing a
 * webhook endpoint should not see. For Google Sheets (`sheet`), the hash is the Payments tab's, and the entry names the
 * connection and the spreadsheet by their ids, never by a link (close pack Sheets GS11).
 */
export async function recordClosePackExport(input: {
  orgId: string;
  userId: string;
  pack: ClosePack;
  format: "json" | "csv" | "google_sheets";
  sha256: string;
  sheet?: { connectionId: string; spreadsheetId: string; created: boolean };
}): Promise<void> {
  const { pack } = input;
  const payments = pack.rows.length;
  const notSettled = pack.notSettled.length;
  const how = input.format === "google_sheets" ? "exported to Google Sheets" : `downloaded as ${input.format.toUpperCase()}`;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "system",
    action: CLOSE_PACK_EXPORTED,
    summary: `Close pack for ${monthWords(pack)} ${how}: ${count(payments, "payment", "payments")} settled, ${notSettled} not settled`,
    detail: {
      by: input.userId,
      month: pack.month.key,
      ended: pack.ended,
      format: input.format,
      payments,
      notSettled,
      sha256: input.sha256,
      headSeq: pack.ledgerHead?.seq ?? 0,
      ...(input.sheet ? { connectionId: input.sheet.connectionId, spreadsheetId: input.sheet.spreadsheetId, created: input.sheet.created } : {}),
    },
  });
}

/**
 * Appends close_pack_export_failed, best effort (close pack Sheets GS11): an export to Google Sheets that failed after
 * rows may have reached Google, at the values write or at the read back. A failure before any row was sent records
 * nothing: nothing of the pack left. Ids only, never an email, a token or a link.
 */
export async function recordClosePackExportFailed(input: {
  orgId: string;
  userId: string;
  pack: ClosePack;
  connectionId: string;
  spreadsheetId: string | null;
  stage: "write" | "read_back";
  reason: "rate_limited" | "unavailable" | "forbidden" | "drive_full" | "bad_response" | "mismatch";
}): Promise<void> {
  const { pack } = input;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "system",
    action: CLOSE_PACK_EXPORT_FAILED,
    summary: `Close pack for ${monthWords(pack)} not fully exported to Google Sheets`,
    detail: {
      by: input.userId,
      month: pack.month.key,
      ended: pack.ended,
      format: "google_sheets",
      connectionId: input.connectionId,
      spreadsheetId: input.spreadsheetId,
      stage: input.stage,
      reason: input.reason,
    },
  });
}
