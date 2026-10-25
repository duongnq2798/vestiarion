/**
 * The monthly close pack's shared contract (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md): the shape
 * the builder makes, the page and the files show, and the later Google Sheets export and v1 read carry. Types and constants
 * only; everything else is imported as a type, so a component may import this file.
 *
 * `ClosePackDocument` (./export) holds only strings, numbers, booleans, null, arrays, objects and literal unions (CP18). A
 * change to the shape is `vestiarion-close-pack/2`.
 */
import type { OrgRole } from "../auth/roles";
import type { EvidenceKind, EvidenceScreening } from "../evidence-chain";
import type { EvidenceKey, SignedEntry } from "../evidence-export";
import type { LedgerRow } from "../ledger";
import type { Network } from "../network";
import type { EntryCheck } from "../receipts/verify";
import type { SettlementMismatch } from "../settlement";
import type { ClosePackMonth } from "./month";

export const CLOSE_PACK_FORMAT = "vestiarion-close-pack/1";
/** The most payments one month's pack reads, rows and not settled together (CP15). */
export const CLOSE_PACK_MAX_PAYMENTS = 2000;

/** An amount as text with exactly six decimal places, "1250.500000": never a float (CP6). */
export type Decimal = string;
export type ClosePackToken = "USDC" | "EURC";
export type ClosePackSource = { kind: "invoice" | "milestone"; id: string };
/** The payee's screening check a row reads (CP8), as the evidence chain reads it. */
export type ClosePackScreening = EvidenceScreening;

/** Who did a step (CP7). `email` is null when the pack is read with `people: "id"`, or when members could not be read. */
export type ClosePackWho =
  | { kind: "member"; userId: string; email: string | null; roleNow: OrgRole | null }
  | { kind: "former_member"; userId: string }
  | { kind: "payee_link"; linkId: string | null }
  | { kind: "github"; login: string | null }
  | { kind: "unknown" };

/** How a check is known: the evidence chain's seven words, and one for a check with nothing to look at (CP8). */
export type ClosePackCheckKind = EvidenceKind | "not_applicable";

export interface ClosePackCheck {
  kind: ClosePackCheckKind;
  /** One sentence. */
  text: string;
  /** Short lines under it: each guardrail's line, marked ✓ ✗ ·. */
  notes: string[];
  /** When it was checked or recorded (ISO), or null. */
  at: string | null;
  /** The entries it rests on, by seq. */
  entries: number[];
  /** Bad news, however well it is known: screened high risk, an address on OFAC's list, paid before the wait. */
  warn: boolean;
}

export interface ClosePackChecks {
  guardrails: ClosePackCheck;
  screening: ClosePackCheck;
  walletList: ClosePackCheck;
  payeeLock: ClosePackCheck;
  payTo: ClosePackCheck;
  /** `not_applicable` for a bill. */
  milestone: ClosePackCheck;
}

export interface ClosePackApproval {
  who: ClosePackWho;
  at: string;
  /** An accountant's co-sign: its `approval_given` carries `cosign: true`. It paid nothing itself. */
  cosign: boolean;
  /** This approval sent the payment: the paying entry's own person. */
  paid: boolean;
  /** Where it came from when not the app: "telegram", "slack", "api", …; null for the app. */
  via: string | null;
  /** The `approval_given` / `milestone_approval_given` that recorded it, or the paying entry; null when none is read. */
  entry: number | null;
}

export interface ClosePackAddress {
  /** The address paid, in full. */
  address: string;
  /** Vestiarion made it in shadow mode (`via: "mirror"`): no person typed it. */
  mirror: boolean;
  givenBy: ClosePackWho | null;
  givenAt: string | null;
  confirmedBy: ClosePackWho | null;
  confirmedAt: string | null;
  /** With Confirm address, or by approving a payment to it. */
  confirmedWith: "confirm" | "approval" | null;
  /** Someone other than whoever gave it confirmed it: true only when known (`secondPersonOf`, payee lock evidence EP2). */
  secondPerson: boolean | null;
  entries: number[];
}

