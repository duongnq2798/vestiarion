import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../src/lib/canonical-json";
import { buildClosePack, screeningAnchors, type ClosePackInput } from "../src/lib/close-pack/build";
import { closePackDocument } from "../src/lib/close-pack/export";
import { closePackMonth } from "../src/lib/close-pack/month";
import type { ClosePackIntentRow, ClosePackInvoiceRow, ClosePackLedgerRow, ClosePackMilestoneRow } from "../src/lib/close-pack/types";
import { buildEvidenceChain, givenLinks, type EvidenceEntry, type EvidenceInput, type EvidencePayment, type EvidenceScreening } from "../src/lib/evidence-chain";
import type { LinkAccess } from "../src/lib/evidence-links/check";
import { evidenceDocument, type EvidenceKey, type SignedEntry } from "../src/lib/evidence-export";
import type { LedgerDomain, LedgerRow } from "../src/lib/ledger";
import { parsePeriod, payeeLockEvidence } from "../src/lib/payee-lock-evidence";
import { receiptDocument } from "../src/lib/receipts/document";
import { buildReceipt, receiptSummary, type ReceiptIntent } from "../src/lib/receipts/facts";
import { verifyEntry, type EntryCheck } from "../src/lib/receipts/verify";

/**
 * Builds the five evidence examples the API reference shows (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-
 * close-pack-design.md EA11), with the real builders, from a made-up workspace: Northstar Studio (`northstar-studio`) on
 * Arc testnet, signed with an Ed25519 key made for this run and never written down. Every id, hash and address is made
 * up. A recorded pack would publish a real workspace's entries in a public repository, and a redacted one would no
 * longer verify; these verify with the key each carries (tests/sdk-evidence.test.ts).
 *
 *   npx tsx scripts/evidence-examples.ts
 *
 * Run it only when a document's shape changes: each run signs again with a new key, so every hash and signature moves.
 */

const WORKSPACE = { slug: "northstar-studio", name: "Northstar Studio" };
const NETWORK = "arc-testnet" as const;
const NOW = new Date("2026-10-25T09:00:00.000Z");

// The people: an owner, an approver and the business's accountant, named by user id only, as the API names them (EA3).
const OWNER = "4b7e0c1a-2d3f-4e5a-8b6c-7d8e9f0a1b01";
const APPROVER = "4b7e0c1a-2d3f-4e5a-8b6c-7d8e9f0a1b02";
const ACCOUNTANT = "4b7e0c1a-2d3f-4e5a-8b6c-7d8e9f0a1b03";
const MEMBERS = new Map([
  [OWNER, { email: "owner@northstar-studio.example", role: "owner" as const }],
  [APPROVER, { email: "approver@northstar-studio.example", role: "approver" as const }],
  [ACCOUNTANT, { email: "books@northstar-accounting.example", role: "accountant" as const }],
]);

// The payees: a print shop whose payout address changed this month, and a contractor paid for a merged pull request.
const HARBOR = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4c01";
const LUMEN = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4c02";
const QUILL = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4c03";
const HARBOR_OLD = "0x5a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const HARBOR_NEW = "0x8c4f2e1d0b9a87766554433221100ffeeddccbba";
const LUMEN_ADDRESS = "0x3e7d9c1b5a2f4e6d8c0b1a2f3e4d5c6b7a8f9e01";
const QUILL_ADDRESS = "0x9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a00";

const INVOICE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51";
const UNSETTLED = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e52";
const MILESTONE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4f61";
const RECEIPT = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4a71";
const PR = "https://github.com/northstar-studio/site/pull/48";
const DOCUMENT_SHA = crypto.createHash("sha256").update("northstar-studio example bill HP-2026-0412").digest("hex");
const tx = (label: string) => `0x${crypto.createHash("sha256").update(`northstar-studio example ${label}`).digest("hex")}`;
const TX_BILL = tx("bill transfer");
const TX_MILESTONE = tx("milestone transfer");

// --- The ledger: one chain, signed with a key made for this run --------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const keyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
const KEYS: EvidenceKey[] = [{ id: keyId, status: "active", publicKeyPem }];
const PUBLIC_KEYS = { [keyId]: publicKeyPem };

