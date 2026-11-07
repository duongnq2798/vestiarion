import { createHash } from "node:crypto";
import { autonomyLadder, decisionKindLabel, type AutonomyLadder, type LadderRow } from "../autonomy-ladder";
import { canonicalJson } from "../canonical-json";
import { earnedStatusWords, earnedWaitingWords, shownEarned, type EarnedVendorsView } from "../earned-vendors";
import type { EvidenceKey, SignedEntry } from "../evidence-export";
import type { LedgerRow } from "../ledger";
import type { Network } from "../network";
import type { EntryCheck } from "../receipts/verify";
import type { ReportFacts } from "../workspace-report";

/**
 * The agent's track record (docs/superpowers/specs/2026-11-07-track-record-design.md): the ladder, the earned vendors
 * and every verdict they rest on, with the entries behind them in full, and the SHA-256 an accountant's confirmation
 * names. Pure: `read.ts` reads, the route and the action gate and record.
 */

export const TRACK_RECORD_FORMAT = "vestiarion-track-record/1";
export const TRACK_RECORD_CONFIRMED = "track_record_confirmed";
export const TRACK_RECORD_EXPORTED = "track_record_exported";
/** The most verdicts one record holds: past it, the newest (TR2). */
export const TRACK_RECORD_MAX_VERDICTS = 2000;

/** One verdict, with what it was given on (TR1). */
export interface TrackRecordVerdict {
  /** The agent decision's entry. */
  decisionSeq: number;
  decidedAt: string;
  action: string;
  /** The decision in plain words: "Pay" … */
  kind: string;
  vendor: { id: string; name: string };
  amount: number;
  currency: string;
  verdict: "agree" | "disagree";
  /** When the verdict was given, where it was read. */
  givenAt: string | null;
  /** The `decision_verdict` entry that records it; null where none was found (it is appended best effort). */
  verdictSeq: number | null;
}

/** One vendor under the owner's rule, as the report says it (AL18). */
export interface TrackRecordEarnedVendor {
  vendorId: string;
  name: string;
  state: "earned" | "counting" | "cannot";
  /** Shown as earned: earned now and signed in the ledger (AL19). */
  shownEarned: boolean;
  words: string;
  /** Its payments made on its own that wait for a verdict, in words, while the agent may pay it on its own (AL26). */
  waiting: string | null;
}

export interface TrackRecordEarned {
  /** The owner's rule: agreed verdicts in a row; null for no rule. */
  streak: number | null;
  /** The agent pays earned vendors on its own (AL21). */
  payments: boolean;
  vendors: TrackRecordEarnedVendor[];
}

/** A confirmation, newest first (TR6): `who` is a member's email on the page and the user id in the file. */
export interface TrackRecordConfirmation {
  seq: number;
  at: string;
  by: string | null;
  who: string | null;
  sha256: string;
  /** It names the record as it stands. */
  current: boolean;
}

export interface TrackRecord {
  workspace: { slug: string; name: string };
  network: Network;
  readAt: string;
  ledgerHead: { seq: number; hash: string } | null;
  totals: { given: number; agreed: number; disagreed: number };
  byKind: LadderRow[];
  byVendor: LadderRow[];
  /** Null where the rule or its record could not be read, or before migration 0146 (TR1). */
  earned: TrackRecordEarned | null;
  verdicts: TrackRecordVerdict[];
  /** More verdicts than one record holds: the oldest were left out (TR2). */
  cut: boolean;
  confirmations: TrackRecordConfirmation[];
  contentSha256: string;
  keys: EvidenceKey[];
  entries: SignedEntry[];
}

export interface TrackRecordInput {
  workspace: { slug: string; name: string };
  network: Network;
  readAt: string;
  facts: Pick<ReportFacts, "bills" | "decisions" | "verdicts">;
  earned: EarnedVendorsView | null;
  /** The ledger's entries this record may cite: decisions, verdicts, earned statuses and confirmations. */
  ledger: LedgerRow[];
  keys: EvidenceKey[];
  ledgerHead: { seq: number; hash: string } | null;
  /** Each cited entry's check, once it is known; absent on the first build. */
  checks?: ReadonlyMap<number, EntryCheck>;
  /** A member's email by user id, for the page; absent in the file, which names people by id. */
  emails?: ReadonlyMap<string, string>;
}

const NOT_CHECKED: EntryCheck = { ok: null, reason: "Not checked yet." };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The verdicts on real bills, oldest decision first, each with its decision and its bill (TR1). */
function verdictRows(input: TrackRecordInput): { rows: TrackRecordVerdict[]; cut: boolean } {
  const bills = new Map(input.facts.bills.map((bill) => [bill.id, bill]));
  const decisions = new Map(input.facts.decisions.map((decision) => [decision.seq, decision]));
  // The decision_verdict entry naming each decision: the first, as a verdict is kept once.
  const recorded = new Map<number, number>();
  for (const row of input.ledger) {
    if (row.action !== "decision_verdict") continue;
    const seq = Number(row.detail.entrySeq);
    if (Number.isInteger(seq) && !recorded.has(seq)) recorded.set(seq, row.seq);
  }
  const rows = input.facts.verdicts.flatMap((verdict): TrackRecordVerdict[] => {
    const decision = decisions.get(verdict.entrySeq);
    const bill = decision ? bills.get(decision.invoiceId) : undefined;
    if (!decision || !bill || bill.payee.sample) return [];
    return [
      {
        decisionSeq: decision.seq,
        decidedAt: decision.ts,
        action: decision.action,
        kind: decisionKindLabel(decision.action),
        vendor: { id: bill.payee.id, name: bill.payee.name },
        amount: bill.amount,
        currency: bill.currency,
        verdict: verdict.verdict,
        givenAt: verdict.decidedAt ?? null,
        verdictSeq: recorded.get(decision.seq) ?? null,
      },
    ];
  });
  rows.sort((a, b) => a.decisionSeq - b.decisionSeq);
  const cut = rows.length > TRACK_RECORD_MAX_VERDICTS;
  return { rows: cut ? rows.slice(rows.length - TRACK_RECORD_MAX_VERDICTS) : rows, cut };
}

