import { describe, expect, it } from "vitest";
import { MAY_HAVE_BEEN_ACCEPTED } from "@/lib/circle/settlement";
import { addDecimals, buildClosePack, closePackEvidencePath, screeningAnchors, toDecimal, type ClosePackInput } from "@/lib/close-pack/build";
import { closePackMonth } from "@/lib/close-pack/month";
import type { ClosePack, ClosePackIntentRow, ClosePackInvoiceRow, ClosePackLedgerRow, ClosePackMilestoneRow, ClosePackRow } from "@/lib/close-pack/types";
import {
  addressLines,
  approvedLines,
  billWords,
  booksWords,
  checkCell,
  decidedLines,
  escrowWords,
  openStateWords,
  paidToWords,
  recordWords,
  transactionWords,
  whoWords,
} from "@/lib/close-pack/words";
import type { EvidenceScreening } from "@/lib/evidence-chain";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * The monthly close pack's builder (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP2-CP10): one row
 * per payment settled in the month, with its bill, its approval chain, its six checks, its transaction and the signed
 * entry that records it; what was not settled and the escrow moves listed apart; every cited entry carried once. Pure:
 * the entries are built like the payee lock pack's tests, after the runs on pinecrest-studio.
 */

const OWNER = "0b6c1c9e-0000-4000-8000-00000000a001";
const APPROVER = "0b6c1c9e-0000-4000-8000-00000000a002";
const ACCOUNTANT = "0b6c1c9e-0000-4000-8000-00000000a003";
const LEFT = "9f8e7d6c-0000-4000-8000-00000000a004";

const NORTHWIND = "0b6c1c9e-0000-4000-8000-0000000c0001";
const HARBOR = "0b6c1c9e-0000-4000-8000-0000000c0002";
const LUMEN = "0b6c1c9e-0000-4000-8000-0000000c0003";
const MONTERREY = "0b6c1c9e-0000-4000-8000-0000000c0004";

const INV_A = "0b6c1c9e-0000-4000-8000-0000000e000a";
const INV_B = "0b6c1c9e-0000-4000-8000-0000000e000b";
const INV_C = "0b6c1c9e-0000-4000-8000-0000000e000c";
const MS_1 = "0b6c1c9e-0000-4000-8000-0000000f0001";
const MS_2 = "0b6c1c9e-0000-4000-8000-0000000f0002";

const ADDR_N = "0x1111111111111111111111111111111111111111";
const ADDR_H = "0x2222222222222222222222222222222222222222";
const ADDR_L = "0x3333333333333333333333333333333333333333";
const ADDR_OTHER = "0x9999999999999999999999999999999999999999";
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const TX_A = tx("a");
const TX_B = tx("b");
const TX_C = tx("c");
const TX_M = tx("d");
const DOC_SHA = "5f".repeat(32);