interface Planned {
  ts: string;
  actor: "agent" | "human" | "system";
  domain: LedgerDomain;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
}

/** An earlier part of the workspace's ledger the documents do not carry: its chain hash is the next entry's prev_hash. */
const FIRST_SEQ = 5601;
let previous = crypto.createHash("sha256").update("northstar-studio example: the entries before October").digest("hex");
const LEDGER: LedgerRow[] = [];

function append(planned: Planned): LedgerRow {
  const bodyHash = crypto
    .createHash("sha256")
    .update(canonicalJson({ actor: planned.actor, domain: planned.domain, action: planned.action, summary: planned.summary, detail: planned.detail }))
    .digest("hex");
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const hash = crypto.createHash("sha256").update(previous + bodyHash + signature).digest("hex");
  const row: LedgerRow = {
    seq: FIRST_SEQ + LEDGER.length,
    id: crypto.randomUUID(),
    ts: planned.ts,
    actor: planned.actor,
    domain: planned.domain,
    action: planned.action,
    summary: planned.summary,
    detail: planned.detail,
    body_hash: bodyHash,
    signature,
    prev_hash: previous,
    hash,
    signing_key_id: keyId,
  };
  previous = hash;
  LEDGER.push(row);
  return row;
}

const lockOn = append({
  ts: "2026-10-01T08:00:00.000Z",
  actor: "human",
  domain: "system",
  action: "payee_lock_changed",
  summary: "Turned the payee lock on, with a 24-hour wait",
  detail: { by: OWNER, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 24 } },
});
const harborAdded = append({
  ts: "2026-10-01T08:20:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "create_counterparty",
  summary: "Added Harbor Print Co. as a vendor",
  detail: { by: OWNER, counterpartyId: HARBOR, name: "Harbor Print Co.", role: "vendor", address: HARBOR_OLD, chain: "ARC-TESTNET" },
});
const lumenAdded = append({
  ts: "2026-10-01T08:30:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "create_counterparty",
  summary: "Added Lumen Dev as a contractor",
  detail: { by: OWNER, counterpartyId: LUMEN, name: "Lumen Dev", role: "contractor", address: LUMEN_ADDRESS, chain: "ARC-TESTNET" },
});
const lumenConfirmed = append({
  ts: "2026-10-01T09:05:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "counterparty_address_confirmed",
  summary: "Confirmed Lumen Dev's payout address",
  detail: { by: APPROVER, counterpartyId: LUMEN, address: LUMEN_ADDRESS, chain: "ARC-TESTNET", via: "confirm", payeeLock: { coolingHours: 24 } },
});
const harborChanged = append({
  ts: "2026-10-02T09:00:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "counterparty_address_changed",
  summary: "Changed Harbor Print Co.'s payout address",
  detail: { by: OWNER, counterpartyId: HARBOR, from: HARBOR_OLD, to: HARBOR_NEW, chain: "ARC-TESTNET" },
});
const harborConfirmed = append({
  ts: "2026-10-02T09:40:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "counterparty_address_confirmed",
  summary: "Confirmed Harbor Print Co.'s new payout address",
  detail: {
    by: APPROVER,
    counterpartyId: HARBOR,
    address: HARBOR_NEW,
    chain: "ARC-TESTNET",
    via: "confirm",
    verification: { method: "call", contact: "Harbor Print's accounts line, from the vendor file", contactOnFileBefore: true, note: "Read back the new address on the call." },
    payeeLock: { coolingHours: 24 },
  },
});
const billAdded = append({
  ts: "2026-10-03T10:00:00.000Z",
  actor: "human",
  domain: "ap",
  action: "create_invoice",
  summary: "Added a bill from Harbor Print Co. for 1250 USDC",
  detail: {
    by: OWNER,
    invoiceId: INVOICE,
    counterpartyId: HARBOR,
    counterpartyName: "Harbor Print Co.",
    amount: 1250,
    currency: "USDC",
    dueDate: "2026-10-20",
    poReference: "PO-1187",
    goodsReceived: true,
    invoiceNumber: "HP-2026-0412",
    document: { kind: "pdf", reader: "anthropic", sha256: DOCUMENT_SHA },
  },
});
const OBSERVED = {
  amount: 1250,
  paymentLimit: 2000,
  riskLevel: "clear",
  poReference: "PO-1187",
  goodsReceived: true,
  purchaseOrderRequired: true,
  twoApprovalsAbove: 1000,
  duplicateCheck: { matchesTotal: 0 },
};
const billHeld = append({
  ts: "2026-10-03T10:01:00.000Z",
  actor: "agent",
  domain: "ap",
  action: "ap_hold",
  summary: "Held 1250 USDC to Harbor Print Co. for two approvals",
  detail: {
    invoiceId: INVOICE,
    counterpartyId: HARBOR,
    decision: { action: "hold" },
    decisionMode: "anthropic",
    agreedWithReference: true,
    guardrailBlocked: true,
    guardrailRule: "workspace.two_approvals",
    currency: "USDC",
    observed: OBSERVED,
    execution: { txRef: null, resultingStatus: "held", heldBecause: "workspace.two_approvals" },
  },
});
const cosigned = append({
  ts: "2026-10-03T14:00:00.000Z",
  actor: "human",
  domain: "ap",
  action: "approval_given",
  summary: "Co-signed 1250 USDC to Harbor Print Co.; an owner, admin or approver's approval pays it (payments above 1000 USDC need two)",
  detail: { by: ACCOUNTANT, invoiceId: INVOICE, counterpartyId: HARBOR, amount: 1250, currency: "USDC", address: HARBOR_NEW, twoApprovalsAbove: 1000, cosign: true },
});
const billPaid = append({
  ts: "2026-10-03T15:20:00.000Z",
  actor: "human",
  domain: "ap",
  action: "approval_paid",
  summary: "Approved and paid 1250 USDC to Harbor Print Co.",
  detail: {
    by: APPROVER,
    invoiceId: INVOICE,
    counterpartyId: HARBOR,
    amount: 1250,
    currency: "USDC",
    amountPaid: 1250,
    discountTaken: 0,
    overrode: "held",
    txRef: TX_BILL,
    status: "paid",
    attempt: 1,
    firstPayment: true,
    approvals: [
      { by: ACCOUNTANT, at: "2026-10-03T14:00:00.000Z" },
      { by: APPROVER, at: "2026-10-03T15:20:00.000Z" },
    ],
    twoApprovalsAbove: 1000,
  },
});
const milestoneAdded = append({
  ts: "2026-10-03T16:00:00.000Z",
  actor: "human",
  domain: "contractor",
  action: "create_milestone",
  summary: "Added a milestone for Lumen Dev: Checkout page redesign, 800 USDC",
  detail: { by: OWNER, milestoneId: MILESTONE, counterpartyId: LUMEN, counterpartyName: "Lumen Dev", amount: 800, verificationSource: PR },
});

