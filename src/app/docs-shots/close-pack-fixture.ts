import { buildClosePack, type ClosePackInput } from "@/lib/close-pack/build";
import { closePackMonth, type ClosePackMonth } from "@/lib/close-pack/month";
import type { ClosePack, ClosePackIntentRow, ClosePackInvoiceRow, ClosePackLedgerRow } from "@/lib/close-pack/types";
import type { EvidenceScreening } from "@/lib/evidence-chain";
import { homeChain } from "@/lib/payee-chains";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * The accountants guide's made-up close pack (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md): October
 * 2026 in a design workspace, with three payments settled in it (one the agent paid, one an accountant co-signed before
 * an approver paid it, one paid to Base Sepolia through CCTP) and one sent on October 31 that settled on November 1.
 * Built by the real builder, so the picture says what the page says. Nothing here is a workspace's: the ids, addresses
 * and people are invented, and the entries' checks are given rather than signed.
 */

/** The chain the workspace pays on: Arc testnet's own, from its profile. */
const HOME = homeChain("arc-testnet").id;
const SLUG = "design-demo";
const NOW = new Date("2026-11-02T09:00:00Z");
const OCTOBER = closePackMonth("2026-10", NOW) as ClosePackMonth;

const OWNER = "00000000-0000-4000-8000-00000000cc01";
const APPROVER = "00000000-0000-4000-8000-00000000cc02";
const ACCOUNTANT = "00000000-0000-4000-8000-00000000cc03";
const NORTHSTAR = "00000000-0000-4000-8000-00000000cd01";
const HARBOR = "00000000-0000-4000-8000-00000000cd02";
const INVOICE = (letter: string) => `00000000-0000-4000-8000-0000000ce00${letter}`;
const ADDRESS_NORTHSTAR = `0x${"c0ffee00".repeat(5)}`;
const ADDRESS_HARBOR = `0x${"4a7b0c11".repeat(5)}`;
const tx = (pair: string) => `0x${pair.repeat(32)}`;
const KEY_ID = "5e1f0c2a9b7d3e84";

function entry(seq: number, ts: string, action: string, detail: Record<string, unknown>, actor: "agent" | "human" = "human"): ClosePackLedgerRow {
  const domain = action.includes("counterparty") ? "compliance" : action.startsWith("escrow") ? "contractor" : "ap";
  return {
    seq,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts,
    actor,
    domain,
    action,
    summary: action,
    detail,
    body_hash: tx(`${seq % 10}b`),
    signature: `${seq % 10}5`.repeat(64),
    prev_hash: tx(`${seq % 10}c`),
    hash: tx(`${seq % 10}d`),
    signing_key_id: KEY_ID,
  } as ClosePackLedgerRow;
}

