import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/canonical-json";
import type { EarnedVendorsView } from "@/lib/earned-vendors";
import type { LedgerRow } from "@/lib/ledger";
import {
  buildTrackRecord,
  confirmedBy,
  TRACK_RECORD_CONFIRMED,
  TRACK_RECORD_FORMAT,
  TRACK_RECORD_MAX_VERDICTS,
  trackRecordContentSha256,
  type TrackRecordInput,
} from "@/lib/track-record/build";
import { trackRecordDocument, trackRecordFileName, trackRecordJson } from "@/lib/track-record/export";
import type { ReportBill, ReportDecision, ReportVerdict } from "@/lib/workspace-report";

/**
 * The agent's track record (docs/superpowers/specs/2026-11-07-track-record-design.md TR1-TR3, TR6, TR8): the verdicts on
 * real bills with what they rest on, a SHA-256 that moves with the verdicts and nothing else, the confirmations against
 * it, and the file, which names people by id. Pure, on hand-made rows.
 */

function bill(id: string, payee: Partial<ReportBill["payee"]> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-02T10:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    amount: 46.41,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `cp-${id}`, name: `Vendor ${id}`, mirror: false, sample: false, ...payee },
  };
}

function decision(seq: number, invoiceId: string, action = "ap_pay"): ReportDecision {
  return {
    seq,
    ts: `2026-10-${String(10 + seq).padStart(2, "0")}T09:00:00.000Z`,
    action,
    invoiceId,
    guardrailBlocked: false,
    guardrailRule: null,
    heldBecause: null,
    resultingStatus: "held",
    shadow: true,
    reasoning: "Pay it.",
  };
}

function row(seq: number, action: string, detail: Record<string, unknown> = {}): LedgerRow {
  return {
    seq,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: `2026-10-${String(10 + (seq % 18)).padStart(2, "0")}T09:00:00.000Z`,
    actor: action === "ap_pay" || action === "ap_schedule" ? "agent" : "human",
    domain: action.startsWith("ap_") || action === "decision_verdict" ? "ap" : "system",
    action,
    summary: action,
    detail,
    body_hash: "b".repeat(64),
    signature: "s",
    prev_hash: "p".repeat(64),
    hash: `${seq}`.padStart(64, "0"),
    signing_key_id: "key-1",
  };
}

const agree = (entrySeq: number): ReportVerdict => ({ entrySeq, verdict: "agree", decidedAt: "2026-10-20T10:00:00.000Z" });
const disagree = (entrySeq: number): ReportVerdict => ({ entrySeq, verdict: "disagree", decidedAt: "2026-10-20T10:00:00.000Z" });

const EARNED: EarnedVendorsView = {
  streak: 5,
  payments: true,
  statuses: [
    { vendorId: "cp-a", name: "Vendor a", given: 2, state: "counting", agreed: 1, needed: 5, since: null },
    { vendorId: "cp-z", name: "Vendor z", given: 0, state: "counting", agreed: 0, needed: 5, since: null },
  ],
  recorded: new Set(),
};

function input(over: Partial<TrackRecordInput> = {}): TrackRecordInput {
  return {
    workspace: { slug: "acme-shadow", name: "Acme Shadow" },
    network: "arc-testnet",
    readAt: "2026-11-07T09:00:00.000Z",
    facts: {
      bills: [bill("a"), bill("b"), bill("s", { sample: true })],
      decisions: [decision(1, "a"), decision(2, "b", "ap_schedule"), decision(3, "a"), decision(4, "s")],
      verdicts: [agree(1), agree(2), disagree(3), agree(4)],
    },
    earned: EARNED,
    ledger: [
      row(1, "ap_pay"),
      row(2, "ap_schedule"),
      row(3, "ap_pay"),
      row(4, "ap_pay"),
      row(5, "decision_verdict", { entrySeq: 1 }),
      row(6, "decision_verdict", { entrySeq: 2 }),
      row(7, "decision_verdict", { entrySeq: 3 }),
      row(8, "decision_verdict", { entrySeq: 4 }),
      row(9, "agent_cycle"),
    ],
    keys: [{ id: "key-1", status: "active", publicKeyPem: "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----\n" }],
    ledgerHead: { seq: 9, hash: "9".padStart(64, "0") },
    ...over,
  };
}

