import {
  type EvidenceChain,
  type EvidenceEntry,
  type EvidenceInput,
  type EvidenceStep,
} from "@/lib/evidence-chain";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * A payable paid with every link of its evidence there, and the pieces it is made of, for the evidence chain's tests
 * (docs/superpowers/specs/2026-10-10-evidence-chain-design.md): the builder's, the page's and the download's.
 */

export const INVOICE = "5f1e2d3c-0000-4000-8000-000000000001";
export const MILESTONE = "5f1e2d3c-0000-4000-8000-000000000002";
export const CP = "5f1e2d3c-0000-4000-8000-0000000000cc";
export const ALICE = "u-alice";
export const BOB = "u-bob";
export const CAROL = "u-carol";
export const PEOPLE = new Map([
  [ALICE, "alice@northstar.test"],
  [BOB, "bob@northstar.test"],
  [CAROL, "carol@northstar.test"],
]);
export const PAYEE = "0x221B000000000000000000000000000000001bc3";
export const TX = `0x${"79".repeat(32)}`;
export const PR = "https://github.com/acme/app/pull/12";
export const at = (time: string) => `2026-10-05T${time}Z`;

export function entry(seq: number, time: string, actor: string, action: string, detail: Record<string, unknown>, domain = "ap"): EvidenceEntry {
  return {
    seq,
    ts: at(time),
    actor,
    domain,
    action,
    summary: action,
    detail,
    body_hash: "b".repeat(64),
    signature: "5".repeat(128),
    prev_hash: "0".repeat(64),
    hash: String(seq).padStart(64, "a"),
    signing_key_id: "k1",
  };
}

export const ADDRESS_GIVEN = entry(10, "08:00:00", "human", "create_counterparty", { by: ALICE, counterpartyId: CP, address: PAYEE }, "compliance");
export const ADDRESS_CONFIRMED = entry(11, "08:05:00", "human", "counterparty_address_confirmed", { by: BOB, counterpartyId: CP, address: PAYEE }, "compliance");

export const PAY_OBSERVED = {
  amount: 12.5,
  paymentLimit: 50,
  riskLevel: "clear",
  poReference: "PO-2207",
  goodsReceived: true,
  purchaseOrderRequired: true,
  duplicateCheck: { matchesTotal: 0 },
};

export const AGENT_PAID = entry(22, "10:02:40", "agent", "ap_pay", {
  invoiceId: INVOICE,
  counterpartyId: CP,
  decision: { action: "pay" },
  decisionMode: "deepseek",
  agreedWithReference: true,
  guardrailBlocked: false,
  observed: PAY_OBSERVED,
  onChainLimit: { verdict: { state: "allowed" } },
  execution: { txRef: TX, resultingStatus: "paid" },
});

export const SHARED = entry(30, "11:00:00", "human", "receipt_shared", { receipt: { txHash: TX }, records: { seq: 22, hash: AGENT_PAID.hash } });

export function okChecks(entries: readonly EvidenceEntry[]): Map<number, EntryCheck> {
  return new Map(entries.map((row) => [row.seq, { ok: true } as EntryCheck]));
}

/** A payable paid by the agent with every link there: purchase order and goods stated, Arc's record, a shared receipt. */
export function paidInFull(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  const entries = [
    ADDRESS_GIVEN,
    ADDRESS_CONFIRMED,
    entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      dueDate: "2026-10-15",
      poReference: "PO-2207",
      goodsReceived: false,
      document: { kind: "pdf", sha256: "ab".repeat(32), reader: "deepseek", changed: [] },
    }),
    entry(21, "10:01:00", "human", "invoice_details_added", { by: BOB, invoiceId: INVOICE, counterpartyId: CP, added: { goodsReceived: true } }),
    AGENT_PAID,
    SHARED,
  ];
  return {
    network: "arc-testnet",
    subject: {
      kind: "invoice",
      invoice: {
        id: INVOICE,
        direction: "payable",
        counterparty_id: CP,
        amount: 12.5,
        currency: "USDC",
        memo: "October design retainer",
        po_reference: "PO-2207",
        goods_received: true,
        due_date: "2026-10-15T00:00:00Z",
        status: "paid",
        tx_ref: TX,
      },
    },
    counterparty: { id: CP, name: "Northstar Studio", address: PAYEE, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false },
    entries,
    screening: { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: at("09:00:00") },
    payment: {
      status: "confirmed",
      provider: "circle",
      provider_mode: "live",
      token: "USDC",
      amount: "12.500000",
      destination: PAYEE,
      tx_hash: TX,
      chain: "ARC-TESTNET",
      destination_chain: null,
      mint_tx_hash: null,
      bridge_fee: null,
      payout_route: null,
      confirmed_at: at("10:03:00"),
      network: "arc-testnet",
    },
    receipt: { id: "rcpt-1", entry_seq: 30, created_at: at("11:00:00"), revoked_at: null, created_by: ALICE },
    people: PEOPLE,
    checks: { entries: okChecks(entries), onChain: { state: "matches", block: 4_210_331 } },
    ...overrides,
  };
}

export const step = (chain: EvidenceChain, id: EvidenceStep["id"]): EvidenceStep => {
  const found = chain.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} step`);
  return found;
};
export const kinds = (s: EvidenceStep) => s.facts.map((fact) => fact.kind);