const NOW = new Date("2026-11-02T09:00:00Z");
const OCTOBER = closePackMonth("2026-10", NOW)!;
const COUNTERPARTIES = new Map([
  [NORTHWIND, { name: "Northwind Supplies", address: ADDR_N, sample: false }],
  [HARBOR, { name: "Harbor Print", address: ADDR_H, sample: false }],
  [LUMEN, { name: "Lumen Studio", address: ADDR_L, sample: false }],
  [MONTERREY, { name: "Monterrey Telas", address: null, sample: false }],
]);
const MEMBERS = new Map([
  [OWNER, { email: "owner@pinecrest.test", role: "owner" as const }],
  [APPROVER, { email: "approver@pinecrest.test", role: "approver" as const }],
  [ACCOUNTANT, { email: "accountant@firm.test", role: "accountant" as const }],
]);
const KEYS = [{ id: "1a2b3c4d5e6f7a8b", status: "active" as const, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n" }];

function entry(seq: number, ts: string, action: string, detail: Record<string, unknown>, actor: "agent" | "human" | "system" = "human"): ClosePackLedgerRow {
  const domain = action.startsWith("counterparty") || action === "create_counterparty" || action === "payee_link_created" ? "compliance" : action.startsWith("milestone") || action.startsWith("escrow") ? "contractor" : "ap";
  return {
    seq,
    id: `e-${seq}`,
    ts,
    actor,
    domain,
    action,
    summary: action,
    detail,
    body_hash: `b${seq}`,
    signature: `s${seq}`,
    prev_hash: `p${seq}`,
    hash: `h${seq}`,
    signing_key_id: "1a2b3c4d5e6f7a8b",
  } as ClosePackLedgerRow;
}

function intent(id: string, sourceId: string, overrides: Partial<ClosePackIntentRow> = {}): ClosePackIntentRow {
  return {
    id,
    source_type: "invoice",
    source_id: sourceId,
    status: "confirmed",
    provider: "circle",
    provider_mode: "live",
    provider_tx_id: `circle-${id}`,
    provider_state: "COMPLETE",
    failure_reason: null,
    last_error: null,
    amount: "100.000000",
    token: "USDC",
    destination: ADDR_N,
    tx_hash: TX_A,
    chain: "ARC-TESTNET",
    destination_chain: null,
    mint_tx_hash: null,
    bridge_fee: null,
    payout_route: null,
    network: "arc-testnet",
    fee_usd: "0.004",
    fee_source: "chain_reported",
    transfer_attempt: 1,
    previous_attempts: [],
    batch_key: null,
    created_at: "2026-10-02T14:00:00Z",
    updated_at: "2026-10-02T14:00:05Z",
    submitted_at: "2026-10-02T14:00:00Z",
    executed_at: "2026-10-02T14:00:05Z",
    confirmed_at: "2026-10-02T14:00:05Z",
    ...overrides,
  };
}

function invoice(id: string, overrides: Partial<ClosePackInvoiceRow> = {}): ClosePackInvoiceRow {
  return {
    id,
    direction: "payable",
    counterparty_id: NORTHWIND,
    amount: "100.000000",
    currency: "USDC",
    paid_amount: "100.000000",
    memo: "October paper",
    po_reference: "PO-77",
    due_date: "2026-10-15",
    status: "paid",
    tx_ref: TX_A,
    settled_at: "2026-10-02T14:00:06Z",
    ...overrides,
  };
}

function milestone(id: string, overrides: Partial<ClosePackMilestoneRow> = {}): ClosePackMilestoneRow {
  return {
    id,
    contractor_id: LUMEN,
    title: "Homepage redesign",
    amount: "800.000000",
    status: "paid",
    verified: true,
    verification_method: "github",
    verification_status: "verified",
    verification_source: "https://github.com/acme/app/pull/12",
    verification_checked_at: "2026-10-08T09:00:00Z",
    verified_at: "2026-10-08T09:00:00Z",
    verification_detail: { pullRequest: "https://github.com/acme/app/pull/12", mergedAt: "2026-10-08T08:59:00Z" },
    tx_ref: TX_M,
    settled_at: "2026-10-08T10:00:05Z",
    escrow_state: null,
    escrow_payee: null,
    escrow_amount: null,
    escrow_release_tx_hash: null,
    ...overrides,
  };
}

const CLEAR_LIVE: EvidenceScreening = { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-02T13:00:00Z" };

/** Northwind's address: given by the owner, confirmed by the approver with the payee lock on and a 24-hour wait. */
const NORTHWIND_ADDRESS = [
  entry(2, "2026-10-01T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: NORTHWIND, address: ADDR_N }),
  entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, chain: "ARC-TESTNET", via: "confirm", payeeLock: { coolingHours: 24 } }),
];

/** Bill A: the agent paid it within its rules on Oct 2, 30 hours after the address was given. */
const AGENT_PAID = [
  entry(10, "2026-10-02T10:00:00Z", "create_invoice", {
    by: OWNER,
    invoiceId: INV_A,
    counterpartyId: NORTHWIND,
    amount: 100,
    currency: "USDC",
    invoiceNumber: "INV-2041",
    poReference: "PO-77",
    goodsReceived: true,
    document: { kind: "pdf", reader: "anthropic", sha256: DOC_SHA },
  }),
  entry(
    12,
    "2026-10-02T14:00:00Z",
    "ap_pay",
    {
      invoiceId: INV_A,
      counterpartyId: NORTHWIND,
      decision: { action: "pay" },
      decisionMode: "anthropic",
      guardrailBlocked: false,
      guardrailRule: null,
      observed: { amount: 100, paymentLimit: 500, riskLevel: "clear", poReference: "PO-77", goodsReceived: true, purchaseOrderRequired: true, duplicateCheck: { matchesTotal: 0 } },
      onChainLimit: { verdict: { state: "allowed" } },
      execution: { txRef: TX_A, resultingStatus: "paid" },
    },
    "agent"
  ),
];

/** Bill B: held above the figure for two approvals, co-signed by the accountant, then approved and paid by the approver. */
const HARBOR_ADDRESS = [entry(4, "2026-10-03T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: HARBOR, address: ADDR_H })];
const TWO_APPROVALS = [
  entry(20, "2026-10-10T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_B, counterpartyId: HARBOR, amount: 1250, currency: "USDC", via: "xero", xero: { invoiceId: "x-1", invoiceNumber: "XB-88" } }),
  entry(
    21,
    "2026-10-10T09:05:00Z",
    "ap_hold",
    {
      invoiceId: INV_B,
      counterpartyId: HARBOR,
      decision: { action: "hold" },
      decisionMode: "deepseek",
      guardrailBlocked: true,
      guardrailRule: "workspace.two_approvals",
      observed: { amount: 1250, paymentLimit: 5000, riskLevel: "clear" },
      execution: { txRef: null, resultingStatus: "held" },
    },
    "agent"
  ),
  entry(22, "2026-10-11T10:00:00Z", "approval_given", { by: ACCOUNTANT, invoiceId: INV_B, counterpartyId: HARBOR, amount: 1250, currency: "USDC", address: ADDR_H, twoApprovalsAbove: 1000, cosign: true }),
  entry(23, "2026-10-12T11:00:02Z", "approval_paid", {
    by: APPROVER,
    invoiceId: INV_B,
    counterpartyId: HARBOR,
    amount: 1250,
    currency: "USDC",
    amountPaid: 1250,
    txRef: TX_B,
    status: "paid",
    approvals: [
      { by: ACCOUNTANT, at: "2026-10-11T10:00:00.000Z" },
      { by: APPROVER, at: "2026-10-12T11:00:00.000Z" },
    ],
    twoApprovalsAbove: 1000,
  }),
];
const PAY_A = intent("pay-a", INV_A);
const PAY_B = intent("pay-b", INV_B, {
  amount: "1250.000000",
  destination: ADDR_H,
  tx_hash: TX_B,
  created_at: "2026-10-12T11:00:01Z",
  submitted_at: "2026-10-12T11:00:01Z",
  executed_at: "2026-10-12T11:00:04Z",
  updated_at: "2026-10-12T11:00:04Z",
  confirmed_at: "2026-10-12T11:00:04Z",
});
const BILL_A = invoice(INV_A);
const BILL_B = invoice(INV_B, { counterparty_id: HARBOR, amount: "1250.000000", paid_amount: "1250.000000", memo: null, po_reference: null, due_date: "2026-10-20", tx_ref: TX_B });

function input(overrides: Partial<ClosePackInput> = {}): ClosePackInput {
  return {
    workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" },
    network: "arc-testnet",
    month: OCTOBER,
    now: NOW,
    intents: [PAY_B, PAY_A],
    invoices: [BILL_A, BILL_B],
    milestones: [],
    counterparties: COUNTERPARTIES,
    documentPayTo: new Map(),
    entries: [...NORTHWIND_ADDRESS, ...HARBOR_ADDRESS, ...AGENT_PAID, ...TWO_APPROVALS],
    screening: new Map<string, EvidenceScreening | null | "unread">([
      ["pay-a", CLEAR_LIVE],
      ["pay-b", null],
    ]),
    walletListSince: "2026-09-01T00:00:00Z",
    members: MEMBERS,
    people: "email",
    keys: KEYS,
    ledgerHead: { seq: 99, hash: "h99" },
    cut: false,
    ...overrides,
  };
}

const rowOf = (pack: ClosePack, paymentId: string): ClosePackRow => {
  const row = pack.rows.find((candidate) => candidate.paymentId === paymentId);
  if (!row) throw new Error(`no row ${paymentId}`);
  return row;
};

describe("which payments are rows (close pack CP2)", () => {
  it("lists one row per payment Circle confirmed in the month, oldest first", () => {
    const pack = buildClosePack(input());
    expect(pack.rows.map((row) => row.paymentId)).toEqual(["pay-a", "pay-b"]);
    expect(pack.rows[0]).toMatchObject({
      source: { kind: "invoice", id: INV_A },
      paidAt: "2026-10-02T14:00:05Z",
      sentAt: "2026-10-02T14:00:00Z",
      amount: "100.000000",
      token: "USDC",
      discount: null,
      simulated: false,
      shadow: false,
      evidencePath: `/o/pinecrest-studio/evidence/invoice/${INV_A}`,
    });
    expect(pack.month).toEqual(OCTOBER);
    expect(pack.ended).toBe(true);
    expect(pack.readAt).toBe(NOW.toISOString());
    expect(pack.network).toEqual({ id: "arc-testnet", label: "Arc testnet" });
    expect(pack.workspace).toEqual({ slug: "pinecrest-studio", name: "Pinecrest Studio" });
    expect(pack.ledgerHead).toEqual({ seq: 99, hash: "h99" });
  });

  it("leaves out a payment confirmed before or after the month", () => {
    const before = intent("pay-before", INV_A, { created_at: "2026-09-30T10:00:00Z", submitted_at: "2026-09-30T10:00:00Z", confirmed_at: "2026-09-30T23:59:59Z" });
    const after = intent("pay-after", INV_A, { created_at: "2026-11-01T00:00:00Z", submitted_at: "2026-11-01T00:00:00Z", confirmed_at: "2026-11-01T00:00:01Z" });
    const pack = buildClosePack(input({ intents: [before, after] }));
    expect(pack.rows).toEqual([]);
    expect(pack.notSettled).toEqual([]);
  });

  it("makes each payment a row of exactly one month: the one Circle confirmed it in", () => {
    const later = new Date("2026-12-05T00:00:00Z");
    const intents = [
      intent("p1", INV_A, { created_at: "2026-09-29T10:00:00Z", submitted_at: "2026-09-29T10:00:00Z", confirmed_at: "2026-10-01T00:00:00Z" }),
      intent("p2", INV_A, { created_at: "2026-10-31T23:00:00Z", submitted_at: "2026-10-31T23:00:00Z", confirmed_at: "2026-11-01T00:00:00Z" }),
      intent("p3", INV_A, { created_at: "2026-09-30T23:59:00Z", submitted_at: "2026-09-30T23:59:00Z", confirmed_at: "2026-09-30T23:59:59.999Z" }),
      intent("p4", INV_A, { created_at: "2026-11-15T10:00:00Z", submitted_at: "2026-11-15T10:00:00Z", confirmed_at: "2026-11-15T10:00:01Z" }),
    ];
    const months = ["2026-09", "2026-10", "2026-11"].map((key) => buildClosePack(input({ intents, month: closePackMonth(key, later)!, now: later })));
    const rowsOf = (id: string) => months.flatMap((pack) => (pack.rows.some((row) => row.paymentId === id) ? [pack.month.key] : []));
    expect(rowsOf("p1")).toEqual(["2026-10"]);
    expect(rowsOf("p2")).toEqual(["2026-11"]);
    expect(rowsOf("p3")).toEqual(["2026-09"]);
    expect(rowsOf("p4")).toEqual(["2026-11"]);
  });

  it("counts a payment whose bill is gone, and lists it nowhere", () => {
    const gone = intent("pay-gone", "0b6c1c9e-0000-4000-8000-0000000e00ff");
    const pack = buildClosePack(input({ intents: [PAY_A, gone] }));
    expect(pack.rows.map((row) => row.paymentId)).toEqual(["pay-a"]);
    expect(pack.totals.withoutBill).toBe(1);
  });

  it("skips a payment whose source is a receivable", () => {
    const receivable = invoice(INV_C, { direction: "receivable" });
    const pack = buildClosePack(input({ intents: [PAY_A, intent("pay-r", INV_C)], invoices: [BILL_A, receivable] }));
    expect(pack.rows.map((row) => row.paymentId)).toEqual(["pay-a"]);
    expect(pack.totals.withoutBill).toBe(0);
    expect(pack.notSettled).toEqual([]);
  });
});

describe("what was not settled in the month (close pack CP3)", () => {
  const open = (id: string, overrides: Partial<ClosePackIntentRow>) =>
    intent(id, INV_C, {
      created_at: "2026-10-20T10:00:00Z",
      submitted_at: "2026-10-20T10:00:00Z",
      updated_at: "2026-10-20T10:00:30Z",
      executed_at: "2026-10-20T10:00:30Z",
      confirmed_at: null,
      tx_hash: null,
      ...overrides,
    });
  const billC = invoice(INV_C, { status: "held", tx_ref: null, paid_amount: null });

  it("names each state, with Circle's reason or Vestiarion's error", () => {
    const intents = [
      open("later", { status: "confirmed", created_at: "2026-10-31T22:00:00Z", submitted_at: "2026-10-31T22:00:00Z", confirmed_at: "2026-11-01T01:00:00Z", tx_hash: TX_C }),
      open("waiting", { status: "created", submitted_at: null, provider_tx_id: null, provider_state: null }),
      open("flight", { status: "pending", provider_state: "SENT" }),
      open("read-failed", { status: "failed", provider_state: "SENT" }),
      open("unknown", { status: "failed", provider_tx_id: null, provider_state: null, last_error: `Circle did not answer, so it ${MAY_HAVE_BEEN_ACCEPTED}.` }),
      open("gateway", { status: "failed", provider_state: "GATEWAY_FAILED", failure_reason: "attestation expired" }),
      open("failed", { status: "failed", provider_state: "FAILED", failure_reason: "INSUFFICIENT_FUNDS" }),
      open("cancelled", { status: "failed", provider_state: "CANCELLED" }),
      open("not-sent", { status: "failed", provider_tx_id: null, provider_state: null, last_error: "The wallet held too little USDC." }),
      open("refunded", { status: "failed", provider_tx_id: "blindpay:po_refund1", provider_state: "FAILED", payout_route: "bank" }),
    ];
    const pack = buildClosePack(input({ intents, invoices: [billC] }));
    expect(pack.rows).toEqual([]);
    const states = Object.fromEntries(pack.notSettled.map((payment) => [payment.paymentId, payment.state]));
    expect(states).toEqual({
      later: "settled_later",
      waiting: "waiting",
      flight: "in_flight",
      "read-failed": "in_flight",
      unknown: "unknown",
      gateway: "gateway_failed",
      failed: "failed",
      cancelled: "cancelled",
      "not-sent": "not_sent",
      refunded: "refunded",
    });
    const of = (id: string) => pack.notSettled.find((payment) => payment.paymentId === id)!;
    expect(of("later")).toMatchObject({ sentAt: "2026-10-31T22:00:00Z", settledAt: "2026-11-01T01:00:00Z", txHash: TX_C, explorerUrl: `https://explorer.testnet.arc.io/tx/${TX_C}` });
    expect(openStateWords(of("later"), OCTOBER)).toBe("Sent on 2026-10-31 22:00 UTC, settled on 2026-11-01 01:00 UTC: it counts in November 2026's pack.");
    expect(of("waiting").sentAt).toBeNull();
    expect(openStateWords(of("waiting"), OCTOBER)).toBe("Waiting to be sent.");
    expect(openStateWords(of("flight"), OCTOBER)).toBe("Sent on 2026-10-20 10:00 UTC, not confirmed yet.");
    expect(openStateWords(of("unknown"), OCTOBER)).toBe("Outcome unknown: Circle did not answer when it was sent, so it may have taken the transfer.");
    expect(openStateWords(of("gateway"), OCTOBER)).toBe("Gateway reported it failed, but it may still be minted on the payee's chain.");
    expect(of("failed").reason).toBe("FAILED: INSUFFICIENT_FUNDS");
    expect(openStateWords(of("failed"), OCTOBER)).toBe("The transfer failed (FAILED: INSUFFICIENT_FUNDS). The payee was not paid.");
    expect(openStateWords(of("cancelled"), OCTOBER)).toBe("Circle cancelled the transfer. The payee was not paid.");
    expect(of("not-sent").reason).toBe("The wallet held too little USDC");
    expect(openStateWords(of("not-sent"), OCTOBER)).toBe("Not sent: it stopped before Circle took the transfer (The wallet held too little USDC). The payee was not paid.");
    expect(openStateWords(of("refunded"), OCTOBER)).toBe("BlindPay refunded the bank payout, so the USDC came back. The vendor was not paid.");
    expect(of("failed")).toMatchObject({ payee: { counterpartyId: NORTHWIND, name: "Northwind Supplies" }, amount: "100.000000", token: "USDC", simulated: false, evidencePath: `/o/pinecrest-studio/evidence/invoice/${INV_C}` });
    expect(pack.totals.notSettled).toEqual({ settled_later: 1, waiting: 1, in_flight: 2, unknown: 1, gateway_failed: 1, failed: 1, cancelled: 1, not_sent: 1, refunded: 1 });
    expect(pack.totals.onChain).toEqual([]);
  });

  it("lists a payment sent in the month that settled in the next as settled later, and as a row of that next month", () => {
    const retried = intent("retried", INV_A, {
      created_at: "2026-09-20T10:00:00Z",
      submitted_at: "2026-10-30T10:00:00Z",
      confirmed_at: "2026-11-02T08:00:00Z",
      transfer_attempt: 2,
      previous_attempts: [{ attempt: 1, providerState: "FAILED", failureReason: "INSUFFICIENT_FUNDS", failedAt: "2026-09-20T10:01:00Z" }],
    });
    const october = buildClosePack(input({ intents: [retried], invoices: [BILL_A] }));
    expect(october.notSettled.map((payment) => [payment.paymentId, payment.state])).toEqual([["retried", "settled_later"]]);
    const november = buildClosePack(input({ intents: [retried], invoices: [BILL_A], month: closePackMonth("2026-11", NOW)! }));
    expect(november.ended).toBe(false);
    expect(rowOf(november, "retried").transaction.earlierAttempts).toBe(1);
  });
});

describe("amounts and totals (close pack CP6)", () => {
  it("adds decimals in millionths: 0.1 and 0.2 are 0.300000", () => {
    expect(addDecimals(["0.1", "0.2"])).toBe("0.300000");
    expect(addDecimals([0.1, 0.2])).toBe("0.300000");
    expect(addDecimals([])).toBe("0.000000");
    expect(toDecimal(1250.5)).toBe("1250.500000");
    expect(toDecimal("12.5")).toBe("12.500000");
    expect(toDecimal("1250.500000")).toBe("1250.500000");
    expect(toDecimal("0.0000005")).toBe("0.000001");
    expect(toDecimal(null)).toBeNull();
    expect(toDecimal(undefined)).toBeNull();
    expect(toDecimal("")).toBeNull();
    expect(toDecimal("not a number")).toBeNull();
  });

  it("totals each token apart, never USDC plus EURC", () => {
    const eurc = intent("pay-e", INV_C, { token: "EURC", amount: "50.000000", tx_hash: TX_C, confirmed_at: "2026-10-20T10:00:00Z" });
    const billC = invoice(INV_C, { currency: "EURC", amount: "50.000000", paid_amount: null, tx_ref: TX_C });
    const pack = buildClosePack(input({ intents: [PAY_A, PAY_B, eurc], invoices: [BILL_A, BILL_B, billC] }));
    expect(pack.totals.onChain).toEqual([
      { token: "USDC", payments: 2, amount: "1350.000000", routeFeesUsdc: "0.000000" },
      { token: "EURC", payments: 1, amount: "50.000000", routeFeesUsdc: "0.000000" },
    ]);
    expect(rowOf(pack, "pay-e").token).toBe("EURC");
  });

  it("sums 0.1 and 0.2 paid to 0.300000", () => {
    const one = intent("p-1", INV_A, { amount: "0.1" });
    const two = intent("p-2", INV_C, { amount: 0.2, tx_hash: TX_C, confirmed_at: "2026-10-03T00:00:00Z" });
    const pack = buildClosePack(input({ intents: [one, two], invoices: [invoice(INV_A, { paid_amount: null, amount: "0.1" }), invoice(INV_C, { paid_amount: null, amount: "0.2", tx_ref: TX_C })] }));
    expect(pack.totals.onChain).toEqual([{ token: "USDC", payments: 2, amount: "0.300000", routeFeesUsdc: "0.000000" }]);
  });

  it("totals a sandbox's simulated payments apart", () => {
    const sim = intent("pay-sim", INV_C, { provider: "simulate", provider_mode: "simulate", provider_tx_id: "sim_pay-sim", tx_hash: "sim_pay-sim", fee_source: "simulated_profile", confirmed_at: "2026-10-21T00:00:00Z" });
    const pack = buildClosePack(input({ intents: [PAY_A, sim], invoices: [BILL_A, invoice(INV_C, { tx_ref: "sim_pay-sim" })] }));
    expect(pack.totals.onChain).toEqual([{ token: "USDC", payments: 1, amount: "100.000000", routeFeesUsdc: "0.000000" }]);
    expect(pack.totals.simulated).toEqual([{ token: "USDC", payments: 1, amount: "100.000000", routeFeesUsdc: "0.000000" }]);
    expect(rowOf(pack, "pay-sim").simulated).toBe(true);
  });

  it("sums route fees and never network fees", () => {
    const cctp = (id: string, fee: string, digit: string) =>
      intent(id, id === "c1" ? INV_A : INV_C, { destination_chain: "BASE-SEPOLIA", payout_route: "cctp", tx_hash: tx(digit), mint_tx_hash: tx(String(Number(digit) + 1)), bridge_fee: fee, fee_usd: "0.010000" });
    const pack = buildClosePack(input({ intents: [cctp("c1", "0.12", "1"), cctp("c2", "0.05", "3")], invoices: [invoice(INV_A, { tx_ref: tx("2") }), invoice(INV_C, { tx_ref: tx("4") })] }));
    expect(pack.totals.onChain).toEqual([{ token: "USDC", payments: 2, amount: "200.000000", routeFeesUsdc: "0.170000" }]);
    expect(Object.keys(pack.totals.onChain[0])).not.toContain("networkFeesUsd");
    expect(pack.rows.map((row) => row.transaction.networkFeeUsd)).toEqual(["0.010000", "0.010000"]);
  });

  it("pays a discounted bill's paid_amount, and shows what the discount took off", () => {
    const discounted = invoice(INV_A, { amount: "1000.000000", paid_amount: "980.000000" });
    const pack = buildClosePack(input({ intents: [intent("pay-d", INV_A, { amount: "1000.000000" })], invoices: [discounted] }));
    const row = rowOf(pack, "pay-d");
    expect(row.amount).toBe("980.000000");
    expect(row.discount).toBe("20.000000");
    expect(billWords(row)).toBe("Invoice INV-2041, 1,000.00 USDC, due 2026-10-15. 20.00 USDC off for paying early");
  });

  it("counts shadow-mode rows inside the on-chain totals", () => {
    const shadowPay = entry(
      13,
      "2026-10-02T14:00:00Z",
      "ap_pay",
      { ...AGENT_PAID[1].detail, shadow: true },
      "agent"
    );
    const pack = buildClosePack(input({ entries: [...NORTHWIND_ADDRESS, AGENT_PAID[0], shadowPay, ...HARBOR_ADDRESS, ...TWO_APPROVALS] }));
    expect(pack.totals.shadow).toBe(1);
    expect(pack.totals.onChain[0].payments).toBe(2);
    expect(rowOf(pack, "pay-a").shadow).toBe(true);
  });
});

describe("the approval chain (close pack CP7)", () => {
  it("names the agent's decision for a bill it paid within its rules, with no approvals", () => {
    const row = rowOf(buildClosePack(input()), "pay-a");
    expect(row.approval.authorizedBy).toBe("code");
    expect(row.approval.agent).toEqual({ action: "ap_pay", decider: "Claude", guardrailRule: null, shadow: false, at: "2026-10-02T14:00:00Z", entry: 12 });
    expect(row.approval.approvals).toEqual([]);
    expect(row.approval.verdict).toBeNull();
    expect(row.approval.flags).toEqual({ soleApprover: false, addressGiverApproved: false, firstPayment: false, fewApprovers: false });
    expect(decidedLines(row)).toEqual(["Claude decided to pay it."]);
    expect(approvedLines(row)).toEqual(["No person approved it: code checked it and the agent paid it."]);
  });

  it("names the accountant's co-sign and then the approver's payment, each with their role now", () => {
    const row = rowOf(buildClosePack(input()), "pay-b");
    expect(row.approval.authorizedBy).toBe("two_people");
    expect(row.approval.agent).toMatchObject({ action: "ap_hold", decider: "DeepSeek", guardrailRule: "workspace.two_approvals", entry: 21 });
    expect(row.approval.approvals).toEqual([
      { who: { kind: "member", userId: ACCOUNTANT, email: "accountant@firm.test", roleNow: "accountant" }, at: "2026-10-11T10:00:00.000Z", cosign: true, paid: false, via: null, entry: 22 },
      { who: { kind: "member", userId: APPROVER, email: "approver@pinecrest.test", roleNow: "approver" }, at: "2026-10-12T11:00:00.000Z", cosign: false, paid: true, via: null, entry: 23 },
    ]);
    expect(approvedLines(row)).toEqual(["Co-signed by accountant@firm.test (accountant) on 2026-10-11 10:00 UTC", "Approved and paid by approver@pinecrest.test (approver) on 2026-10-12 11:00 UTC"]);
    expect(decidedLines(row)).toEqual(["The agent held it for a person: it is above the figure where two people approve."]);
  });

  it("names one approval from Telegram, and the flags the paying entry recorded", () => {
    const entries = [
      entry(40, "2026-10-14T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_C, counterpartyId: NORTHWIND, amount: 50, currency: "USDC" }),
      entry(41, "2026-10-14T09:01:00Z", "ap_hold", { invoiceId: INV_C, counterpartyId: NORTHWIND, decision: { action: "hold" }, decisionMode: "heuristic", guardrailBlocked: true, guardrailRule: "invoice.match_incomplete", observed: { amount: 50, poReference: null, goodsReceived: false } }, "agent"),
      entry(42, "2026-10-14T12:30:00Z", "approval_paid", { by: OWNER, invoiceId: INV_C, counterpartyId: NORTHWIND, txRef: TX_C, status: "paid", via: "telegram", linkId: "tl-1", soleApprover: true, addressGiverApproved: true, firstPayment: true, fewApprovers: true }),
    ];
    const pack = buildClosePack(input({ intents: [intent("pay-c", INV_C, { tx_hash: TX_C, confirmed_at: "2026-10-14T12:30:05Z" })], invoices: [invoice(INV_C, { tx_ref: TX_C })], entries: [...NORTHWIND_ADDRESS, ...entries] }));
    const row = rowOf(pack, "pay-c");
    expect(row.approval.authorizedBy).toBe("person");
    expect(row.approval.approvals).toEqual([
      { who: { kind: "member", userId: OWNER, email: "owner@pinecrest.test", roleNow: "owner" }, at: "2026-10-14T12:30:00Z", cosign: false, paid: true, via: "telegram", entry: 42 },
    ]);
    expect(row.approval.flags).toEqual({ soleApprover: true, addressGiverApproved: true, firstPayment: true, fewApprovers: true });
    expect(approvedLines(row)).toEqual([
      "Approved and paid by owner@pinecrest.test (owner) on 2026-10-14 12:30 UTC, from Telegram",
      "Paid by the workspace's only approver.",
      "The person who gave the address made its first payment, as the workspace's only approver.",
      "Approved by whoever entered it or gave its address, as fewer than two others could approve.",
      "The first payment to this address.",
    ]);
    expect(decidedLines(row)).toEqual(["The agent held it for a person: its purchase order or goods receipt was missing."]);
    expect(row.checks.guardrails.text).toBe("The agent held it: its purchase order or goods receipt was missing. A person decided to pay it.");
  });

  it("carries a shadow-mode verdict on the agent's decision", () => {
    const shadowPay = entry(12, "2026-10-02T14:00:00Z", "ap_pay", { ...AGENT_PAID[1].detail, shadow: true }, "agent");
    const verdict = entry(14, "2026-10-03T09:00:00Z", "decision_verdict", { by: OWNER, entrySeq: 12, subject: "invoice", subjectId: INV_A, agentAction: "ap_pay", verdict: "agree", reason: null });
    const row = rowOf(buildClosePack(input({ intents: [PAY_A], entries: [...NORTHWIND_ADDRESS, AGENT_PAID[0], shadowPay, verdict] })), "pay-a");
    expect(row.shadow).toBe(true);
    expect(row.approval.agent?.shadow).toBe(true);
    expect(row.approval.verdict).toEqual({ verdict: "agree", who: { kind: "member", userId: OWNER, email: "owner@pinecrest.test", roleNow: "owner" }, at: "2026-10-03T09:00:00Z", entry: 14 });
    expect(decidedLines(row)).toEqual(["Claude decided to pay it in shadow mode.", "owner@pinecrest.test agreed with the agent's decision in shadow mode on 2026-10-03 09:00 UTC."]);
    expect(row.entries).toContain(14);
  });

  it("names a milestone the agent released, and one a person paid now", () => {
    const entries = [
      entry(50, "2026-10-05T09:00:00Z", "create_milestone", { by: OWNER, milestoneId: MS_1, counterpartyId: LUMEN }),
      entry(51, "2026-10-08T09:00:00Z", "verify_milestone_github", { milestoneId: MS_1, pullRequest: "https://github.com/acme/app/pull/12" }, "system"),
      entry(52, "2026-10-08T10:00:00Z", "milestone_release", { milestoneId: MS_1, counterpartyId: LUMEN, decision: { action: "release" }, decisionMode: "anthropic", guardrailBlocked: false, observed: { amount: 800, paymentLimit: 1000, riskLevel: "clear" }, execution: { txRef: TX_M, resultingStatus: "paid" } }, "agent"),
      entry(60, "2026-10-09T09:00:00Z", "milestone_hold", { milestoneId: MS_2, counterpartyId: LUMEN, decision: { action: "hold" }, decisionMode: "heuristic", guardrailBlocked: true, guardrailRule: "counterparty.payment_limit", observed: { amount: 1500, paymentLimit: 1000 } }, "agent"),
      entry(61, "2026-10-09T10:00:00Z", "verify_milestone_manual", { by: OWNER, milestoneId: MS_2 }),
      entry(62, "2026-10-09T10:05:00Z", "milestone_approval_paid", { by: OWNER, milestoneId: MS_2, counterpartyId: LUMEN, amount: 1500, currency: "USDC", overrode: "held", txRef: tx("e"), status: "paid" }),
      entry(5, "2026-10-01T07:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: LUMEN, address: ADDR_L }),
    ];
    const intents = [
      intent("pay-m1", MS_1, { source_type: "milestone", amount: "800.000000", destination: ADDR_L, tx_hash: TX_M, confirmed_at: "2026-10-08T10:00:05Z" }),
      intent("pay-m2", MS_2, { source_type: "milestone", amount: "1500.000000", destination: ADDR_L, tx_hash: tx("e"), confirmed_at: "2026-10-09T10:05:05Z" }),
    ];
    const milestones = [milestone(MS_1), milestone(MS_2, { title: "Brand guide", amount: "1500.000000", verification_method: "manual", verification_status: "verified", verification_source: null, verification_detail: null, tx_ref: tx("e") })];
    const pack = buildClosePack(input({ intents, invoices: [], milestones, entries }));
    const released = rowOf(pack, "pay-m1");
    expect(released.bill).toEqual({ kind: "milestone", id: MS_1, title: "Homepage redesign", amount: "800.000000", currency: "USDC", entry: 50 });
    expect(released.approval.authorizedBy).toBe("code");
    expect(decidedLines(released)).toEqual(["Claude decided to release it."]);
    expect(billWords(released)).toBe('Milestone "Homepage redesign", 800.00 USDC');
    expect(released.evidencePath).toBe(`/o/pinecrest-studio/evidence/milestone/${MS_1}`);
    const paidNow = rowOf(pack, "pay-m2");
    expect(paidNow.approval.authorizedBy).toBe("person");
    expect(paidNow.approval.approvals).toEqual([{ who: { kind: "member", userId: OWNER, email: "owner@pinecrest.test", roleNow: "owner" }, at: "2026-10-09T10:05:00Z", cosign: false, paid: true, via: null, entry: 62 }]);
    expect(paidNow.approval.agent).toMatchObject({ action: "milestone_hold", decider: "The written policy", guardrailRule: "counterparty.payment_limit" });
    expect(paidNow.checks.milestone).toMatchObject({ kind: "stated", text: "The work was verified by hand by owner@pinecrest.test.", entries: [61] });
  });

  describe("a person's approval that only recorded a transfer the agent had sent", () => {
    // The agent's ap_pay sent the transfer; Approvals listed the bill, and a person's approval only reconciled it
    // (`transferExists` in approvals.ts). The settlement track names the ap_pay as what let it go, and so does the pack.
    const reconciledBy = (seq: number, ts: string, txRef: string, extra: Record<string, unknown> = {}) =>
      entry(seq, ts, "approval_paid", { by: APPROVER, invoiceId: INV_A, counterpartyId: NORTHWIND, amount: 100, currency: "USDC", amountPaid: 100, txRef, status: "paid", attempt: 1, ...extra });
    const agentSent = (resulting: Record<string, unknown>, txRef = TX_A) =>
      entry(12, "2026-10-02T14:00:00Z", "ap_pay", { ...AGENT_PAID[1].detail, execution: { txRef, ...resulting } }, "agent");
    const expectCode = (row: ClosePackRow, recordSeq: number) => {
      expect(row.approval.authorizedBy).toBe("code");
      expect(row.approval.approvals).toEqual([]);
      expect(row.approval.agent).toMatchObject({ action: "ap_pay", entry: 12 });
      expect(row.checks.guardrails).toMatchObject({ kind: "checked", text: "Code checked it before it was sent.", entries: [12] });
      expect(approvedLines(row)).toEqual(["No person approved it: code checked it and the agent paid it."]);
      expect(decidedLines(row)).toEqual(["Claude decided to pay it."]);
      expect(row.record).toMatchObject({ seq: recordSeq, action: "approval_paid" });
      expect(row.entries).toContain(12);
      expect(row.entries).toContain(recordSeq);
    };
    const reconciled = { executed_at: "2026-10-02T16:00:05Z", updated_at: "2026-10-02T16:00:05Z", confirmed_at: "2026-10-02T16:00:05Z" };

    it("is the agent's payment when its ap_pay sent the transfer and went out, or was held only because Circle's read failed", () => {
      for (const resulting of [{ resultingStatus: "matched" }, { resultingStatus: "held" }]) {
        const entries = [...NORTHWIND_ADDRESS, AGENT_PAID[0], agentSent(resulting), reconciledBy(15, "2026-10-02T16:00:00Z", TX_A)];
        const row = rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, reconciled)], invoices: [BILL_A], entries })), "pay-a");
        expectCode(row, 15);
      }
    });

    it("is the agent's payment for a CCTP payout whose mint was late: its ap_pay sent the burn, a reconcile held it, an approval recorded it", () => {
      const burn = tx("6");
      const mint = tx("7");
      const entries = [
        ...NORTHWIND_ADDRESS,
        AGENT_PAID[0],
        agentSent({ resultingStatus: "matched" }, burn),
        entry(13, "2026-10-02T15:00:00Z", "ap_reconcile", { invoiceId: INV_A, counterpartyId: NORTHWIND, reconciled: true, execution: { txRef: burn, resultingStatus: "held" } }, "agent"),
        reconciledBy(15, "2026-10-02T16:00:00Z", burn),
      ];
      const cctp = intent("pay-a", INV_A, { ...reconciled, destination_chain: "BASE-SEPOLIA", payout_route: "cctp", tx_hash: burn, mint_tx_hash: mint, bridge_fee: "0.01" });
      const row = rowOf(buildClosePack(input({ intents: [cctp], invoices: [invoice(INV_A, { tx_ref: mint })], entries })), "pay-a");
      expectCode(row, 15);
    });

    it("is the agent's payment by the ledger alone when the intent has no submitted_at", () => {
      const entries = [...NORTHWIND_ADDRESS, AGENT_PAID[0], agentSent({ resultingStatus: "held" }), reconciledBy(15, "2026-10-02T16:00:00Z", TX_A)];
      const row = rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, { ...reconciled, submitted_at: null })], invoices: [BILL_A], entries })), "pay-a");
      expectCode(row, 15);
    });

    it("is a person's payment when their approval sent it again after Circle failed the agent's transfer", () => {
      const again = tx("5");
      const entries = [
        ...NORTHWIND_ADDRESS,
        AGENT_PAID[0],
        agentSent({ resultingStatus: "matched" }),
        reconciledBy(15, "2026-10-03T09:00:02Z", again, { attempt: 2, retriedAfter: { providerTxId: "circle-pay-a", providerState: "FAILED", failureReason: "INSUFFICIENT_FUNDS" } }),
      ];
      const retried = intent("pay-a", INV_A, {
        tx_hash: again,
        transfer_attempt: 2,
        previous_attempts: [{ attempt: 1, providerState: "FAILED", failureReason: "INSUFFICIENT_FUNDS", failedAt: "2026-10-02T14:05:00Z" }],
        submitted_at: "2026-10-03T09:00:00Z",
        executed_at: "2026-10-03T09:00:05Z",
        updated_at: "2026-10-03T09:00:05Z",
        confirmed_at: "2026-10-03T09:00:05Z",
      });
      const row = rowOf(buildClosePack(input({ intents: [retried], invoices: [invoice(INV_A, { tx_ref: again })], entries })), "pay-a");
      expect(row.approval.authorizedBy).toBe("person");
      expect(row.approval.approvals).toMatchObject([{ paid: true, entry: 15 }]);
      expect(approvedLines(row)[0]).toBe("Approved and paid by approver@pinecrest.test (approver) on 2026-10-03 09:00 UTC");
      expect(row.record).toMatchObject({ seq: 15, action: "approval_paid" });
    });
  });

  it("names a member by email, a former member by id, and with people by id no email anywhere", () => {
    const leftPaid = TWO_APPROVALS.map((one) => (one.seq === 23 ? entry(23, one.ts, "approval_paid", { ...one.detail, by: LEFT, approvals: [{ by: ACCOUNTANT, at: "2026-10-11T10:00:00.000Z" }, { by: LEFT, at: "2026-10-12T11:00:00.000Z" }] }) : one));
    const pack = buildClosePack(input({ entries: [...NORTHWIND_ADDRESS, ...HARBOR_ADDRESS, ...AGENT_PAID, ...leftPaid] }));
    const last = rowOf(pack, "pay-b").approval.approvals[1];
    expect(last.who).toEqual({ kind: "former_member", userId: LEFT });
    expect(whoWords(last.who)).toBe("a former member (9f8e7d6c)");
    expect(approvedLines(rowOf(pack, "pay-b"))[1]).toBe("Approved and paid by a former member (9f8e7d6c) on 2026-10-12 11:00 UTC");

    const byId = buildClosePack(input({ people: "id" }));
    expect(byId.people).toBe("id");
    expect(JSON.stringify(byId)).not.toContain("@");
    expect(rowOf(byId, "pay-b").approval.approvals[0].who).toEqual({ kind: "member", userId: ACCOUNTANT, email: null, roleNow: "accountant" });
    expect(approvedLines(rowOf(byId, "pay-b"))[0]).toBe("Co-signed by a member (0b6c1c9e) (accountant) on 2026-10-11 10:00 UTC");
  });

  it("names members by id, and says so, when members could not be read", () => {
    const pack = buildClosePack(input({ members: null }));
    expect(pack.unread).toEqual(["members"]);
    expect(rowOf(pack, "pay-b").approval.approvals[0].who).toEqual({ kind: "member", userId: ACCOUNTANT, email: null, roleNow: null });
  });
});