/** The ladder from the record's own verdicts, so its figures are exactly the verdicts it lists (TR1). */
function ladderOf(rows: readonly TrackRecordVerdict[]): AutonomyLadder {
  return autonomyLadder(rows.map((row) => ({ action: row.action, verdict: row.verdict, vendor: { ...row.vendor, sample: false } })));
}

function earnedOf(view: EarnedVendorsView | null): TrackRecordEarned | null {
  if (!view) return null;
  const shown = shownEarned(view);
  return {
    streak: view.streak,
    payments: view.payments === true,
    vendors:
      view.streak === null
        ? []
        : view.statuses
            .filter((status) => status.given > 0)
            .map((status) => {
              const recorded = view.recorded.has(status.vendorId);
              return {
                vendorId: status.vendorId,
                name: status.name,
                state: status.state,
                shownEarned: shown.has(status.vendorId),
                words: earnedStatusWords(status, recorded),
                waiting: recorded && view.payments ? earnedWaitingWords(status) : null,
              };
            }),
  };
}

/**
 * The SHA-256 a confirmation names (TR3): what the record says, without when it was read, the ledger's head, the
 * entries in full or the confirmations, so the same verdicts and statuses give the same hash.
 */
export function trackRecordContentSha256(record: Pick<TrackRecord, "workspace" | "network" | "totals" | "byKind" | "byVendor" | "earned" | "verdicts">): string {
  const content = {
    format: TRACK_RECORD_FORMAT,
    workspace: record.workspace.slug,
    network: record.network,
    totals: record.totals,
    byKind: record.byKind,
    byVendor: record.byVendor,
    earned: record.earned,
    verdicts: record.verdicts,
  };
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

function entryOf(row: LedgerRow, checks: ReadonlyMap<number, EntryCheck> | undefined): SignedEntry {
  return {
    seq: row.seq,
    id: row.id ?? null,
    ts: row.ts,
    actor: row.actor,
    domain: row.domain,
    action: row.action,
    summary: row.summary,
    detail: row.detail,
    body_hash: row.body_hash,
    signature: row.signature,
    prev_hash: row.prev_hash,
    hash: row.hash,
    signing_key_id: row.signing_key_id ?? null,
    check: checks?.get(row.seq) ?? NOT_CHECKED,
  };
}

export function buildTrackRecord(input: TrackRecordInput): TrackRecord {
  const { rows, cut } = verdictRows(input);
  const ladder = ladderOf(rows);
  const earned = earnedOf(input.earned);
  const totals = { given: ladder.given, agreed: ladder.agreed, disagreed: ladder.disagreed };
  const contentSha256 = trackRecordContentSha256({
    workspace: input.workspace,
    network: input.network,
    totals,
    byKind: ladder.byKind,
    byVendor: ladder.byVendor,
    earned,
    verdicts: rows,
  });

  const confirmations = input.ledger
    .filter((row) => row.action === TRACK_RECORD_CONFIRMED)
    .map((row): TrackRecordConfirmation => {
      const by = text(row.detail.by);
      const sha256 = text(row.detail.sha256) ?? "";
      return { seq: row.seq, at: row.ts, by, who: by ? (input.emails?.get(by) ?? null) : null, sha256, current: sha256 === contentSha256 };
    })
    .sort((a, b) => b.seq - a.seq);

  // The entries it rests on (TR2): each listed decision and its verdict, the earned statuses and the confirmations.
  const cited = new Set<number>();
  for (const row of rows) {
    cited.add(row.decisionSeq);
    if (row.verdictSeq !== null) cited.add(row.verdictSeq);
  }
  for (const row of input.ledger) {
    if (row.action === "vendor_earned" || row.action === "vendor_earned_lost" || row.action === TRACK_RECORD_CONFIRMED) cited.add(row.seq);
  }
  const entries = input.ledger.filter((row) => cited.has(row.seq)).sort((a, b) => a.seq - b.seq).map((row) => entryOf(row, input.checks));

  return {
    workspace: input.workspace,
    network: input.network,
    readAt: input.readAt,
    ledgerHead: input.ledgerHead,
    totals,
    byKind: ladder.byKind,
    byVendor: ladder.byVendor,
    earned,
    verdicts: rows,
    cut,
    confirmations,
    contentSha256,
    keys: input.keys,
    entries,
  };
}

/** This person's confirmation of the record as it stands, if they gave one (TR5). */
export function confirmedBy(record: TrackRecord, userId: string): TrackRecordConfirmation | null {
  return record.confirmations.find((confirmation) => confirmation.current && confirmation.by === userId) ?? null;
}