function intent(id: string, sourceId: string, overrides: Partial<ClosePackIntentRow>): ClosePackIntentRow {
  return {
    id,
    source_type: "invoice",
    source_id: sourceId,
    status: "confirmed",
    provider: "circle",
    provider_mode: "live",
    provider_tx_id: `00000000-0000-4000-8000-0000000cf${id.slice(-3)}`,
    provider_state: "COMPLETE",
    failure_reason: null,
    last_error: null,
    amount: "0",
    token: "USDC",
    destination: ADDRESS_NORTHSTAR,
    tx_hash: null,
    chain: HOME,
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

function invoice(id: string, overrides: Partial<ClosePackInvoiceRow>): ClosePackInvoiceRow {
  return {
    id,
    direction: "payable",
    counterparty_id: NORTHSTAR,
    amount: "0",
    currency: "USDC",
    paid_amount: null,
    memo: null,
    po_reference: null,
    due_date: "2026-10-15",
    status: "paid",
    tx_ref: null,
    settled_at: null,
    ...overrides,
  };
}

const ENTRIES: ClosePackLedgerRow[] = [
  entry(4101, "2026-09-28T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: NORTHSTAR, address: ADDRESS_NORTHSTAR }),
  entry(4102, "2026-09-28T09:10:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHSTAR, address: ADDRESS_NORTHSTAR, via: "confirm", payeeLock: { coolingHours: 24 } }),
  entry(4103, "2026-09-30T08:00:00Z", "create_counterparty", { by: OWNER, counterpartyId: HARBOR, address: ADDRESS_HARBOR }),
  entry(4104, "2026-09-30T10:30:00Z", "counterparty_address_confirmed", { by: ACCOUNTANT, counterpartyId: HARBOR, address: ADDRESS_HARBOR, via: "confirm", payeeLock: { coolingHours: 24 } }),
  entry(4210, "2026-10-02T10:00:00Z", "create_invoice", { by: OWNER, invoiceId: INVOICE("a"), counterpartyId: NORTHSTAR, amount: 480, currency: "USDC", invoiceNumber: "NS-1042", document: { kind: "pdf", sha256: "3c".repeat(32) } }),
  entry(
    4212,
    "2026-10-02T14:00:00Z",
    "ap_pay",
    {
      invoiceId: INVOICE("a"),
      counterpartyId: NORTHSTAR,
      decision: { action: "pay" },
      decisionMode: "anthropic",
      guardrailBlocked: false,
      observed: { amount: 480, paymentLimit: 1000, riskLevel: "clear", poReference: "PO-311", goodsReceived: true },
      execution: { txRef: tx("a1"), resultingStatus: "paid" },
    },
    "agent"
  ),
  entry(4320, "2026-10-09T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INVOICE("b"), counterpartyId: HARBOR, amount: 2400, currency: "USDC", invoiceNumber: "HP-2207", document: { kind: "pdf", sha256: "9e".repeat(32) } }),
  entry(
    4321,
    "2026-10-09T09:05:00Z",
    "ap_hold",
    {
      invoiceId: INVOICE("b"),
      counterpartyId: HARBOR,
      decision: { action: "hold" },
      decisionMode: "anthropic",
      guardrailBlocked: true,
      guardrailRule: "workspace.two_approvals",
      observed: { amount: 2400, paymentLimit: 1000, riskLevel: "clear", poReference: "PO-318", goodsReceived: true },
    },
    "agent"
  ),
  entry(4335, "2026-10-10T15:20:00Z", "approval_given", { by: ACCOUNTANT, invoiceId: INVOICE("b"), counterpartyId: HARBOR, cosign: true }),
  entry(4342, "2026-10-12T11:00:02Z", "approval_paid", {
    by: APPROVER,
    invoiceId: INVOICE("b"),
    counterpartyId: HARBOR,
    txRef: tx("b2"),
    status: "paid",
    approvals: [
      { by: ACCOUNTANT, at: "2026-10-10T15:20:00.000Z" },
      { by: APPROVER, at: "2026-10-12T11:00:00.000Z" },
    ],
  }),
  entry(4460, "2026-10-14T09:00:00Z", "create_invoice", { by: OWNER, invoiceId: INVOICE("c"), counterpartyId: NORTHSTAR, amount: 300, currency: "USDC", invoiceNumber: "NS-1051" }),
  entry(
    4461,
    "2026-10-14T09:05:00Z",
    "ap_pay",
    { invoiceId: INVOICE("c"), counterpartyId: NORTHSTAR, decision: { action: "pay" }, decisionMode: "anthropic", guardrailBlocked: false, observed: { amount: 300, riskLevel: "clear" }, execution: { txRef: tx("c3"), mintTxHash: tx("c4"), resultingStatus: "paid" } },
    "agent"
  ),
  entry(4688, "2026-10-31T21:00:00Z", "create_invoice", { by: OWNER, invoiceId: INVOICE("d"), counterpartyId: HARBOR, amount: 75, currency: "USDC", invoiceNumber: "HP-2231" }),
];

const INPUT: ClosePackInput = {
  workspace: { slug: SLUG, name: "Design Demo Studio" },
  network: "arc-testnet",
  month: OCTOBER,
  now: NOW,
  intents: [
    intent("cp-a01", INVOICE("a"), { amount: "480.000000", tx_hash: tx("a1") }),
    intent("cp-b02", INVOICE("b"), { amount: "2400.000000", destination: ADDRESS_HARBOR, tx_hash: tx("b2"), created_at: "2026-10-12T11:00:00Z", submitted_at: "2026-10-12T11:00:00Z", confirmed_at: "2026-10-12T11:00:04Z" }),
    intent("cp-c03", INVOICE("c"), {
      amount: "300.000000",
      destination_chain: "BASE-SEPOLIA",
      payout_route: "cctp",
      tx_hash: tx("c3"),
      mint_tx_hash: tx("c4"),
      bridge_fee: "0.12",
      fee_usd: "0.010",
      created_at: "2026-10-14T09:05:00Z",
      submitted_at: "2026-10-14T09:05:00Z",
      confirmed_at: "2026-10-14T09:06:00Z",
    }),
    intent("cp-d04", INVOICE("d"), { amount: "75.000000", destination: ADDRESS_HARBOR, tx_hash: tx("d5"), created_at: "2026-10-31T22:00:00Z", submitted_at: "2026-10-31T22:00:00Z", confirmed_at: "2026-11-01T01:00:00Z" }),
  ],
  invoices: [
    invoice(INVOICE("a"), { amount: "480.000000", paid_amount: "480.000000", po_reference: "PO-311", tx_ref: tx("a1") }),
    invoice(INVOICE("b"), { counterparty_id: HARBOR, amount: "2400.000000", paid_amount: "2400.000000", po_reference: "PO-318", due_date: "2026-10-20", tx_ref: tx("b2") }),
    invoice(INVOICE("c"), { amount: "300.000000", paid_amount: "300.000000", tx_ref: tx("c4") }),
    invoice(INVOICE("d"), { counterparty_id: HARBOR, amount: "75.000000", due_date: "2026-11-05", tx_ref: tx("d5") }),
  ],
  milestones: [],
  counterparties: new Map([
    [NORTHSTAR, { name: "Northstar Studio", address: ADDRESS_NORTHSTAR, sample: false }],
    [HARBOR, { name: "Harbor Print Co.", address: ADDRESS_HARBOR, sample: false }],
  ]),
  documentPayTo: new Map([[INVOICE("b"), ADDRESS_HARBOR]]),
  entries: ENTRIES,
  screening: new Map<string, EvidenceScreening | null | "unread">([
    ["cp-a01", { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-02T13:00:00Z" }],
    ["cp-b02", { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-09T09:00:00Z" }],
    ["cp-c03", { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-14T09:00:00Z" }],
  ]),
  walletListSince: "2026-09-01T00:00:00Z",
  members: new Map([
    [OWNER, { email: "maya@designdemo.test", role: "owner" as const }],
    [APPROVER, { email: "sam@designdemo.test", role: "approver" as const }],
    [ACCOUNTANT, { email: "lena@ledgerline.test", role: "accountant" as const }],
  ]),
  people: "email",
  keys: [],
  ledgerHead: { seq: 4712, hash: tx("ef") },
  cut: false,
};

/** The pack, with every cited entry checked: the reader checks each against the workspace's keys. */
export function closePackShot(): ClosePack {
  const first = buildClosePack(INPUT);
  return buildClosePack({ ...INPUT, checks: new Map<number, EntryCheck>(first.entries.map((one) => [one.seq, { ok: true }])) });
}