describe("the address and its second person (close pack CP7)", () => {
  const payFor = (entries: ClosePackLedgerRow[], overrides: Partial<ClosePackIntentRow> = {}) =>
    rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, overrides)], invoices: [BILL_A], entries: [...AGENT_PAID, ...entries] })), "pay-a");

  it("is a second person when one member gave it and another confirmed it with Confirm address", () => {
    const row = payFor(NORTHWIND_ADDRESS);
    expect(row.approval.address).toEqual({
      address: ADDR_N,
      mirror: false,
      givenBy: { kind: "member", userId: OWNER, email: "owner@pinecrest.test", roleNow: "owner" },
      givenAt: "2026-10-01T08:00:00Z",
      confirmedBy: { kind: "member", userId: APPROVER, email: "approver@pinecrest.test", roleNow: "approver" },
      confirmedAt: "2026-10-01T09:00:00Z",
      confirmedWith: "confirm",
      secondPerson: true,
      entries: [2, 3],
    });
    expect(addressLines(row)).toEqual([
      "Given by owner@pinecrest.test on 2026-10-01 08:00 UTC",
      "Confirmed by approver@pinecrest.test on 2026-10-01 09:00 UTC, with Confirm address",
      "A second person stood behind it: Yes",
    ]);
  });

  it("is no second person when the same member gave and confirmed it", () => {
    const row = payFor([NORTHWIND_ADDRESS[0], entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: OWNER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm" })]);
    expect(row.approval.address?.secondPerson).toBe(false);
    expect(addressLines(row)[2]).toBe("A second person stood behind it: No");
  });

  it("is not known for a payee link's address confirmed with the lock off", () => {
    const row = payFor([
      NORTHWIND_ADDRESS[0],
      entry(6, "2026-10-01T10:00:00Z", "payee_link_created", { by: OWNER, counterpartyId: NORTHWIND, linkId: "link-1" }),
      entry(7, "2026-10-01T11:00:00Z", "counterparty_address_changed", { via: "payee_link", linkId: "link-1", counterpartyId: NORTHWIND, from: ADDR_OTHER, to: ADDR_N }),
      entry(8, "2026-10-01T12:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm" }),
    ]);
    expect(row.approval.address).toMatchObject({ givenBy: { kind: "payee_link", linkId: "link-1" }, givenAt: "2026-10-01T11:00:00Z", secondPerson: null, confirmedWith: "confirm" });
    expect(row.approval.address?.entries).toEqual([6, 7, 8]);
    expect(addressLines(row)).toEqual([
      "Sent by the payee through their payee link on 2026-10-01 11:00 UTC",
      "Confirmed by approver@pinecrest.test on 2026-10-01 12:00 UTC, with Confirm address",
      "A second person stood behind it: Not known",
    ]);
    expect(row.checks.payeeLock).toMatchObject({ kind: "inferred", text: "The payee lock was off when the address was confirmed." });
  });

  it("names a mirror address as one, with no giver", () => {
    const row = payFor([entry(2, "2026-10-01T08:00:00Z", "create_counterparty", { counterpartyId: NORTHWIND, address: ADDR_N, via: "mirror" })]);
    expect(row.approval.address).toMatchObject({ address: ADDR_N, mirror: true, givenBy: null });
    expect(addressLines(row)).toEqual(["A mirror address Vestiarion made in shadow mode: no person typed it."]);
    expect(row.checks.payeeLock.kind).toBe("not_applicable");
  });

  it("has none for a bank payout", () => {
    const row = bankRow();
    expect(row.approval.address).toBeNull();
    expect(row.payee.address).toBeNull();
    expect(addressLines(row)).toEqual([]);
  });
});