export interface ClosePackApprovalChain {
  /** code: the agent paid it within its rules; person: one approval; two_people: two; null: no entry records it. */
  authorizedBy: "code" | "person" | "two_people" | null;
  agent: {
    /** ap_pay, ap_schedule, ap_hold, ap_flag_fraud, ap_request_info, milestone_release or milestone_hold. */
    action: string;
    /** `deciderName(decisionMode)`: "Claude", "DeepSeek", "The written policy", "The model". */
    decider: string;
    /** The rule a guardrail held it by (`guardrailRule`), or null. */
    guardrailRule: string | null;
    shadow: boolean;
    at: string;
    entry: number;
  } | null;
  /** The earlier first; empty when the agent paid it. */
  approvals: ClosePackApproval[];
  verdict: { verdict: "agree" | "disagree"; who: ClosePackWho; at: string; entry: number } | null;
  flags: { soleApprover: boolean; addressGiverApproved: boolean; firstPayment: boolean; fewApprovers: boolean };
  /** Null for a bank payout or a simulated payee address. */
  address: ClosePackAddress | null;
}

export type ClosePackBill =
  | {
      kind: "invoice";
      id: string;
      /** The vendor's own number, from `create_invoice` (`invoiceNumberInDetail`). */
      number: string | null;
      amount: Decimal;
      currency: ClosePackToken;
      /** A shadow-mode bill as written in the business's currency (`create_invoice.detail.bill`). */
      written: { amount: number; currency: string } | null;
      /** YYYY-MM-DD. */
      dueDate: string | null;
      poReference: string | null;
      /** Cut to 200 characters (CP17). */
      memo: string | null;
      /** The document the bill was read from; the document itself is not kept. */
      document: { sha256: string; kind: string | null } | null;
      /** Sent by the vendor through a document request (`document_received`). */
      vendorDocuments: Array<{ sha256: string; type: string | null; at: string; entry: number }>;
      /** Its `create_invoice`, `import_invoice` or `recurring_invoice_created`. */
      entry: number | null;
    }
  | { kind: "milestone"; id: string; title: string; amount: Decimal; currency: "USDC"; entry: number | null };

export interface ClosePackPayee {
  counterpartyId: string;
  name: string | null;
  /** The address paid (`payment_intents.destination`), in full; null for a bank payout. */
  address: string | null;
  bank: {
    provider: "blindpay";
    bankCode: string | null;
    last4: string | null;
    rail: string | null;
    receiverAmount: Decimal | null;
    receiverCurrency: string | null;
    payoutId: string | null;
  } | null;
}

export interface ClosePackTransaction {
  route: "direct" | "cctp" | "gateway" | "escrow" | "bank" | "simulated";
  /** The transaction that paid the payee: the transfer, or the mint on their chain. Null when none is on chain. */
  txHash: string | null;
  /** Circle's chain name, "ARC-TESTNET", "BASE-SEPOLIA", …; its label, "Arc testnet", "Base Sepolia". */
  chain: string | null;
  chainLabel: string | null;
  explorerUrl: string | null;
  /** CCTP: the burn on the workspace's own chain. */
  sourceTxHash: string | null;
  sourceExplorerUrl: string | null;
  /** What the simulator named a sandbox payment (`sim_…`). */
  simulatedRef: string | null;
  /** Why no transaction shows, when one should: "The payee's chain has not minted this payout yet." */
  note: string | null;
  networkFeeUsd: Decimal | null;
  networkFeeSource: "chain_reported" | "provider_estimate" | "simulated_profile" | null;
  /** CCTP or Gateway: the route's fee, in USDC. */
  routeFeeUsdc: Decimal | null;
  /** Attempts Circle ended before the one that paid. */
  earlierAttempts: number;
}

export interface ClosePackRecord {
  seq: number;
  action: string;
  ts: string;
  hash: string;
  signature: string;
  signingKeyId: string | null;
  /** The server's check of this entry alone. Before checks are given: `{ ok: null, reason: "Not checked yet." }`. */
  check: EntryCheck;
}

export interface ClosePackRow {
  paymentId: string;
  source: ClosePackSource;
  /** `confirmed_at` (CP2). */
  paidAt: string;
  /** `submitted_at`, else `created_at`. */
  sentAt: string;
  amount: Decimal;
  token: ClosePackToken;
  discount: Decimal | null;
  simulated: boolean;
  shadow: boolean;
  payee: ClosePackPayee;
  bill: ClosePackBill;
  approval: ClosePackApprovalChain;
  checks: ClosePackChecks;
  transaction: ClosePackTransaction;
  record: ClosePackRecord | null;
  books: {
    markedPaid: boolean;
    mismatch: SettlementMismatch | null;
    booked: { tool: string; state: string; paymentId: string | null; at: string; entry: number } | null;
  };
  /** `/o/<slug>/evidence/<kind>/<id>`. */
  evidencePath: string;
  /** Every entry the row cites, ascending. */
  entries: number[];
}