// The receipt of the bill, shared once by the approver: its statement is the builder's, signed.
const BILL_INTENT: ReceiptIntent = {
  status: "confirmed",
  provider_mode: "live",
  token: "USDC",
  amount: "1250.000000",
  destination: HARBOR_NEW,
  tx_hash: TX_BILL,
  chain: "ARC-TESTNET",
  destination_chain: null,
  mint_tx_hash: null,
  bridge_fee: null,
  payout_route: null,
  confirmed_at: "2026-10-03T15:20:06.000Z",
  network: NETWORK,
};
const BILL_ROW = { id: INVOICE, status: "paid", direction: "payable", amount: "1250.000000" };
const camel = (row: LedgerRow) => ({ ...row, bodyHash: row.body_hash, prevHash: row.prev_hash, signingKeyId: row.signing_key_id ?? null });
const stated = buildReceipt({ invoice: BILL_ROW, intent: BILL_INTENT, entries: [billAdded, billPaid].map(camel) });
if (!stated.ok) throw new Error(`the example receipt does not build: ${stated.reason}`);
const receiptShared = append({
  ts: "2026-10-04T09:00:00.000Z",
  actor: "human",
  domain: "ap",
  action: "receipt_shared",
  summary: receiptSummary(stated.facts),
  detail: { receipt: stated.facts, records: stated.records },
});