/** A bank payout to Monterrey Telas through BlindPay, approved and paid by the owner. */
function bankRow(): ClosePackRow {
  const entries = [
    entry(90, "2026-10-16T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_C, counterpartyId: MONTERREY, amount: 10, currency: "USDC" }),
    entry(91, "2026-10-16T09:01:00Z", "ap_hold", { invoiceId: INV_C, counterpartyId: MONTERREY, decision: { action: "hold" }, decisionMode: "anthropic", guardrailBlocked: true, guardrailRule: "payout.bank_needs_person", observed: { amount: 10 } }, "agent"),
    entry(92, "2026-10-16T10:00:00Z", "approval_paid", {
      by: OWNER,
      invoiceId: INV_C,
      counterpartyId: MONTERREY,
      txRef: tx("f"),
      status: "paid",
      payout: { route: "bank", provider: "blindpay", quoteId: "qu_1", payoutId: "po_E4ZZ1bJWXRiI", receiverAmount: 173.4, currency: "MXN", rate: 17.34, feesSender: 0, rail: "spei", bankAccount: { bankCode: "012", last4: "4471" } },
    }),
  ];
  const pay = intent("pay-bank", INV_C, { provider_tx_id: "blindpay:po_E4ZZ1bJWXRiI", payout_route: "bank", destination: "0x4444444444444444444444444444444444444444", tx_hash: tx("f"), fee_usd: "0", fee_source: "provider_estimate", confirmed_at: "2026-10-16T10:02:00Z" });
  const pack = buildClosePack(input({ intents: [pay], invoices: [invoice(INV_C, { counterparty_id: MONTERREY, amount: "10.000000", paid_amount: null, tx_ref: tx("f") })], entries }));
  return rowOf(pack, "pay-bank");
}

describe("the verification record (close pack CP8)", () => {
  it("words the agent's guardrails as decisionChecks does", () => {
    const row = rowOf(buildClosePack(input()), "pay-a");
    expect(row.checks.guardrails).toEqual({
      kind: "checked",
      text: "Code checked it before it was sent.",
      notes: ["✓ Purchase order PO-77 on file and the goods received", "✓ Counterparty screened clear", "✓ 100.00 USDC within its 500.00 USDC limit", "✓ No duplicate found", "✓ The spending-limit contract on Arc allowed it"],
      at: "2026-10-02T14:00:00Z",
      entries: [12],
      warn: false,
    });
    expect(checkCell(row.checks.guardrails)).toBe("Checked by code: Code checked it before it was sent.");
  });

  it("names a held bill's rule in words, and has no decision as missing", () => {
    const held = rowOf(buildClosePack(input()), "pay-b");
    expect(held.checks.guardrails.text).toBe("The agent held it: it is above the figure where two people approve. A person decided to pay it.");
    const none = rowOf(buildClosePack(input({ intents: [PAY_A], entries: [...NORTHWIND_ADDRESS, AGENT_PAID[0]] })), "pay-a");
    expect(none.checks.guardrails).toMatchObject({ kind: "missing", text: "No decision of the agent's is recorded.", entries: [] });
    expect(decidedLines(none)).toEqual(["No decision of the agent's is recorded."]);
    expect(none.approval.authorizedBy).toBeNull();
  });

  describe("screening", () => {
    const screened = (check: EvidenceScreening | null | "unread", entries = [...NORTHWIND_ADDRESS, ...AGENT_PAID]) =>
      rowOf(buildClosePack(input({ intents: [PAY_A], entries, screening: new Map([["pay-a", check]]) })), "pay-a");

    it("is verified for a live provider, naming it", () => {
      expect(screened(CLEAR_LIVE).checks.screening).toEqual({ kind: "verified", text: "Northwind Supplies was screened clear by OpenSanctions.", notes: [], at: "2026-10-02T13:00:00Z", entries: [], warn: false });
    });

    it("is checked against the bundled list, and warns for anything but clear", () => {
      expect(screened({ risk_level: "low", source: "simulated-sanctions-list", screening_mode: "simulated", created_at: "2026-10-02T13:00:00Z" }).checks.screening).toMatchObject({
        kind: "checked",
        text: "Northwind Supplies was screened low risk against the bundled list, not a screening service.",
        warn: true,
      });
    });

    it("does not match for OFAC's list of addresses, with a warning", () => {
      const row = screened({ risk_level: "high", source: "ofac-sdn", screening_mode: "live", created_at: "2026-10-02T13:00:00Z" });
      expect(row.checks.screening).toMatchObject({ kind: "contradicted", text: "Northwind Supplies's payout address is on OFAC's SDN list.", warn: true });
      expect(row.checks.walletList).toMatchObject({ kind: "contradicted", text: "Its payout address is on OFAC's SDN list.", warn: true });
    });

    it("is inferred from a risk only the decision recorded", () => {
      expect(screened(null).checks.screening).toMatchObject({ kind: "inferred", text: "Northwind Supplies was clear as the agent's decision recorded; no screening check is on file.", entries: [12] });
    });

    it("is missing with none at all", () => {
      expect(screened(null, [...NORTHWIND_ADDRESS, AGENT_PAID[0]]).checks.screening).toMatchObject({ kind: "missing", text: "Northwind Supplies was not screened before it was paid." });
    });

    it("could not be opened when its read failed, and the pack says so", () => {
      const pack = buildClosePack(input({ screening: new Map<string, EvidenceScreening | null | "unread">([["pay-a", "unread"], ["pay-b", null]]) }));
      expect(rowOf(pack, "pay-a").checks.screening).toMatchObject({ kind: "unreachable", text: "The screening record could not be read just now." });
      expect(rowOf(pack, "pay-b").checks.screening.kind).toBe("inferred");
      expect(pack.unread).toEqual(["screening"]);
    });

    it("reads the check at or before the decision (screeningAnchors)", () => {
      const rest: Omit<ClosePackInput, "screening" | "checks"> = input();
      expect(screeningAnchors(rest)).toEqual(
        new Map([
          ["pay-a", { counterpartyId: NORTHWIND, at: "2026-10-02T14:00:00Z" }],
          ["pay-b", { counterpartyId: HARBOR, at: "2026-10-10T09:05:00Z" }],
        ])
      );
      const undecided = screeningAnchors({ ...rest, entries: [...NORTHWIND_ADDRESS, AGENT_PAID[0]], intents: [PAY_A] });
      expect(undecided.get("pay-a")).toEqual({ counterpartyId: NORTHWIND, at: "2026-10-02T14:00:00Z" });
    });
  });

  describe("OFAC address list", () => {
    it("is checked after the first sweep that checked addresses, and missing before it", () => {
      expect(rowOf(buildClosePack(input()), "pay-a").checks.walletList).toMatchObject({
        kind: "checked",
        text: "Its payout address was not on OFAC's SDN list when it was paid: every screening and payment checks it.",
        warn: false,
      });
      expect(rowOf(buildClosePack(input({ walletListSince: "2026-10-05T00:00:00Z" })), "pay-a").checks.walletList).toMatchObject({
        kind: "missing",
        text: "Paid before Vestiarion checked payout addresses against OFAC's SDN list.",
      });
      expect(rowOf(buildClosePack(input({ walletListSince: null })), "pay-a").checks.walletList.kind).toBe("missing");
    });

    it("does not apply to a bank or a simulated payment", () => {
      expect(bankRow().checks.walletList).toMatchObject({ kind: "not_applicable", text: "A bank payout pays no address on chain." });
      expect(simulatedRow().checks.walletList).toMatchObject({ kind: "not_applicable", text: "A simulated payment pays no address." });
      expect(checkCell(bankRow().checks.walletList)).toBe("Does not apply: A bank payout pays no address on chain.");
    });
  });

  describe("payee lock", () => {
    const locked = (entries: ClosePackLedgerRow[]) => rowOf(buildClosePack(input({ intents: [PAY_A], entries: [...entries, ...AGENT_PAID] })), "pay-a");

    it("is checked when the lock was on and it was sent after the wait, with the hours", () => {
      expect(locked(NORTHWIND_ADDRESS).checks.payeeLock).toEqual({
        kind: "checked",
        text: "The payee lock was on when the address was confirmed, with a 24-hour wait. It was sent 30 hours after the address was given.",
        notes: [],
        at: "2026-10-01T09:00:00Z",
        entries: [2, 3],
        warn: false,
      });
    });

    it("says so for a lock with no wait", () => {
      const row = locked([NORTHWIND_ADDRESS[0], entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm", payeeLock: { coolingHours: 0 } })]);
      expect(row.checks.payeeLock).toMatchObject({ kind: "checked", text: "The payee lock was on when the address was confirmed, with no wait." });
    });

    it("does not match when it was sent before the wait ended", () => {
      const row = locked([NORTHWIND_ADDRESS[0], entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm", payeeLock: { coolingHours: 48 } })]);
      expect(row.checks.payeeLock).toMatchObject({ kind: "contradicted", text: "It was sent before the payee lock's 48-hour wait had ended.", warn: true });
    });

    it("is inferred with the lock off, and missing with no confirmation", () => {
      const off = locked([NORTHWIND_ADDRESS[0], entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm" })]);
      expect(off.checks.payeeLock).toMatchObject({ kind: "inferred", text: "The payee lock was off when the address was confirmed." });
      const unconfirmed = locked([NORTHWIND_ADDRESS[0]]);
      expect(unconfirmed.checks.payeeLock).toMatchObject({ kind: "missing", text: "No confirmation of this address is recorded before it was paid.", entries: [2] });
      expect(addressLines(unconfirmed)[1]).toBe("Not confirmed before it was paid.");
    });

    it("does not match when the ledger last recorded another address", () => {
      const row = locked([...NORTHWIND_ADDRESS, entry(9, "2026-10-02T09:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: ADDR_N, to: ADDR_OTHER })]);
      expect(row.checks.payeeLock).toMatchObject({ kind: "contradicted", text: "The address paid is not the one the ledger last recorded for this payee.", entries: [9], warn: true });
      expect(row.approval.address).toMatchObject({ givenBy: null, givenAt: null });
      expect(addressLines(row)[0]).toBe("No entry names who gave it.");
    });

    it("does not apply to a bank payout", () => {
      expect(bankRow().checks.payeeLock).toMatchObject({ kind: "not_applicable", text: "The payee lock covers addresses on chain only." });
    });

    describe("when the owner changed the lock after the address was confirmed", () => {
      // The address changed at 11:00 and was confirmed under a 48-hour wait; the agent paid it at 14:00, 3 hours later.
      const changed = [
        entry(2, "2026-10-01T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: NORTHWIND, address: ADDR_OTHER }),
        entry(5, "2026-10-02T11:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: ADDR_OTHER, to: ADDR_N }),
        entry(6, "2026-10-02T11:30:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm", payeeLock: { coolingHours: 48 } }),
      ];
      const lockChanged = (to: { on: boolean; coolingHours: number }) => entry(7, "2026-10-02T12:00:00Z", "payee_lock_changed", { by: OWNER, from: { on: true, coolingHours: 48 }, to }, "human");
      const packWith = (change: ClosePackLedgerRow) => buildClosePack(input({ intents: [PAY_A], entries: [...changed, change, ...AGENT_PAID] }));

      it("is stated, citing the change, when the owner turned the lock off or removed its wait before it was paid", () => {
        const cases: Array<[{ on: boolean; coolingHours: number }, string]> = [
          [{ on: false, coolingHours: 48 }, "turned it off"],
          [{ on: true, coolingHours: 0 }, "removed its wait"],
        ];
        for (const [to, eased] of cases) {
          const pack = packWith(lockChanged(to));
          expect(rowOf(pack, "pay-a").checks.payeeLock, eased).toEqual({
            kind: "stated",
            text: `The payee lock was on when the address was confirmed, with a 48-hour wait; owner@pinecrest.test ${eased} on 2026-10-02 12:00 UTC. It was sent 3 hours after the address was given.`,
            notes: [],
            at: "2026-10-02T12:00:00Z",
            entries: [5, 6, 7],
            warn: true,
          });
          expect(rowOf(pack, "pay-a").entries).toContain(7);
          expect(pack.entries.map((one) => one.seq)).toContain(7);
        }
      });

      it("still does not match when the wait it was cut to had not ended either", () => {
        const pack = packWith(lockChanged({ on: true, coolingHours: 24 }));
        expect(rowOf(pack, "pay-a").checks.payeeLock).toMatchObject({ kind: "contradicted", text: "It was sent before the payee lock's 24-hour wait had ended.", entries: [5, 6, 7], warn: true });
      });

      it("reads no change made after it was paid, or before the address was confirmed", () => {
        const after = entry(14, "2026-10-02T15:00:00Z", "payee_lock_changed", { by: OWNER, from: { on: true, coolingHours: 48 }, to: { on: false, coolingHours: 48 } }, "human");
        const before = entry(4, "2026-10-01T09:00:00Z", "payee_lock_changed", { by: OWNER, from: { on: true, coolingHours: 72 }, to: { on: false, coolingHours: 72 } }, "human");
        const pack = buildClosePack(input({ intents: [PAY_A], entries: [before, ...changed, after, ...AGENT_PAID] }));
        expect(rowOf(pack, "pay-a").checks.payeeLock).toMatchObject({ kind: "contradicted", text: "It was sent before the payee lock's 48-hour wait had ended.", entries: [5, 6] });
        expect(pack.entries.map((one) => one.seq)).not.toContain(4);
        expect(pack.entries.map((one) => one.seq)).not.toContain(14);
      });
    });
  });

  describe("the invoice's own address", () => {
    const payTo = (address: string | null) =>
      rowOf(buildClosePack(input({ intents: [PAY_A], documentPayTo: new Map(address ? [[INV_A, address]] : []) })), "pay-a").checks.payTo;

    it("is checked when the document asked for the address paid", () => {
      expect(payTo(ADDR_N.toUpperCase().replace("0X", "0x"))).toMatchObject({ kind: "checked", text: "The address its document asked to be paid to is the one paid.", warn: false });
    });

    it("is stated, with a warning, when the document asked for another", () => {
      expect(payTo(ADDR_OTHER)).toMatchObject({ kind: "stated", text: `Its document asked to be paid to ${ADDR_OTHER}; a person chose to pay the address on file.`, warn: true });
    });

    it("does not apply with none, for a bank payout, or for a milestone", () => {
      expect(payTo(null)).toMatchObject({ kind: "not_applicable", text: "The bill's document named no address of its own." });
      expect(bankRow().checks.payTo.kind).toBe("not_applicable");
      expect(milestoneRow().checks.payTo).toMatchObject({ kind: "not_applicable", text: "A milestone has no invoice document." });
    });
  });

  describe("milestone", () => {
    it("is verified for a GitHub merge, naming the pull request as text and never as a link", () => {
      const check = milestoneRow().checks.milestone;
      expect(check).toEqual({ kind: "verified", text: "GitHub reported pull request acme/app#12 merged.", notes: [], at: "2026-10-08T09:00:00Z", entries: [51], warn: false });
      expect(JSON.stringify(check)).not.toContain("https://");
    });

    it("is stated by hand, inferred for sample data, and missing with a warning when unverified", () => {
      expect(milestoneRow({ verification_method: "manual", verification_source: null, verification_detail: null }, [entry(53, "2026-10-08T09:30:00Z", "verify_milestone_manual", { by: OWNER, milestoneId: MS_1 })]).checks.milestone).toMatchObject({
        kind: "stated",
        text: "The work was verified by hand by owner@pinecrest.test.",
        entries: [53],
      });
      expect(milestoneRow({ verification_method: "seed", verification_status: "verified" }).checks.milestone).toMatchObject({ kind: "inferred", text: "Sample data: marked verified as an example." });
      expect(milestoneRow({ verified: false, verification_method: "manual", verification_status: "unverified" }).checks.milestone).toMatchObject({
        kind: "missing",
        text: "The work was not verified before it was paid.",
        warn: true,
      });
    });

    it("does not apply to a bill", () => {
      expect(rowOf(buildClosePack(input()), "pay-a").checks.milestone).toMatchObject({ kind: "not_applicable", text: "A bill has no milestone to verify." });
    });
  });
});

/** Milestone 1, verified on GitHub and released by the agent. */
function milestoneRow(overrides: Partial<ClosePackMilestoneRow> = {}, more: ClosePackLedgerRow[] = []): ClosePackRow {
  const entries = [
    entry(5, "2026-10-01T07:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: LUMEN, address: ADDR_L }),
    entry(50, "2026-10-05T09:00:00Z", "create_milestone", { by: OWNER, milestoneId: MS_1, counterpartyId: LUMEN }),
    entry(51, "2026-10-08T09:00:00Z", "verify_milestone_github", { milestoneId: MS_1, pullRequest: "https://github.com/acme/app/pull/12" }, "system"),
    ...more,
    entry(52, "2026-10-08T10:00:00Z", "milestone_release", { milestoneId: MS_1, counterpartyId: LUMEN, decision: { action: "release" }, decisionMode: "anthropic", guardrailBlocked: false, execution: { txRef: TX_M, resultingStatus: "paid" } }, "agent"),
  ];
  const pay = intent("pay-m1", MS_1, { source_type: "milestone", amount: "800.000000", destination: ADDR_L, tx_hash: TX_M, confirmed_at: "2026-10-08T10:00:05Z" });
  return rowOf(buildClosePack(input({ intents: [pay], invoices: [], milestones: [milestone(MS_1, overrides)], entries })), "pay-m1");
}

/** A sandbox's simulated payment of bill C. */
function simulatedRow(): ClosePackRow {
  const pay = intent("pay-sim", INV_C, { provider: "simulate", provider_mode: "simulate", provider_tx_id: "sim_pay-sim", tx_hash: "sim_pay-sim", destination: "0x5555555555555555555555555555555555555555", fee_usd: "0.001", fee_source: "simulated_profile" });
  const entries = [entry(95, "2026-10-02T14:00:00Z", "ap_pay", { invoiceId: INV_C, counterpartyId: NORTHWIND, decision: { action: "pay" }, decisionMode: "heuristic", execution: { txRef: "sim_pay-sim", resultingStatus: "paid" } }, "agent")];
  return rowOf(buildClosePack(input({ intents: [pay], invoices: [invoice(INV_C, { tx_ref: "sim_pay-sim" })], entries })), "pay-sim");
}

describe("the transaction (close pack CP9)", () => {
  it("links a direct transfer to Arc's explorer from the network's profile", () => {
    const row = rowOf(buildClosePack(input()), "pay-a");
    expect(row.transaction).toEqual({
      route: "direct",
      txHash: TX_A,
      chain: "ARC-TESTNET",
      chainLabel: "Arc testnet",
      explorerUrl: `https://explorer.testnet.arc.io/tx/${TX_A}`,
      sourceTxHash: null,
      sourceExplorerUrl: null,
      simulatedRef: null,
      note: null,
      networkFeeUsd: "0.004000",
      networkFeeSource: "chain_reported",
      routeFeeUsdc: null,
      earlierAttempts: 0,
    });
    expect(transactionWords(row)).toBe("Transfer on Arc testnet");
    expect(paidToWords(row)).toBe(ADDR_N);
  });

  it("names the mint on Base Sepolia for a CCTP payout, the burn as its source, and the route's fee", () => {
    const burn = tx("1");
    const mint = tx("2");
    const pay = intent("pay-a", INV_A, { destination_chain: "BASE-SEPOLIA", payout_route: "cctp", tx_hash: burn, mint_tx_hash: mint, bridge_fee: "0.12" });
    const row = rowOf(buildClosePack(input({ intents: [pay], invoices: [invoice(INV_A, { tx_ref: mint })] })), "pay-a");
    expect(row.transaction).toMatchObject({
      route: "cctp",
      txHash: mint,
      chain: "BASE-SEPOLIA",
      chainLabel: "Base Sepolia",
      explorerUrl: `https://sepolia.basescan.org/tx/${mint}`,
      sourceTxHash: burn,
      sourceExplorerUrl: `https://explorer.testnet.arc.io/tx/${burn}`,
      routeFeeUsdc: "0.120000",
    });
    expect(transactionWords(row)).toBe("Minted on Base Sepolia, through CCTP from Arc testnet");
  });

  it("says the payee's chain has not minted a CCTP payout yet", () => {
    const pay = intent("pay-a", INV_A, { destination_chain: "BASE-SEPOLIA", payout_route: "cctp", tx_hash: tx("1"), mint_tx_hash: null, bridge_fee: "0.12" });
    const row = rowOf(buildClosePack(input({ intents: [pay] })), "pay-a");
    expect(row.transaction).toMatchObject({ txHash: null, explorerUrl: null, note: "The payee's chain has not minted this payout yet.", sourceTxHash: tx("1") });
  });

  it("names a Gateway payout, an escrow release, a bank payout and a simulated payment", () => {
    const mint = tx("2");
    const gateway = rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, { destination_chain: "BASE-SEPOLIA", payout_route: "gateway", tx_hash: null, mint_tx_hash: mint, bridge_fee: "0.02" })], invoices: [invoice(INV_A, { tx_ref: mint })] })), "pay-a");
    expect(gateway.transaction).toMatchObject({ route: "gateway", txHash: mint, chainLabel: "Base Sepolia", routeFeeUsdc: "0.020000" });
    expect(transactionWords(gateway)).toBe("From a Circle Gateway balance, minted on Base Sepolia");

    const release = tx("7");
    const escrow = rowOf(
      buildClosePack(
        input({
          intents: [intent("pay-m1", MS_1, { source_type: "milestone", amount: "800.000000", destination: ADDR_L, payout_route: "escrow", tx_hash: release })],
          invoices: [],
          milestones: [milestone(MS_1, { tx_ref: release, escrow_state: "released", escrow_payee: ADDR_L, escrow_amount: "800.000000", escrow_release_tx_hash: release })],
          entries: [entry(52, "2026-10-02T14:00:00Z", "milestone_release", { milestoneId: MS_1, counterpartyId: LUMEN, decisionMode: "anthropic", execution: { txRef: release, resultingStatus: "paid" } }, "agent")],
        })
      ),
      "pay-m1"
    );
    expect(escrow.transaction).toMatchObject({ route: "escrow", txHash: release, explorerUrl: `https://explorer.testnet.arc.io/tx/${release}` });
    expect(transactionWords(escrow)).toBe("Released from escrow on Arc testnet");

    const bank = bankRow();
    expect(bank.transaction).toMatchObject({ route: "bank", networkFeeSource: "provider_estimate" });
    expect(bank.payee.bank).toEqual({ provider: "blindpay", bankCode: "012", last4: "4471", rail: "spei", receiverAmount: "173.400000", receiverCurrency: "MXN", payoutId: "po_E4ZZ1bJWXRiI" });
    expect(JSON.stringify(bank.payee)).not.toContain("qu_1");
    expect(transactionWords(bank)).toBe("Bank payout through BlindPay");
    expect(paidToWords(bank)).toBe("Bank account 012 ending 4471, by SPEI, through BlindPay: 173.40 MXN");

    const simulated = simulatedRow();
    expect(simulated.transaction).toMatchObject({ route: "simulated", txHash: null, explorerUrl: null, simulatedRef: "sim_pay-sim", networkFeeSource: "simulated_profile" });
    expect(simulated.approval.address).toBeNull();
    expect(transactionWords(simulated)).toBe("Simulated: nothing moved on chain (sim_pay-sim)");
    expect(paidToWords(simulated)).toBe("A simulated payee address: nothing was paid on chain.");
  });

  it("builds no link from a value that is not a 32-byte hash", () => {
    const row = rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, { tx_hash: "0x1234" })] })), "pay-a");
    expect(row.transaction.txHash).toBeNull();
    expect(row.transaction.explorerUrl).toBeNull();
    const open = buildClosePack(input({ intents: [intent("pay-x", INV_C, { status: "pending", confirmed_at: null, tx_hash: "javascript:alert(1)", created_at: "2026-10-20T10:00:00Z", submitted_at: "2026-10-20T10:00:00Z" })], invoices: [invoice(INV_C, { status: "matched", tx_ref: null })] }));
    expect(open.notSettled[0]).toMatchObject({ txHash: null, explorerUrl: null });
  });
});

