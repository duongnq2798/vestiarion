import { buildClosePack, type ClosePackInput } from "@/lib/close-pack/build";
import { closePackMonth } from "@/lib/close-pack/month";
import type { ClosePack, ClosePackIntentRow, ClosePackInvoiceRow, ClosePackLedgerRow } from "@/lib/close-pack/types";
import type { EvidenceScreening } from "@/lib/evidence-chain";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * A made-up close pack for October 2026 on pinecrest-studio (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md):
 * three settled payments (one the agent paid, one co-signed by the accountant then paid by the approver, one paid to
 * Base Sepolia through CCTP), one sent in October that settled in November, and an escrow lock. Built with the real
 * builder, so the export, page and route tests read what the builder makes.
 */

export const OWNER = "0b6c1c9e-0000-4000-8000-00000000a001";
export const APPROVER = "0b6c1c9e-0000-4000-8000-00000000a002";
export const ACCOUNTANT = "0b6c1c9e-0000-4000-8000-00000000a003";
export const NORTHWIND = "0b6c1c9e-0000-4000-8000-0000000c0001";
export const HARBOR = "0b6c1c9e-0000-4000-8000-0000000c0002";
export const INV_A = "0b6c1c9e-0000-4000-8000-0000000e000a";
export const INV_B = "0b6c1c9e-0000-4000-8000-0000000e000b";
export const INV_C = "0b6c1c9e-0000-4000-8000-0000000e000c";
export const INV_D = "0b6c1c9e-0000-4000-8000-0000000e000d";
export const MS_1 = "0b6c1c9e-0000-4000-8000-0000000f0001";
export const ADDR_N = "0x1111111111111111111111111111111111111111";
export const ADDR_H = "0x2222222222222222222222222222222222222222";
export const tx = (digit: string) => `0x${digit.repeat(64)}`;
export const DOC_SHA = "5f".repeat(32);
export const NOW = new Date("2026-11-02T09:00:00Z");
export const OCTOBER = closePackMonth("2026-10", NOW)!;
export const KEYS = [{ id: "1a2b3c4d5e6f7a8b", status: "active" as const, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n" }];

export function entry(seq: number, ts: string, action: string, detail: Record<string, unknown>, actor: "agent" | "human" | "system" = "human"): ClosePackLedgerRow {
  const domain = action.startsWith("counterparty") || action === "create_counterparty" ? "compliance" : action.startsWith("milestone") || action.startsWith("escrow") ? "contractor" : "ap";
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

export function intent(id: string, sourceId: string, overrides: Partial<ClosePackIntentRow> = {}): ClosePackIntentRow {
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
    tx_hash: tx("a"),
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

export function invoice(id: string, overrides: Partial<ClosePackInvoiceRow> = {}): ClosePackInvoiceRow {
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
    tx_ref: tx("a"),
    settled_at: "2026-10-02T14:00:06Z",
    ...overrides,
  };
}

export const ENTRIES: ClosePackLedgerRow[] = [
  entry(2, "2026-10-01T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: NORTHWIND, address: ADDR_N }),
  entry(3, "2026-10-01T09:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: ADDR_N, via: "confirm", payeeLock: { coolingHours: 24 } }),
  entry(4, "2026-10-03T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: HARBOR, address: ADDR_H }),
  entry(10, "2026-10-02T10:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_A, counterpartyId: NORTHWIND, amount: 100, currency: "USDC", invoiceNumber: "INV-2041", document: { kind: "pdf", sha256: DOC_SHA } }),
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
      observed: { amount: 100, paymentLimit: 500, riskLevel: "clear", poReference: "PO-77", goodsReceived: true },
      execution: { txRef: tx("a"), resultingStatus: "paid" },
    },
    "agent"
  ),
  entry(20, "2026-10-10T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_B, counterpartyId: HARBOR, amount: 1250, currency: "USDC", invoiceNumber: "HP-88" }),
  entry(21, "2026-10-10T09:05:00Z", "ap_hold", { invoiceId: INV_B, counterpartyId: HARBOR, decision: { action: "hold" }, decisionMode: "anthropic", guardrailBlocked: true, guardrailRule: "workspace.two_approvals", observed: { amount: 1250, riskLevel: "clear" } }, "agent"),
  entry(22, "2026-10-11T10:00:00Z", "approval_given", { by: ACCOUNTANT, invoiceId: INV_B, counterpartyId: HARBOR, cosign: true }),
  entry(23, "2026-10-12T11:00:02Z", "approval_paid", {
    by: APPROVER,
    invoiceId: INV_B,
    counterpartyId: HARBOR,
    txRef: tx("b"),
    status: "paid",
    approvals: [
      { by: ACCOUNTANT, at: "2026-10-11T10:00:00.000Z" },
      { by: APPROVER, at: "2026-10-12T11:00:00.000Z" },
    ],
  }),
  entry(30, "2026-10-14T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_C, counterpartyId: NORTHWIND, amount: 300, currency: "USDC", invoiceNumber: "INV-2050" }),
  entry(
    31,
    "2026-10-14T09:05:00Z",
    "ap_pay",
    { invoiceId: INV_C, counterpartyId: NORTHWIND, decision: { action: "pay" }, decisionMode: "anthropic", guardrailBlocked: false, observed: { amount: 300, riskLevel: "clear" }, execution: { txRef: tx("1"), mintTxHash: tx("2"), resultingStatus: "paid" } },
    "agent"
  ),
  entry(40, "2026-10-31T21:00:00Z", "create_invoice", { by: OWNER, invoiceId: INV_D, counterpartyId: HARBOR, amount: 75, currency: "USDC" }),
  entry(80, "2026-10-06T09:00:00Z", "escrow_funded", { by: OWNER, milestoneId: MS_1, amountUsdc: 500, fundTxHash: tx("5") }),
];

export const INTENTS: ClosePackIntentRow[] = [
  intent("pay-a", INV_A),
  intent("pay-b", INV_B, { amount: "1250.000000", destination: ADDR_H, tx_hash: tx("b"), confirmed_at: "2026-10-12T11:00:04Z" }),
  intent("pay-c", INV_C, { amount: "300.000000", destination_chain: "BASE-SEPOLIA", payout_route: "cctp", tx_hash: tx("1"), mint_tx_hash: tx("2"), bridge_fee: "0.12", fee_usd: "0.010000", confirmed_at: "2026-10-14T09:06:00Z" }),
  intent("pay-d", INV_D, { amount: "75.000000", destination: ADDR_H, tx_hash: tx("9"), created_at: "2026-10-31T22:00:00Z", submitted_at: "2026-10-31T22:00:00Z", confirmed_at: "2026-11-01T01:00:00Z" }),
];

export const INVOICES: ClosePackInvoiceRow[] = [
  invoice(INV_A),
  invoice(INV_B, { counterparty_id: HARBOR, amount: "1250.000000", paid_amount: "1250.000000", memo: null, po_reference: null, due_date: "2026-10-20", tx_ref: tx("b") }),
  invoice(INV_C, { amount: "300.000000", paid_amount: "300.000000", po_reference: null, tx_ref: tx("2") }),
  invoice(INV_D, { counterparty_id: HARBOR, amount: "75.000000", paid_amount: null, po_reference: null, status: "paid", tx_ref: tx("9") }),
];

export function closePackInput(overrides: Partial<ClosePackInput> = {}): ClosePackInput {
  return {
    workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" },
    network: "arc-testnet",
    month: OCTOBER,
    now: NOW,
    intents: INTENTS,
    invoices: INVOICES,
    milestones: [],
    counterparties: new Map([
      [NORTHWIND, { name: "Northwind Supplies", address: ADDR_N, sample: false }],
      [HARBOR, { name: "Harbor Print", address: ADDR_H, sample: false }],
    ]),
    documentPayTo: new Map(),
    entries: ENTRIES,
    screening: new Map<string, EvidenceScreening | null | "unread">([
      ["pay-a", { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-02T13:00:00Z" }],
      ["pay-b", null],
      ["pay-c", { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-14T09:00:00Z" }],
    ]),
    walletListSince: "2026-09-01T00:00:00Z",
    members: new Map([
      [OWNER, { email: "owner@pinecrest.test", role: "owner" as const }],
      [APPROVER, { email: "approver@pinecrest.test", role: "approver" as const }],
      [ACCOUNTANT, { email: "accountant@firm.test", role: "accountant" as const }],
    ]),
    people: "email",
    keys: KEYS,
    ledgerHead: { seq: 99, hash: "h99" },
    cut: false,
    ...overrides,
  };
}

/** The sample pack, with every cited entry verified unless checks are given. */
export function samplePack(overrides: Partial<ClosePackInput> = {}): ClosePack {
  const first = buildClosePack(closePackInput(overrides));
  const checks = overrides.checks ?? new Map<number, EntryCheck>(first.entries.map((one) => [one.seq, { ok: true }]));
  return buildClosePack(closePackInput({ ...overrides, checks }));
}