export type ClosePackOpenState =
  | "settled_later" | "waiting" | "in_flight" | "unknown" | "gateway_failed" | "failed" | "cancelled" | "not_sent" | "refunded";

export interface ClosePackOpenPayment {
  paymentId: string;
  source: ClosePackSource;
  payee: { counterpartyId: string; name: string | null };
  amount: Decimal;
  token: ClosePackToken;
  simulated: boolean;
  state: ClosePackOpenState;
  sentAt: string | null;
  /** `settled_later` only: when it settled. */
  settledAt: string | null;
  /** Circle's state and reason, or Vestiarion's error, as the intent keeps them. */
  reason: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  evidencePath: string;
}

export interface ClosePackEscrowMove {
  kind: "funded" | "refunded";
  at: string;
  milestoneId: string;
  title: string | null;
  amount: Decimal;
  txHash: string | null;
  explorerUrl: string | null;
  entry: number;
}

export interface ClosePackTotal {
  token: ClosePackToken;
  payments: number;
  amount: Decimal;
  routeFeesUsdc: Decimal;
}

export interface ClosePackTotals {
  onChain: ClosePackTotal[];
  simulated: ClosePackTotal[];
  /** Shadow-mode rows, counted inside `onChain`. */
  shadow: number;
  notSettled: Partial<Record<ClosePackOpenState, number>>;
  /** Payments whose bill is gone (CP2). */
  withoutBill: number;
  entries: { cited: number; verified: number; failed: number; unchecked: number };
}

/** A cited entry in full, as the evidence export carries it (snake_case), with the server's check (evidence API EA10). */
export type ClosePackEntry = SignedEntry;

export interface ClosePack {
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  month: ClosePackMonth;
  ended: boolean;
  /** When it was read (ISO). */
  readAt: string;
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  /** Parts that could not be read just now; the rest shows. */
  unread: Array<"members" | "screening">;
  people: "email" | "id";
  totals: ClosePackTotals;
  rows: ClosePackRow[];
  notSettled: ClosePackOpenPayment[];
  escrow: ClosePackEscrowMove[];
  keys: EvidenceKey[];
  entries: ClosePackEntry[];
}

/** The rows the reader hands the builder: the columns `read.ts` selects. */
export interface ClosePackIntentRow {
  id: string;
  source_type: "invoice" | "milestone";
  source_id: string;
  status: string;
  provider: string;
  provider_mode: string | null;
  provider_tx_id: string | null;
  provider_state: string | null;
  failure_reason: string | null;
  last_error: string | null;
  amount: string | number;
  token: string | null;
  destination: string;
  tx_hash: string | null;
  chain: string | null;
  destination_chain: string | null;
  mint_tx_hash: string | null;
  bridge_fee: string | number | null;
  payout_route: string | null;
  network: string | null;
  fee_usd: string | number | null;
  fee_source: string | null;
  transfer_attempt: number | null;
  previous_attempts: unknown;
  batch_key: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  executed_at: string | null;
  confirmed_at: string | null;
}
export interface ClosePackInvoiceRow {
  id: string;
  direction: string;
  counterparty_id: string;
  amount: string | number;
  currency: string | null;
  paid_amount: string | number | null;
  memo: string | null;
  po_reference: string | null;
  due_date: string | null;
  status: string;
  tx_ref: string | null;
  settled_at: string | null;
}
export interface ClosePackMilestoneRow {
  id: string;
  contractor_id: string;
  title: string;
  amount: string | number;
  status: string;
  verified: boolean;
  verification_method: string | null;
  verification_status: string | null;
  verification_source: string | null;
  verification_checked_at: string | null;
  verified_at: string | null;
  verification_detail: Record<string, unknown> | null;
  tx_ref: string | null;
  settled_at: string | null;
  escrow_state: string | null;
  escrow_payee: string | null;
  escrow_amount: string | number | null;
  escrow_release_tx_hash: string | null;
}
export type ClosePackLedgerRow = LedgerRow & { id?: string };