describe("the signed record and the books (close pack CP10)", () => {
  it("is the newest entry that records the transaction, with its signature, key id and check", () => {
    const checks = new Map<number, EntryCheck>([[12, { ok: true }]]);
    const row = rowOf(buildClosePack(input({ checks })), "pay-a");
    expect(row.record).toEqual({ seq: 12, action: "ap_pay", ts: "2026-10-02T14:00:00Z", hash: "h12", signature: "s12", signingKeyId: "1a2b3c4d5e6f7a8b", check: { ok: true } });
    expect(recordWords(row.record)).toBe("#12 ap_pay, signed with key 1a2b3c4d5e6f7a8b: Verified");
    expect(recordWords({ ...row.record!, check: { ok: false, reason: "The signature does not verify with the workspace's key." } })).toBe(
      "#12 ap_pay, signed with key 1a2b3c4d5e6f7a8b: Not verified: The signature does not verify with the workspace's key."
    );
    expect(recordWords({ ...row.record!, check: { ok: null, reason: "The key that signed this entry is not known here." } })).toBe(
      "#12 ap_pay, signed with key 1a2b3c4d5e6f7a8b: Not checked here: The key that signed this entry is not known here."
    );
    expect(row.books).toEqual({ markedPaid: true, mismatch: null, booked: null });
    expect(booksWords(row)).toBe("Marked paid with this transaction.");
  });

  it("takes a reconcile that recorded it later as the record, and the decision before it as the paying entry", () => {
    const sent = tx("8");
    const entries = [
      ...NORTHWIND_ADDRESS,
      entry(70, "2026-10-02T14:00:00Z", "ap_pay", { invoiceId: INV_A, counterpartyId: NORTHWIND, decision: { action: "pay" }, decisionMode: "anthropic", guardrailBlocked: false, execution: { txRef: sent, resultingStatus: "matched" } }, "agent"),
      entry(71, "2026-10-02T14:05:00Z", "ap_reconcile", { invoiceId: INV_A, counterpartyId: NORTHWIND, reconciled: true, execution: { txRef: sent, resultingStatus: "paid" } }, "agent"),
    ];
    const row = rowOf(buildClosePack(input({ intents: [intent("pay-a", INV_A, { tx_hash: sent })], invoices: [invoice(INV_A, { tx_ref: sent })], entries })), "pay-a");
    expect(row.record).toMatchObject({ seq: 71, action: "ap_reconcile" });
    expect(row.approval.agent).toMatchObject({ action: "ap_pay", entry: 70 });
    expect(row.approval.authorizedBy).toBe("code");
    expect(row.entries).toEqual([2, 3, 70, 71]);
  });

  it("has no record when no entry names the transaction, and the books say so", () => {
    const row = rowOf(buildClosePack(input({ intents: [PAY_A], entries: [...NORTHWIND_ADDRESS, AGENT_PAID[0]] })), "pay-a");
    expect(row.record).toBeNull();
    expect(row.books.mismatch).toBe("no_signed_entry");
    expect(booksWords(row)).toBe("No signed entry names this transaction.");
    expect(recordWords(row.record)).toBe("No entry records this payment's transaction.");
  });

  it("says when Circle confirmed it but the bill is not marked paid", () => {
    const row = rowOf(buildClosePack(input({ intents: [PAY_A], invoices: [invoice(INV_A, { status: "matched" })] })), "pay-a");
    expect(row.books).toMatchObject({ markedPaid: false, mismatch: "confirmed_not_marked_paid" });
    expect(booksWords(row)).toBe("Circle confirmed it, but the bill is not marked paid.");
  });

  it("names its booking in Xero", () => {
    const booked = entry(15, "2026-10-03T09:00:00Z", "accounting_payment_confirmed", { invoiceId: INV_A, provider: "xero", paymentId: "1a2b3c4d5e6f7788", amount: "100.00", currency: "USD" }, "system");
    const row = rowOf(buildClosePack(input({ intents: [PAY_A], entries: [...NORTHWIND_ADDRESS, ...AGENT_PAID, booked] })), "pay-a");
    expect(row.books.booked).toEqual({ tool: "Xero", state: "confirmed", paymentId: "1a2b3c4d5e6f7788", at: "2026-10-03T09:00:00Z", entry: 15 });
    expect(booksWords(row)).toBe("Marked paid with this transaction. Booked in Xero (payment 1a2b3c4d…).");
    expect(row.entries).toContain(15);
  });
});

