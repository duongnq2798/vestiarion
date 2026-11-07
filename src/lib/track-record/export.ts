import type { LadderRow } from "../autonomy-ladder";
import { CHECK_AN_ENTRY, type EvidenceKey, type SignedEntry } from "../evidence-export";
import { networkProfile, type Network } from "../network";
import { TRACK_RECORD_FORMAT, type TrackRecord, type TrackRecordEarned, type TrackRecordVerdict } from "./build";

/**
 * The track record as a file (docs/superpowers/specs/2026-11-07-track-record-design.md TR8): the record with people
 * named by user id, every entry it cites in full with the workspace's public keys, and in words what it is, how to check
 * an entry alone and what a confirmation means. Pure: the route reads, gates, hashes and records.
 */

export const TRACK_RECORD_IS =
  "The agent's track record in shadow mode: each verdict the business gave on one of the agent's decisions about a real bill, sample data left out, and the vendors that earned the owner's rule. It only measures: it promises nothing about payments to come.";

export const TRACK_RECORD_CONFIRMATION_MEANS =
  "A confirmation is a track_record_confirmed entry, signed in the workspace's ledger, given by one of its accountants. It names contentSha256: the SHA-256 of the canonical JSON (keys sorted) of { format, workspace (its slug), network, totals, byKind, byVendor, earned, verdicts }. The same verdicts and statuses give the same hash.";

export interface TrackRecordDocument {
  format: typeof TRACK_RECORD_FORMAT;
  exportedAt: string;
  is: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  ledgerHead: { seq: number; hash: string } | null;
  contentSha256: string;
  totals: { given: number; agreed: number; disagreed: number };
  byKind: LadderRow[];
  byVendor: LadderRow[];
  earned: TrackRecordEarned | null;
  verdicts: TrackRecordVerdict[];
  cut: boolean;
  confirmations: Array<{ seq: number; at: string; by: string | null; sha256: string; current: boolean }>;
  confirmationMeans: string;
  howToCheckAnEntry: readonly string[];
  keys: EvidenceKey[];
  entries: SignedEntry[];
}

export function trackRecordDocument(record: TrackRecord): TrackRecordDocument {
  return {
    format: TRACK_RECORD_FORMAT,
    exportedAt: record.readAt,
    is: TRACK_RECORD_IS,
    workspace: record.workspace,
    network: { id: record.network, label: networkProfile(record.network).label },
    ledgerHead: record.ledgerHead,
    contentSha256: record.contentSha256,
    totals: record.totals,
    byKind: record.byKind,
    byVendor: record.byVendor,
    earned: record.earned,
    verdicts: record.verdicts,
    cut: record.cut,
    // By user id in the file, never by email (TR6).
    confirmations: record.confirmations.map(({ seq, at, by, sha256, current }) => ({ seq, at, by, sha256, current })),
    confirmationMeans: TRACK_RECORD_CONFIRMATION_MEANS,
    howToCheckAnEntry: CHECK_AN_ENTRY,
    keys: record.keys,
    entries: record.entries,
  };
}

export function trackRecordJson(record: TrackRecord): string {
  return `${JSON.stringify(trackRecordDocument(record), null, 2)}\n`;
}

export function trackRecordFileName(slug: string, readAt: string): string {
  return `vestiarion-track-record-${slug}-${readAt.slice(0, 10)}.json`;
}
