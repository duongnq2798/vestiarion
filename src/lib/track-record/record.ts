import { db, unwrap } from "../dal";
import { appendLedgerEntry, type LedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { TRACK_RECORD_CONFIRMED, TRACK_RECORD_EXPORTED, type TrackRecord } from "./build";

/**
 * What the track record writes (docs/superpowers/specs/2026-11-07-track-record-design.md TR5, TR8): an accountant's
 * confirmation, and each download. Both are ledger entries, naming the person by id, never by email.
 */

/** Ten downloads per person per workspace in ten minutes, counted from the ledger's own entries (TR8). */
export const TRACK_RECORD_EXPORT_LIMIT = { count: 10, windowMs: 10 * 60_000 };

export async function recentTrackRecordExportsBy(userId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - TRACK_RECORD_EXPORT_LIMIT.windowMs).toISOString();
  const rows = unwrap(
    await db().from("ledger_entries").select("id").eq("action", TRACK_RECORD_EXPORTED).gt("ts", since).eq("detail->>by", userId).limit(TRACK_RECORD_EXPORT_LIMIT.count)
  ) as Array<{ id: string }>;
  return rows.length;
}

const verdictWords = (n: number) => `${n} ${n === 1 ? "verdict" : "verdicts"}`;

/** Appends track_record_exported, best effort, after the file is built and before it is sent (TR8). */
export async function recordTrackRecordExport(input: { orgId: string; userId: string; record: TrackRecord; sha256: string }): Promise<void> {
  const { record } = input;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "system",
    action: TRACK_RECORD_EXPORTED,
    summary: `Track record downloaded: ${verdictWords(record.totals.given)}, ${record.totals.agreed} agreed`,
    detail: {
      by: input.userId,
      sha256: input.sha256,
      contentSha256: record.contentSha256,
      verdicts: record.totals.given,
      headSeq: record.ledgerHead?.seq ?? 0,
    },
  });
}

/**
 * Appends track_record_confirmed (TR5). Not best effort: a confirmation that is not signed was not given, so a failure
 * is thrown to the action, which says so.
 */
export async function recordTrackRecordConfirmation(input: { userId: string; role: string; record: TrackRecord }): Promise<LedgerEntry> {
  const { record } = input;
  return appendLedgerEntry({
    actor: "human",
    domain: "system",
    action: TRACK_RECORD_CONFIRMED,
    summary: `Track record confirmed by the accountant: ${verdictWords(record.totals.given)}, ${record.totals.agreed} agreed`,
    detail: {
      by: input.userId,
      role: input.role,
      sha256: record.contentSha256,
      headSeq: record.ledgerHead?.seq ?? 0,
      headHash: record.ledgerHead?.hash ?? null,
      verdicts: record.totals.given,
      agreed: record.totals.agreed,
      disagreed: record.totals.disagreed,
      earned: record.earned?.vendors.filter((vendor) => vendor.shownEarned).map((vendor) => vendor.vendorId) ?? [],
    },
  });
}