describe("escrow moves (close pack CP4)", () => {
  it("lists the month's locks and refunds apart, and totals neither", () => {
    const entries = [
      ...NORTHWIND_ADDRESS,
      ...AGENT_PAID,
      entry(80, "2026-10-06T09:00:00Z", "escrow_funded", { by: OWNER, milestoneId: MS_1, amountUsdc: 500, fundTxHash: tx("5"), payee: ADDR_L }),
      entry(81, "2026-10-26T09:00:00Z", "escrow_refunded", { by: OWNER, milestoneId: MS_1, amountUsdc: 500, refundTxHash: tx("6") }),
      entry(79, "2026-09-26T09:00:00Z", "escrow_funded", { by: OWNER, milestoneId: MS_1, amountUsdc: 300, fundTxHash: tx("4") }),
    ];
    const pack = buildClosePack(input({ intents: [PAY_A], milestones: [milestone(MS_1)], entries }));
    expect(pack.escrow).toEqual([
      { kind: "funded", at: "2026-10-06T09:00:00Z", milestoneId: MS_1, title: "Homepage redesign", amount: "500.000000", txHash: tx("5"), explorerUrl: `https://explorer.testnet.arc.io/tx/${tx("5")}`, entry: 80 },
      { kind: "refunded", at: "2026-10-26T09:00:00Z", milestoneId: MS_1, title: "Homepage redesign", amount: "500.000000", txHash: tx("6"), explorerUrl: `https://explorer.testnet.arc.io/tx/${tx("6")}`, entry: 81 },
    ]);
    expect(pack.totals.onChain).toEqual([{ token: "USDC", payments: 1, amount: "100.000000", routeFeesUsdc: "0.000000" }]);
    expect(escrowWords(pack.escrow[0])).toBe('Locked 500.00 USDC in escrow for "Homepage redesign" on 2026-10-06 09:00 UTC');
    expect(escrowWords(pack.escrow[1])).toBe("Refunded 500.00 USDC from escrow to the workspace on 2026-10-26 09:00 UTC");
    expect(pack.entries.map((one) => one.seq)).toContain(80);
    expect(pack.entries.map((one) => one.seq)).not.toContain(79);
  });
});