const milestoneVerified = append({
  ts: "2026-10-08T09:10:00.000Z",
  actor: "system",
  domain: "contractor",
  action: "verify_milestone_github",
  summary: "GitHub reported northstar-studio/site#48 merged",
  detail: { milestoneId: MILESTONE, verificationSource: PR, verificationStatus: "verified", pullRequest: PR, mergedAt: "2026-10-08T09:00:00.000Z" },
});
const milestoneReleased = append({
  ts: "2026-10-08T09:11:00.000Z",
  actor: "agent",
  domain: "contractor",
  action: "milestone_release",
  summary: "Released 800 USDC to Lumen Dev for Checkout page redesign",
  detail: {
    milestoneId: MILESTONE,
    counterpartyId: LUMEN,
    decision: { action: "release" },
    decisionMode: "anthropic",
    agreedWithReference: true,
    guardrailBlocked: false,
    observed: { amount: 800, paymentLimit: 1000, riskLevel: "clear", verification: { verified: true, method: "github", source: PR, note: null } },
    execution: { txRef: TX_MILESTONE, resultingStatus: "paid" },
  },
});

// A bill sent on Oct 24 that Circle has not confirmed yet: the close pack lists it apart, as not settled.
append({
  ts: "2026-10-20T11:00:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "create_counterparty",
  summary: "Added Quill Paper as a vendor",
  detail: { by: OWNER, counterpartyId: QUILL, name: "Quill Paper", role: "vendor", address: QUILL_ADDRESS, chain: "ARC-TESTNET" },
});
append({
  ts: "2026-10-20T11:30:00.000Z",
  actor: "human",
  domain: "compliance",
  action: "counterparty_address_confirmed",
  summary: "Confirmed Quill Paper's payout address",
  detail: { by: APPROVER, counterpartyId: QUILL, address: QUILL_ADDRESS, chain: "ARC-TESTNET", via: "confirm", payeeLock: { coolingHours: 24 } },
});
append({
  ts: "2026-10-24T10:00:00.000Z",
  actor: "human",
  domain: "ap",
  action: "create_invoice",
  summary: "Added a bill from Quill Paper for 310 USDC",
  detail: { by: OWNER, invoiceId: UNSETTLED, counterpartyId: QUILL, counterpartyName: "Quill Paper", amount: 310, currency: "USDC", dueDate: "2026-11-05", poReference: "PO-1203", goodsReceived: true, invoiceNumber: "QP-88213" },
});
append({
  ts: "2026-10-24T10:01:00.000Z",
  actor: "agent",
  domain: "ap",
  action: "ap_pay",
  summary: "Paying 310 USDC to Quill Paper",
  detail: {
    invoiceId: UNSETTLED,
    counterpartyId: QUILL,
    decision: { action: "pay" },
    decisionMode: "anthropic",
    agreedWithReference: true,
    guardrailBlocked: false,
    currency: "USDC",
    observed: { amount: 310, paymentLimit: 2000, riskLevel: "clear", poReference: "PO-1203", goodsReceived: true, purchaseOrderRequired: true, duplicateCheck: { matchesTotal: 0 } },
    execution: { txRef: null, resultingStatus: "matched" },
  },
});

// --- Checks: each entry alone, with the run's key ----------------------------------------------------------------

async function checksOf(rows: readonly LedgerRow[]): Promise<Map<number, EntryCheck>> {
  return new Map(await Promise.all(rows.map(async (row): Promise<[number, EntryCheck]> => [row.seq, await verifyEntry({ ...row, signing_key_id: row.signing_key_id ?? null }, PUBLIC_KEYS)])));
}

const asEvidenceEntry = (row: LedgerRow): EvidenceEntry => ({ ...row, id: row.id ?? undefined, signing_key_id: row.signing_key_id ?? null });
const asSigned = (row: LedgerRow, check: EntryCheck): SignedEntry => ({
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
  check,
});

