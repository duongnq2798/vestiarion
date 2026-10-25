import { db, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { ClosePack } from "./types";

/**
 * Each close pack download is recorded (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP13, CP15): a
 * close pack is handed over, like the hand-off (`handoff_exported`) and the audit export (`ledger_exported`), so the
 * ledger keeps who took which month's books out, ties any copy to the ledger by its SHA-256, and counts downloads for
 * the brake across instances. Viewing the page and printing it record nothing.
 */

export const CLOSE_PACK_EXPORTED = "close_pack_exported";

/** Ten downloads per person per workspace in ten minutes, counted from the ledger's own entries. */
export const CLOSE_PACK_EXPORT_LIMIT = { count: 10, windowMs: 10 * 60_000 };

/** close_pack_exported entries by this person in the window, capped at the limit's count. */
export async function recentClosePackExportsBy(userId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - CLOSE_PACK_EXPORT_LIMIT.windowMs).toISOString();
  const rows = unwrap(
    await db().from("ledger_entries").select("id").eq("action", CLOSE_PACK_EXPORTED).gt("ts", since).eq("detail->>by", userId).limit(CLOSE_PACK_EXPORT_LIMIT.count)
  ) as Array<{ id: string }>;
  return rows.length;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Appends close_pack_exported, best effort, after the file is built and before it is sent: a failure is logged and the
 * file is still served. It names the person by id, never by email, and holds counts, the month and a hash: nothing a
 * webhook endpoint should not see.
 */
export async function recordClosePackExport(input: { orgId: string; userId: string; pack: ClosePack; format: "json" | "csv"; sha256: string }): Promise<void> {
  const { pack } = input;
  const payments = pack.rows.length;
  const notSettled = pack.notSettled.length;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "system",
    action: CLOSE_PACK_EXPORTED,
    summary: `Close pack for ${pack.month.label}${pack.ended ? "" : " so far"} downloaded as ${input.format.toUpperCase()}: ${count(payments, "payment", "payments")} settled, ${notSettled} not settled`,
    detail: {
      by: input.userId,
      month: pack.month.key,
      ended: pack.ended,
      format: input.format,
      payments,
      notSettled,
      sha256: input.sha256,
      headSeq: pack.ledgerHead?.seq ?? 0,
    },
  });
}