describe("the entries the pack carries (close pack CP10)", () => {
  const stray = entry(1, "2026-10-01T07:00:00Z", "payee_lock_changed", { by: OWNER, from: { on: false }, to: { on: true, coolingHours: 24 } }, "human");

  it("carries every cited entry once, oldest first, in full, and no other", () => {
    const pack = buildClosePack(input({ entries: [stray, ...TWO_APPROVALS, ...AGENT_PAID, ...HARBOR_ADDRESS, ...NORTHWIND_ADDRESS, AGENT_PAID[1]] }));
    const cited = [...new Set(pack.rows.flatMap((row) => row.entries))].sort((a, b) => a - b);
    expect(pack.entries.map((one) => one.seq)).toEqual(cited);
    expect(cited).toEqual([2, 3, 4, 10, 12, 20, 21, 22, 23]);
    expect(pack.entries[0]).toEqual({
      seq: 2,
      id: "e-2",
      ts: "2026-10-01T08:00:00Z",
      actor: "human",
      domain: "compliance",
      action: "create_counterparty",
      summary: "create_counterparty",
      detail: { by: OWNER, counterpartyId: NORTHWIND, address: ADDR_N },
      body_hash: "b2",
      signature: "s2",
      prev_hash: "p2",
      hash: "h2",
      signing_key_id: "1a2b3c4d5e6f7a8b",
      check: { ok: null, reason: "Not checked yet." },
    });
    expect(Object.keys(pack.entries[0])).not.toContain("org_id");
  });

  it("lists on each row what it cites", () => {
    const pack = buildClosePack(input());
    expect(rowOf(pack, "pay-a").entries).toEqual([2, 3, 10, 12]);
    expect(rowOf(pack, "pay-b").entries).toEqual([4, 20, 21, 22, 23]);
  });

  it("reads each entry as not checked yet without checks, and counts the checks given", () => {
    const unchecked = buildClosePack(input());
    expect(unchecked.entries.every((one) => one.check?.ok === null && one.check.reason === "Not checked yet.")).toBe(true);
    expect(rowOf(unchecked, "pay-a").record?.check).toEqual({ ok: null, reason: "Not checked yet." });
    const checks = new Map<number, EntryCheck>([
      [2, { ok: true }],
      [3, { ok: true }],
      [4, { ok: true }],
      [10, { ok: true }],
      [12, { ok: true }],
      [20, { ok: true }],
      [21, { ok: false, reason: "The entry's content does not match its body hash." }],
      [22, { ok: null, reason: "The key that signed this entry is not known here." }],
      [23, { ok: true }],
    ]);
    const pack = buildClosePack(input({ checks }));
    expect(pack.totals.entries).toEqual({ cited: 9, verified: 7, failed: 1, unchecked: 1 });
    expect(pack.entries.find((one) => one.seq === 21)?.check).toEqual({ ok: false, reason: "The entry's content does not match its body hash." });
  });
});