describe("buildTrackRecord (track record TR1, TR2)", () => {
  it("lists each verdict on a real bill, oldest decision first, with the entry that records it", () => {
    const record = buildTrackRecord(input());
    expect(record.verdicts.map((verdict) => [verdict.decisionSeq, verdict.kind, verdict.vendor.name, verdict.verdict, verdict.verdictSeq])).toEqual([
      [1, "Pay", "Vendor a", "agree", 5],
      [2, "Schedule", "Vendor b", "agree", 6],
      [3, "Pay", "Vendor a", "disagree", 7],
    ]);
    // Sample data is left out, as the ladder leaves it out (AL3).
    expect(record.totals).toEqual({ given: 3, agreed: 2, disagreed: 1 });
    expect(record.byVendor.map((ladder) => [ladder.label, ladder.given, ladder.rate])).toEqual([
      ["Vendor a", 2, null],
      ["Vendor b", 1, null],
    ]);
  });

  it("carries the decisions and verdicts it lists, and no other entry", () => {
    const record = buildTrackRecord(input());
    expect(record.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(record.entries[0]).toMatchObject({ action: "ap_pay", signing_key_id: "key-1", check: { ok: null } });
    const checked = buildTrackRecord(input({ checks: new Map([[1, { ok: true as const }]]) }));
    expect(checked.entries[0].check).toEqual({ ok: true });
  });

  it("says a verdict whose entry was not found, and still lists it", () => {
    const record = buildTrackRecord(input({ ledger: input().ledger.filter((entry) => entry.seq !== 7) }));
    expect(record.verdicts.find((verdict) => verdict.decisionSeq === 3)?.verdictSeq).toBeNull();
  });

  it("words the earned vendors as the report does, leaving out a vendor with no verdict", () => {
    const record = buildTrackRecord(input());
    expect(record.earned).toEqual({
      streak: 5,
      payments: true,
      vendors: [{ vendorId: "cp-a", name: "Vendor a", state: "counting", shownEarned: false, words: "1 of 5 agreed in a row", waiting: null }],
    });
    expect(buildTrackRecord(input({ earned: null })).earned).toBeNull();
    expect(buildTrackRecord(input({ earned: { streak: null, statuses: [], recorded: new Set() } })).earned).toEqual({ streak: null, payments: false, vendors: [] });
  });

  it("holds the newest verdicts past the most one record holds, and says it was cut", () => {
    const many = TRACK_RECORD_MAX_VERDICTS + 2;
    const decisions = Array.from({ length: many }, (_, index) => decision(index + 1, "a"));
    const record = buildTrackRecord(input({ facts: { bills: [bill("a")], decisions, verdicts: decisions.map((one) => agree(one.seq)) }, ledger: [] }));
    expect(record.cut).toBe(true);
    expect(record.verdicts).toHaveLength(TRACK_RECORD_MAX_VERDICTS);
    expect(record.verdicts[0].decisionSeq).toBe(3);
  });
});

describe("contentSha256 (track record TR3)", () => {
  it("is the SHA-256 of the canonical JSON of what the record says", () => {
    const record = buildTrackRecord(input());
    const content = {
      format: TRACK_RECORD_FORMAT,
      workspace: "acme-shadow",
      network: "arc-testnet",
      totals: record.totals,
      byKind: record.byKind,
      byVendor: record.byVendor,
      earned: record.earned,
      verdicts: record.verdicts,
    };
    expect(record.contentSha256).toBe(createHash("sha256").update(canonicalJson(content), "utf8").digest("hex"));
    expect(trackRecordContentSha256(record)).toBe(record.contentSha256);
  });

  it("does not move with when it was read, the ledger's head, other entries or a confirmation", () => {
    const first = buildTrackRecord(input());
    const later = buildTrackRecord(
      input({
        readAt: "2026-11-09T09:00:00.000Z",
        ledgerHead: { seq: 40, hash: "f".repeat(64) },
        ledger: [...input().ledger, row(10, "agent_cycle"), row(11, TRACK_RECORD_CONFIRMED, { by: "u-acc", sha256: first.contentSha256 })],
      })
    );
    expect(later.contentSha256).toBe(first.contentSha256);
  });

  it("moves with a new verdict, and with an earned vendor's status", () => {
    const first = buildTrackRecord(input());
    const facts = input().facts;
    const more = buildTrackRecord(input({ facts: { ...facts, decisions: [...facts.decisions, decision(10, "b")], verdicts: [...facts.verdicts, agree(10)] } }));
    expect(more.contentSha256).not.toBe(first.contentSha256);
    const earned = buildTrackRecord(input({ earned: { ...EARNED, statuses: [{ ...EARNED.statuses[0], agreed: 2 } as EarnedVendorsView["statuses"][number], EARNED.statuses[1]] } }));
    expect(earned.contentSha256).not.toBe(first.contentSha256);
  });
});

describe("confirmations (track record TR5, TR6)", () => {
  it("lists them newest first, each said to be this record or an earlier one, and cites them", () => {
    const sha = buildTrackRecord(input()).contentSha256;
    const record = buildTrackRecord(
      input({
        ledger: [...input().ledger, row(12, TRACK_RECORD_CONFIRMED, { by: "u-old", sha256: "a".repeat(64) }), row(14, TRACK_RECORD_CONFIRMED, { by: "u-acc", sha256: sha })],
        emails: new Map([["u-acc", "books@example.com"]]),
      })
    );
    expect(record.confirmations.map((confirmation) => [confirmation.seq, confirmation.who, confirmation.current])).toEqual([
      [14, "books@example.com", true],
      [12, null, false],
    ]);
    expect(record.entries.map((entry) => entry.seq)).toEqual(expect.arrayContaining([12, 14]));
    expect(confirmedBy(record, "u-acc")?.seq).toBe(14);
    expect(confirmedBy(record, "u-old")).toBeNull();
  });
});

describe("the file (track record TR8)", () => {
  it("names people by id, never by email, and says how to check an entry and what a confirmation means", () => {
    const sha = buildTrackRecord(input()).contentSha256;
    const record = buildTrackRecord(
      input({ ledger: [...input().ledger, row(14, TRACK_RECORD_CONFIRMED, { by: "u-acc", sha256: sha })], emails: new Map([["u-acc", "books@example.com"]]) })
    );
    const json = trackRecordJson(record);
    expect(json).not.toContain("books@example.com");
    const document = trackRecordDocument(record);
    expect(document).toMatchObject({ format: "vestiarion-track-record/1", contentSha256: sha, network: { id: "arc-testnet", label: "Arc testnet" } });
    expect(document.confirmations).toEqual([{ seq: 14, at: record.confirmations[0].at, by: "u-acc", sha256: sha, current: true }]);
    expect(document.howToCheckAnEntry[0]).toContain("body_hash = sha256");
    expect(document.confirmationMeans).toContain("track_record_confirmed");
    expect(document.is).toContain("It only measures");
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(document)));
    expect(trackRecordFileName("acme-shadow", record.readAt)).toBe("vestiarion-track-record-acme-shadow-2026-11-07.json");
  });
});
