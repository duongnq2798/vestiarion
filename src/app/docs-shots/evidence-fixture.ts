import crypto from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import { buildEvidenceChain, type EvidenceChain, type EvidenceEntry, type EvidenceInput } from "@/lib/evidence-chain";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { homeChain } from "@/lib/payee-chains";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * The evidence guide's made-up payment (docs/superpowers/specs/2026-10-10-evidence-chain-design.md): the first-payment
 * guide's bill to Northstar Studio, paid by the agent, with every link of its chain there. Its entries are signed here,
 * with a key made for each render, exactly as the ledger signs them, so the page's check in the reader's browser
 * verifies them for real in the screenshot. Nothing here is a workspace's: the ids, addresses and people are invented.
 */

/** The chain the payment was made on: Arc testnet's own, from its profile. */
const HOME = homeChain("arc-testnet");
const INVOICE = "00000000-0000-4000-8000-0000000000e1";
const COUNTERPARTY = "00000000-0000-4000-8000-0000000000d1";
const PAYEE = `0x${"c0ffee00".repeat(5)}`;
const TX = `0x${"7a".repeat(32)}`;
const MAYA = "00000000-0000-4000-8000-00000000aa01";
const OPS = "00000000-0000-4000-8000-00000000aa02";

type Body = Pick<EvidenceEntry, "actor" | "domain" | "action" | "summary" | "detail" | "ts">;

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** Signs and links entries as `append_ledger_entry()` does: the body's hash, its Ed25519 signature, then sha256(prev || body || signature). */
function signer(firstSeq: number) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = ledgerKeyId(publicKey);
  const rows: EvidenceEntry[] = [];
  let prev = sha256("the entry before the guide's first one");
  return {
    publicKeys: { [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString() },
    rows,
    append(body: Body): EvidenceEntry {
      const bodyHash = sha256(canonicalJson({ actor: body.actor, domain: body.domain, action: body.action, summary: body.summary, detail: body.detail }));
      const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
      const hash = sha256(prev + bodyHash + signature);
      const row: EvidenceEntry = { ...body, seq: firstSeq + rows.length, body_hash: bodyHash, signature, prev_hash: prev, hash, signing_key_id: keyId };
      rows.push(row);
      prev = hash;
      return row;
    },
  };
}

export function evidenceShot(): { chain: EvidenceChain; publicKeys: Record<string, string> } {
  const ledger = signer(41);
  ledger.append({
    ts: "2026-09-28T08:00:00Z", actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Northstar Studio as a vendor",
    detail: { by: MAYA, counterpartyId: COUNTERPARTY, role: "vendor", chain: HOME.id, address: PAYEE },
  });
  ledger.append({
    ts: "2026-09-28T08:06:00Z", actor: "human", domain: "compliance", action: "counterparty_address_confirmed", summary: "Confirmed Northstar Studio's new payment address",
    detail: { by: OPS, counterpartyId: COUNTERPARTY, address: PAYEE, via: "confirm" },
  });
  ledger.append({
    ts: "2026-09-30T11:40:00Z", actor: "human", domain: "ap", action: "create_invoice", summary: "Added a 12.50 USDC invoice from Northstar Studio",
    detail: {
      by: MAYA, invoiceId: INVOICE, counterpartyId: COUNTERPARTY, amount: 12.5, currency: "USDC", dueDate: "2026-10-15", poReference: "PO-2207", goodsReceived: false,
      document: { kind: "pdf", sha256: sha256("october-design-retainer.pdf"), reader: "deepseek", changed: [] },
    },
  });
  ledger.append({
    ts: "2026-09-30T11:58:00Z", actor: "human", domain: "ap", action: "invoice_details_added", summary: "Confirmed the goods or services received",
    detail: { by: OPS, invoiceId: INVOICE, counterpartyId: COUNTERPARTY, added: { goodsReceived: true } },
  });
  const paid = ledger.append({
    ts: "2026-09-30T12:04:00Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "Paid 12.50 USDC to Northstar Studio",
    detail: {
      invoiceId: INVOICE, counterpartyId: COUNTERPARTY, decision: { action: "pay" }, decisionMode: "deepseek", agreedWithReference: true, guardrailBlocked: false,
      observed: { amount: 12.5, paymentLimit: 50, riskLevel: "clear", poReference: "PO-2207", goodsReceived: true, purchaseOrderRequired: true, duplicateCheck: { matchesTotal: 0 } },
      onChainLimit: { verdict: { state: "allowed" } },
      execution: { txRef: TX, resultingStatus: "paid" },
    },
  });
  const shared = ledger.append({
    ts: "2026-09-30T12:30:00Z", actor: "human", domain: "ap", action: "receipt_shared", summary: `Receipt: 12.5 USDC paid on ${HOME.label}`,
    // As sharing writes it (payment receipts P2): the public facts and the entry they rest on, and no names or ids.
    detail: { receipt: { amount: 12.5, token: "USDC", paidAt: "2026-09-30T12:04:20Z", payee: PAYEE, chain: HOME.id, txHash: TX, route: "direct" }, records: { seq: paid.seq, hash: paid.hash } },
  });

  const input: EvidenceInput = {
    network: "arc-testnet",
    subject: {
      kind: "invoice",
      invoice: {
        id: INVOICE, direction: "payable", counterparty_id: COUNTERPARTY, amount: 12.5, currency: "USDC", memo: "October design retainer",
        po_reference: "PO-2207", goods_received: true, due_date: "2026-10-15", status: "paid", tx_ref: TX,
      },
    },
    counterparty: { id: COUNTERPARTY, name: "Northstar Studio", address: PAYEE, chain: HOME.id, risk_level: "clear", purchase_order_required: true, sample: false },
    entries: ledger.rows,
    screening: { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-09-30T11:52:00Z" },
    payment: {
      status: "confirmed", provider: "circle", provider_mode: "live", token: "USDC", amount: "12.500000", destination: PAYEE, tx_hash: TX, chain: HOME.id,
      destination_chain: null, mint_tx_hash: null, bridge_fee: null, payout_route: null, confirmed_at: "2026-09-30T12:04:20Z", network: "arc-testnet",
    },
    receipt: { id: "00000000-0000-4000-8000-0000000000f9", entry_seq: shared.seq, created_at: shared.ts, revoked_at: null, created_by: MAYA },
    people: new Map([
      [MAYA, "maya@harbor-books.example"],
      [OPS, "ops@harbor-books.example"],
    ]),
    // The entries are signed just above, so each verifies; the screenshot's browser check runs the real verifier on them.
    checks: { entries: new Map(ledger.rows.map((row): [number, EntryCheck] => [row.seq, { ok: true }])), onChain: { state: "matches", block: 31_415_926 } },
  };
  return { chain: buildEvidenceChain(input), publicKeys: ledger.publicKeys };
}