describe("the bill's facts (close pack CP7, CP17)", () => {
  it("names its own number, its document's SHA-256, its purchase order and memo", () => {
    const row = rowOf(buildClosePack(input()), "pay-a");
    expect(row.bill).toEqual({
      kind: "invoice",
      id: INV_A,
      number: "INV-2041",
      amount: "100.000000",
      currency: "USDC",
      written: null,
      dueDate: "2026-10-15",
      poReference: "PO-77",
      memo: "October paper",
      document: { sha256: DOC_SHA, kind: "pdf" },
      vendorDocuments: [],
      entry: 10,
    });
    expect(billWords(row)).toBe("Invoice INV-2041, 100.00 USDC, due 2026-10-15");
  });

  it("reads a number under Xero's name", () => {
    const row = rowOf(buildClosePack(input()), "pay-b");
    if (row.bill.kind !== "invoice") throw new Error("not an invoice");
    expect(row.bill.number).toBe("XB-88");
    expect(row.bill.document).toBeNull();
  });

  it("names a vendor's document, a shadow-mode bill's written amount, and cuts a memo at 200 characters", () => {
    const created = entry(10, "2026-10-02T10:00:00Z", "create_invoice", {
      ...AGENT_PAID[0].detail,
      invoiceNumber: undefined,
      bill: { currency: "EUR", amount: 1250, perUsd: 0.92, source: "ExchangeRate-API", at: "2026-10-02T00:00:00Z" },
    });
    const received = entry(11, "2026-10-02T11:00:00Z", "document_received", { by: null, via: "document_request", invoiceId: INV_A, counterpartyId: NORTHWIND, requestId: "r-1", fileSha256: "ab".repeat(32), fileType: "pdf", fileSize: 1200 }, "system");
    const memo = `=HYPERLINK("x")${"m".repeat(300)}`;
    const pack = buildClosePack(input({ intents: [PAY_A], invoices: [invoice(INV_A, { memo })], entries: [...NORTHWIND_ADDRESS, created, received, AGENT_PAID[1]] }));
    const row = rowOf(pack, "pay-a");
    if (row.bill.kind !== "invoice") throw new Error("not an invoice");
    expect(row.bill.number).toBeNull();
    expect(row.bill.written).toEqual({ amount: 1250, currency: "EUR" });
    expect(row.bill.vendorDocuments).toEqual([{ sha256: "ab".repeat(32), type: "pdf", at: "2026-10-02T11:00:00Z", entry: 11 }]);
    expect(row.bill.memo).toHaveLength(200);
    expect(row.entries).toContain(11);
    expect(billWords(row)).toBe("A bill of 100.00 USDC (written as 1,250 EUR), due 2026-10-15");
  });
});

describe("what passes through (close pack CP11, CP15)", () => {
  it("carries cut and unread", () => {
    const pack = buildClosePack(input({ cut: true, members: null, screening: new Map<string, EvidenceScreening | null | "unread">([["pay-a", "unread"]]) }));
    expect(pack.cut).toBe(true);
    expect(pack.unread).toEqual(["members", "screening"]);
    expect(buildClosePack(input()).unread).toEqual([]);
    expect(buildClosePack(input()).cut).toBe(false);
  });

  it("builds evidence paths from the workspace and the source", () => {
    expect(closePackEvidencePath("pinecrest-studio", { kind: "milestone", id: MS_2 })).toBe(`/o/pinecrest-studio/evidence/milestone/${MS_2}`);
  });

  it("carries the keys it is given", () => {
    expect(buildClosePack(input()).keys).toEqual(KEYS);
  });
});