/** Members named by user id, as the API names them (EA3). */
const PEOPLE_BY_ID = new Map([...MEMBERS.keys()].map((id) => [id, id]));
const CLEAR: EvidenceScreening = { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-01T08:21:00.000Z" };

async function paymentEvidence(input: Omit<EvidenceInput, "checks" | "people" | "network">, onChainBlock: number, links: ReadonlyMap<string, LinkAccess>) {
  const base: EvidenceInput = {
    ...input,
    network: NETWORK,
    people: PEOPLE_BY_ID,
    checks: { entries: await checksOf(input.entries as LedgerRow[]), onChain: { state: "matches", block: onChainBlock } },
  };
  const found = givenLinks(buildEvidenceChain(base));
  const access = new Map([...found].filter((href) => links.has(href)).map((href) => [href, links.get(href)!]));
  const chain = buildEvidenceChain({ ...base, checks: { ...base.checks, links: access } });
  return evidenceDocument({ chain, workspace: WORKSPACE, keys: KEYS, now: NOW });
}

async function main(): Promise<void> {
  const billPayment: EvidencePayment = { ...BILL_INTENT, provider: "circle", provider_tx_id: "a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", provider_state: "COMPLETE", failure_reason: null, last_error: null };
  const billEvidence = await paymentEvidence(
    {
      subject: {
        kind: "invoice",
        invoice: {
          id: INVOICE,
          direction: "payable",
          counterparty_id: HARBOR,
          amount: 1250,
          currency: "USDC",
          memo: "October catalogue print run",
          po_reference: "PO-1187",
          goods_received: true,
          due_date: "2026-10-20T00:00:00.000Z",
          status: "paid",
          tx_ref: TX_BILL,
          paid_amount: 1250,
        },
      },
      counterparty: { id: HARBOR, name: "Harbor Print Co.", address: HARBOR_NEW, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false },
      entries: [harborAdded, harborChanged, harborConfirmed, billAdded, billHeld, cosigned, billPaid, receiptShared].map(asEvidenceEntry),
      screening: CLEAR,
      payment: billPayment,
      receipt: { id: RECEIPT, entry_seq: receiptShared.seq, created_at: receiptShared.ts, revoked_at: null, created_by: APPROVER },
    },
    4_210_331,
    new Map()
  );

  const milestonePayment: EvidencePayment = {
    status: "confirmed",
    provider: "circle",
    provider_mode: "live",
    token: "USDC",
    amount: "800.000000",
    destination: LUMEN_ADDRESS,
    tx_hash: TX_MILESTONE,
    chain: "ARC-TESTNET",
    destination_chain: null,
    mint_tx_hash: null,
    bridge_fee: null,
    payout_route: null,
    confirmed_at: "2026-10-08T09:11:06.000Z",
    network: NETWORK,
    provider_tx_id: "b4e2d3c5-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    provider_state: "COMPLETE",
    failure_reason: null,
    last_error: null,
  };
  const milestoneEvidence = await paymentEvidence(
    {
      subject: {
        kind: "milestone",
        milestone: {
          id: MILESTONE,
          contractor_id: LUMEN,
          title: "Checkout page redesign",
          amount: 800,
          status: "paid",
          verified: true,
          verification_method: "github",
          verification_status: "verified",
          verification_source: PR,
          verification_checked_at: milestoneVerified.ts,
          verified_at: "2026-10-08T09:00:00.000Z",
          verification_detail: { pullRequest: PR, state: "closed", mergedAt: "2026-10-08T09:00:00.000Z" },
          tx_ref: TX_MILESTONE,
          escrow_state: null,
          escrow_payee: null,
          escrow_amount: null,
          escrow_release_tx_hash: null,
        },
      },
      counterparty: { id: LUMEN, name: "Lumen Dev", address: LUMEN_ADDRESS, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: false, sample: false },
      entries: [lumenAdded, lumenConfirmed, milestoneAdded, milestoneVerified, milestoneReleased].map(asEvidenceEntry),
      screening: { ...CLEAR, created_at: "2026-10-01T08:31:00.000Z" },
      payment: milestonePayment,
      receipt: null,
    },
    4_388_902,
    new Map([[PR, { state: "open" }]])
  );

  // --- The receipt -------------------------------------------------------------------------------------------------

  const receiptRows = [billAdded, billPaid, receiptShared];
  const receiptChecks = await checksOf(receiptRows);
  const receipt = receiptDocument({
    workspace: WORKSPACE,
    network: NETWORK,
    invoiceId: INVOICE,
    built: stated,
    receipt: { created_at: receiptShared.ts, entry_seq: receiptShared.seq, revoked_at: null },
    entries: receiptRows.map((row) => asSigned(row, receiptChecks.get(row.seq)!)),
    checks: { recorded: { ok: true }, onChain: { state: "matches", block: 4_210_331, received: 1250 } },
    keys: KEYS,
    now: NOW,
  });

  // --- The payee lock's evidence for October -------------------------------------------------------------------------

  const PERIOD = parsePeriod("2026-10-01", "2026-10-31");
  if (!PERIOD) throw new Error("the example period does not read");
  const lockRows = [lockOn, harborAdded, harborChanged, harborConfirmed, billAdded, billHeld, cosigned, billPaid, receiptShared];
  const lockChecks = await checksOf(lockRows);
  const payeeLock = payeeLockEvidence({
    workspace: WORKSPACE,
    network: NETWORK,
    period: PERIOD,
    lock: { on: true, coolingHours: 24 },
    entries: lockRows.map((row) => ({ ...row, check: lockChecks.get(row.seq) })),
    counterparties: new Map([[HARBOR, "Harbor Print Co."]]),
    members: new Map([...MEMBERS].map(([id, member]) => [id, member.email])),
    keys: KEYS,
    now: NOW,
    people: "id",
  });

  // --- The close pack of October, so far -----------------------------------------------------------------------------

  const MONTH = closePackMonth("2026-10", NOW);
  if (!MONTH) throw new Error("the example month does not read");
  const closeIntent = (overrides: Partial<ClosePackIntentRow> & Pick<ClosePackIntentRow, "id" | "source_type" | "source_id">): ClosePackIntentRow => ({
    status: "confirmed",
    provider: "circle",
    provider_mode: "live",
    provider_tx_id: null,
    provider_state: "COMPLETE",
    failure_reason: null,
    last_error: null,
    amount: "0",
    token: "USDC",
    destination: "",
    tx_hash: null,
    chain: "ARC-TESTNET",
    destination_chain: null,
    mint_tx_hash: null,
    bridge_fee: null,
    payout_route: null,
    network: NETWORK,
    fee_usd: "0.004100",
    fee_source: "chain_reported",
    transfer_attempt: 1,
    previous_attempts: [],
    batch_key: null,
    created_at: "",
    updated_at: "",
    submitted_at: null,
    executed_at: null,
    confirmed_at: null,
    ...overrides,
  });
  const intents: ClosePackIntentRow[] = [
    closeIntent({
      id: "c5d6e7f8-0a1b-4c2d-8e3f-4a5b6c7d8e01",
      source_type: "invoice",
      source_id: INVOICE,
      provider_tx_id: billPayment.provider_tx_id ?? null,
      amount: "1250.000000",
      destination: HARBOR_NEW,
      tx_hash: TX_BILL,
      created_at: "2026-10-03T15:20:01.000Z",
      updated_at: "2026-10-03T15:20:06.000Z",
      submitted_at: "2026-10-03T15:20:01.000Z",
      executed_at: "2026-10-03T15:20:06.000Z",
      confirmed_at: "2026-10-03T15:20:06.000Z",
    }),
    closeIntent({
      id: "c5d6e7f8-0a1b-4c2d-8e3f-4a5b6c7d8e02",
      source_type: "milestone",
      source_id: MILESTONE,
      provider_tx_id: milestonePayment.provider_tx_id ?? null,
      amount: "800.000000",
      destination: LUMEN_ADDRESS,
      tx_hash: TX_MILESTONE,
      created_at: "2026-10-08T09:11:01.000Z",
      updated_at: "2026-10-08T09:11:06.000Z",
      submitted_at: "2026-10-08T09:11:01.000Z",
      executed_at: "2026-10-08T09:11:06.000Z",
      confirmed_at: "2026-10-08T09:11:06.000Z",
    }),
    closeIntent({
      id: "c5d6e7f8-0a1b-4c2d-8e3f-4a5b6c7d8e03",
      source_type: "invoice",
      source_id: UNSETTLED,
      status: "pending",
      provider_tx_id: "c5f3e4d6-7a8b-4c9d-8e0f-2a3b4c5d6e7f",
      provider_state: "SENT",
      amount: "310.000000",
      destination: QUILL_ADDRESS,
      fee_usd: null,
      fee_source: null,
      created_at: "2026-10-24T10:01:01.000Z",
      updated_at: "2026-10-24T10:01:03.000Z",
      submitted_at: "2026-10-24T10:01:01.000Z",
    }),
  ];
  const invoices: ClosePackInvoiceRow[] = [
    { id: INVOICE, direction: "payable", counterparty_id: HARBOR, amount: "1250.000000", currency: "USDC", paid_amount: "1250.000000", memo: "October catalogue print run", po_reference: "PO-1187", due_date: "2026-10-20", status: "paid", tx_ref: TX_BILL, settled_at: "2026-10-03T15:20:06.000Z" },
    { id: UNSETTLED, direction: "payable", counterparty_id: QUILL, amount: "310.000000", currency: "USDC", paid_amount: null, memo: "Recycled stock, November", po_reference: "PO-1203", due_date: "2026-11-05", status: "matched", tx_ref: null, settled_at: null },
  ];
  const milestones: ClosePackMilestoneRow[] = [
    {
      id: MILESTONE,
      contractor_id: LUMEN,
      title: "Checkout page redesign",
      amount: "800.000000",
      status: "paid",
      verified: true,
      verification_method: "github",
      verification_status: "verified",
      verification_source: PR,
      verification_checked_at: milestoneVerified.ts,
      verified_at: "2026-10-08T09:00:00.000Z",
      verification_detail: { pullRequest: PR, state: "closed", mergedAt: "2026-10-08T09:00:00.000Z" },
      tx_ref: TX_MILESTONE,
      settled_at: "2026-10-08T09:11:06.000Z",
      escrow_state: null,
      escrow_payee: null,
      escrow_amount: null,
      escrow_release_tx_hash: null,
    },
  ];
  const closeEntries: ClosePackLedgerRow[] = LEDGER.filter((row) => row.action !== "receipt_shared");
  const head = LEDGER[LEDGER.length - 1];
  const closeBase: Omit<ClosePackInput, "screening" | "checks"> = {
    workspace: WORKSPACE,
    network: NETWORK,
    month: MONTH,
    now: NOW,
    intents,
    invoices,
    milestones,
    counterparties: new Map([
      [HARBOR, { name: "Harbor Print Co.", address: HARBOR_NEW, sample: false }],
      [LUMEN, { name: "Lumen Dev", address: LUMEN_ADDRESS, sample: false }],
      [QUILL, { name: "Quill Paper", address: QUILL_ADDRESS, sample: false }],
    ]),
    documentPayTo: new Map([[INVOICE, HARBOR_NEW]]),
    entries: closeEntries,
    walletListSince: "2026-09-30T00:00:00.000Z",
    members: MEMBERS,
    people: "id",
    keys: KEYS,
    ledgerHead: { seq: head.seq, hash: head.hash },
    cut: false,
  };
  const screening = new Map([...screeningAnchors(closeBase).keys()].map((paymentId) => [paymentId, CLEAR]));
  const firstPack = buildClosePack({ ...closeBase, screening });
  const closeChecks = await checksOf(LEDGER.filter((row) => firstPack.entries.some((entry) => entry.seq === row.seq)));
  const pack = buildClosePack({ ...closeBase, screening, checks: closeChecks });
  const closePack = closePackDocument(pack, { origin: "https://www.vestiarion.xyz" });

  // --- Written as the API answers them: one line of `{ "data": ... }` --------------------------------------------------

  const examples = {
    "get-invoice-evidence": billEvidence,
    "get-milestone-evidence": milestoneEvidence,
    "get-invoice-receipt": receipt,
    "get-payee-lock-evidence": payeeLock,
    "get-close-pack": closePack,
  };
  const destination = path.resolve(import.meta.dirname, "../content/docs/examples");
  for (const [id, data] of Object.entries(examples)) {
    const text = JSON.stringify({ data });
    for (const email of [...MEMBERS.values()].map((member) => member.email)) {
      if (text.includes(email)) throw new Error(`${id} names a member by email; the API names members by user id (EA3).`);
    }
    writeFileSync(path.join(destination, `${id}.json`), `${text}\n`);
    console.log(`wrote content/docs/examples/${id}.json (${text.length} bytes)`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
