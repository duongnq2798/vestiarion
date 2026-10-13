import { billDigits } from "../bill-amount";
import { minorToDecimal } from "../deals/money";
import { NETWORKS, networkProfile, type Network } from "../network";

/**
 * Receipts written back to a CRM deal (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1-R6): what a deal
 * planned from the CRM has collected, from the money that arrived on Arc and was applied to its receivables; the deal
 * properties that carry it, which Vestiarion owns; the reality rule; and whether a person changed one of them in the CRM
 * since Vestiarion last wrote it. Pure: the runs (`crm-receipts-run.ts`) read the rows and call the CRM. Nothing that
 * moves money reads this module. Browser-safe: no Node module, so a card may read the words.
 */

/** The property group the fields live in, created once per CRM account. */
export const RECEIPT_GROUP = { name: "vestiarion", label: "Vestiarion" } as const;

export const COLLECTION_STATUSES = ["paid_in_full", "paid_to_date", "partly_paid", "overdue", "awaiting_payment", "nothing_invoiced"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const COLLECTION_STATUS_WORDS: Record<CollectionStatus, string> = {
  paid_in_full: "Paid in full",
  paid_to_date: "Paid to date",
  partly_paid: "Partly paid",
  overdue: "Overdue",
  awaiting_payment: "Awaiting payment",
  nothing_invoiced: "Nothing invoiced yet",
};

export const RECONCILIATIONS = ["reconciled", "needs_review", "no_receipts"] as const;
export type Reconciliation = (typeof RECONCILIATIONS)[number];

export const RECONCILIATION_WORDS: Record<Reconciliation, string> = {
  reconciled: "Reconciled",
  needs_review: "Needs review",
  no_receipts: "No receipts yet",
};

export const RECEIPT_FIELDS = [
  "vestiarion_collected",
  "vestiarion_still_owed",
  "vestiarion_currency",
  "vestiarion_collection_status",
  "vestiarion_last_receipt_date",
  "vestiarion_last_receipt_amount",
  "vestiarion_last_receipt_link",
  "vestiarion_reconciliation",
  "vestiarion_evidence_link",
] as const;
export type ReceiptField = (typeof RECEIPT_FIELDS)[number];

/** What Vestiarion writes to a deal: each field's value as text, "" for none. */
export type ReceiptFields = Record<ReceiptField, string>;

export interface ReceiptProperty {
  name: ReceiptField;
  label: string;
  /** The CRM's property type and its field type (HubSpot's words, which other CRMs map). */
  type: "number" | "string" | "date" | "enumeration";
  fieldType: "number" | "text" | "date" | "select";
  description: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

const SOURCE = "Written by Vestiarion: do not edit, the next receipt writes it again.";

/** The fields Vestiarion owns on a deal (R2): never a field of the CRM's own, and never another app's. */
export const RECEIPT_PROPERTIES: readonly ReceiptProperty[] = [
  {
    name: "vestiarion_collected",
    label: "Collected",
    type: "number",
    fieldType: "number",
    description: `Money received on Arc, confirmed by Circle and applied to this deal's invoices, in the currency below. ${SOURCE}`,
  },
  {
    name: "vestiarion_still_owed",
    label: "Still owed",
    type: "number",
    fieldType: "number",
    description: `Invoiced to the customer and not paid yet, in the currency below. Lines not invoiced yet are not in it. ${SOURCE}`,
  },
  { name: "vestiarion_currency", label: "Collection currency", type: "string", fieldType: "text", description: `The currency of Collected and Still owed. ${SOURCE}` },
  {
    name: "vestiarion_collection_status",
    label: "Collection status",
    type: "enumeration",
    fieldType: "select",
    description: `Where this deal's collections stand, from payments confirmed on Arc only. ${SOURCE}`,
    options: COLLECTION_STATUSES.map((value) => ({ value, label: COLLECTION_STATUS_WORDS[value] })),
  },
  { name: "vestiarion_last_receipt_date", label: "Last receipt date", type: "date", fieldType: "date", description: `The day the latest payment arrived on Arc (UTC). ${SOURCE}` },
  {
    name: "vestiarion_last_receipt_amount",
    label: "Last receipt amount",
    type: "number",
    fieldType: "number",
    description: `What the latest payment brought to this deal's invoices. ${SOURCE}`,
  },
  { name: "vestiarion_last_receipt_link", label: "Last receipt", type: "string", fieldType: "text", description: `The latest payment's transaction on Arc's explorer. ${SOURCE}` },
  {
    name: "vestiarion_reconciliation",
    label: "Reconciliation status",
    type: "enumeration",
    fieldType: "select",
    description: `Reconciled: every receipt counted was confirmed by Circle on Arc and applied to its invoice in Vestiarion. Needs review: an invoice is marked received without a payment on Arc, and is not counted. ${SOURCE}`,
    options: RECONCILIATIONS.map((value) => ({ value, label: RECONCILIATION_WORDS[value] })),
  },
  { name: "vestiarion_evidence_link", label: "Evidence", type: "string", fieldType: "text", description: `This deal in Vestiarion: its invoices, payments and signed trail. ${SOURCE}` },
];

export const RECEIPT_LABELS: Record<ReceiptField, string> = Object.fromEntries(RECEIPT_PROPERTIES.map((property) => [property.name, property.label])) as Record<ReceiptField, string>;

// ---------------------------------------------------------------------------
// What a deal has collected (R1)

/** A receivable made from one of the deal's lines. Amounts in the receivable's own currency, as numbers of it. */
export interface DealReceivable {
  id: string;
  amount: number;
  currency: string;
  status: string;
  /** `YYYY-MM-DD` */
  dueOn: string;
  /** Shadow mode's invoice in the business's own currency (0084): both or neither. */
  originalCurrency: string | null;
  originalAmount: number | null;
}

/**
 * A payment that arrived on Arc (`incoming_transfers`: recorded only once Circle reported it complete) and was applied to
 * one of the receivables: a whole match, or a live allocation. Its amount is what it brought to that receivable.
 */
export interface AppliedPayment {
  transferId: string;
  invoiceId: string;
  amount: number;
  receivedAt: string;
  txHash: string | null;
  /** Circle's blockchain name the payment arrived on (`ARC-TESTNET`, `ARC`). */
  chain: string;
}

export interface CollectionInput {
  deal: { currency: string; digits: 0 | 2; status: "active" | "cancelled" };
  receivables: readonly DealReceivable[];
  payments: readonly AppliedPayment[];
  /** Live fees a person marked on a receivable: they settle it, and are never collected. */
  fees: ReadonlyArray<{ invoiceId: string; amount: number }>;
  /** Charges in force not invoiced yet, in the deal's minor units. */
  notInvoicedMinor: number;
  /** `YYYY-MM-DD` */
  today: string;
}

export interface LastReceipt {
  /** `YYYY-MM-DD`, UTC. */
  on: string;
  minor: number;
  txHash: string | null;
  network: Network;
}

export interface Collection {
  currency: string;
  digits: 0 | 2;
  collectedMinor: number;
  stillOwedMinor: number;
  invoicedMinor: number;
  feesMinor: number;
  overdueMinor: number;
  notInvoicedMinor: number;
  /** Marked received with no payment on Arc behind it: never counted (R1). */
  unverifiedMinor: number;
  /** Receivables in a currency the deal cannot be told in: left out, and said. */
  leftOut: number;
  receipts: number;
  status: CollectionStatus;
  reconciliation: Reconciliation;
  lastReceipt: LastReceipt | null;
}

const SETTLED = new Set(["received", "paid"]);
const CLOSED = new Set(["rejected"]);

/** The network a payment arrived on, by Circle's blockchain name: Arc mainnet only when it says so. */
export function networkOfChain(chain: string): Network {
  return chain === NETWORKS["arc-mainnet"].circleBlockchain ? "arc-mainnet" : "arc-testnet";
}

/**
 * What a deal has collected (R1). Only money that arrived on Arc, confirmed by Circle, and was applied to one of its
 * invoices counts: nothing submitted, pending or promised. A part payment is part: the rest of that invoice is still
 * owed. A fee a person marked settles its invoice and is not collected. An invoice marked received with no payment on
 * Arc is not counted, and makes the reconciliation "needs review". In the deal's currency: a shadow-mode invoice kept in
 * it is converted at its own rate; one in another currency is left out.
 */
export function dealCollection(input: CollectionInput): Collection {
  const { deal } = input;
  const scale = 10 ** deal.digits;
  const totals = { collected: 0, owed: 0, invoiced: 0, fees: 0, overdue: 0, unverified: 0 };
  let leftOut = 0;
  const factorOf = new Map<string, number>();
  for (const receivable of input.receivables) {
    if (CLOSED.has(receivable.status) || !(receivable.amount > 0)) continue;
    const factor =
      receivable.originalCurrency === deal.currency && receivable.originalAmount !== null && receivable.originalAmount > 0
        ? receivable.originalAmount / receivable.amount
        : receivable.currency === deal.currency
          ? 1
          : null;
    if (factor === null) {
      leftOut += 1;
      continue;
    }
    factorOf.set(receivable.id, factor);
    const minor = (value: number) => Math.round(Number((value * factor * scale).toPrecision(15)));
    const paid = input.payments.filter((payment) => payment.invoiceId === receivable.id).reduce((sum, payment) => sum + payment.amount, 0);
    const fees = input.fees.filter((fee) => fee.invoiceId === receivable.id).reduce((sum, fee) => sum + fee.amount, 0);
    const settled = SETTLED.has(receivable.status);
    const owed = settled ? 0 : Math.max(0, receivable.amount - paid - fees);
    totals.invoiced += minor(receivable.amount);
    totals.collected += minor(Math.min(paid, receivable.amount));
    totals.fees += minor(fees);
    totals.owed += minor(owed);
    if (owed > 0 && receivable.dueOn < input.today) totals.overdue += minor(owed);
    if (settled && paid + fees <= 0) totals.unverified += minor(receivable.amount);
  }

  // The latest payment: what it brought to this deal's invoices, all of them.
  const counted = input.payments.filter((payment) => factorOf.has(payment.invoiceId));
  const transfers = [...new Set(counted.map((payment) => payment.transferId))];
  const latest = [...counted].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.transferId.localeCompare(a.transferId))[0];
  const lastReceipt: LastReceipt | null = latest
    ? {
        on: new Date(latest.receivedAt).toISOString().slice(0, 10),
        minor: counted
          .filter((payment) => payment.transferId === latest.transferId)
          .reduce((sum, payment) => sum + Math.round(Number((payment.amount * (factorOf.get(payment.invoiceId) ?? 1) * scale).toPrecision(15))), 0),
        txHash: latest.txHash,
        network: networkOfChain(latest.chain),
      }
    : null;

  const status: CollectionStatus =
    totals.invoiced === 0 && totals.collected === 0
      ? "nothing_invoiced"
      : totals.owed === 0
        ? input.notInvoicedMinor > 0 && deal.status === "active"
          ? "paid_to_date"
          : "paid_in_full"
        : totals.collected > 0
          ? "partly_paid"
          : totals.overdue > 0
            ? "overdue"
            : "awaiting_payment";
  const reconciliation: Reconciliation = totals.unverified > 0 ? "needs_review" : transfers.length === 0 ? "no_receipts" : "reconciled";
  return {
    currency: deal.currency,
    digits: deal.digits,
    collectedMinor: totals.collected,
    stillOwedMinor: totals.owed,
    invoicedMinor: totals.invoiced,
    feesMinor: totals.fees,
    overdueMinor: totals.overdue,
    notInvoicedMinor: Math.max(0, input.notInvoicedMinor),
    unverifiedMinor: totals.unverified,
    leftOut,
    receipts: transfers.length,
    status,
    reconciliation,
    lastReceipt,
  };
}

/** The explorer page of a transaction on its network, or "" without a well-formed hash. */
export function receiptLink(receipt: Pick<LastReceipt, "txHash" | "network">): string {
  if (!receipt.txHash || !/^0x[0-9a-fA-F]{64}$/.test(receipt.txHash)) return "";
  return `${networkProfile(receipt.network).payeeChains[0].explorerTx}${receipt.txHash}`;
}

/** The fields written for a collection (R2), with the deal's page in Vestiarion as its evidence. */
export function receiptFields(collection: Collection, evidenceUrl: string): ReceiptFields {
  const amount = (minor: number) => minorToDecimal(minor, collection.digits);
  return {
    vestiarion_collected: amount(collection.collectedMinor),
    vestiarion_still_owed: amount(collection.stillOwedMinor),
    vestiarion_currency: collection.currency,
    vestiarion_collection_status: collection.status,
    vestiarion_last_receipt_date: collection.lastReceipt?.on ?? "",
    vestiarion_last_receipt_amount: collection.lastReceipt ? amount(collection.lastReceipt.minor) : "",
    vestiarion_last_receipt_link: collection.lastReceipt ? receiptLink(collection.lastReceipt) : "",
    vestiarion_reconciliation: collection.reconciliation,
    vestiarion_evidence_link: evidenceUrl,
  };
}

/** A deal's page in Vestiarion, as its evidence link. */
export function evidenceUrl(origin: string, slug: string, dealId: string): string {
  return `${origin.replace(/\/+$/, "")}/o/${slug}/invoices/deals/${dealId}`;
}

/** Fields as stored (`crm_receipt_writes.fields`), every one there as text; null when they do not read. */
export function readReceiptFields(value: unknown): ReceiptFields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = {} as ReceiptFields;
  for (const name of RECEIPT_FIELDS) {
    const field = record[name];
    if (field === null || field === undefined) fields[name] = "";
    else if (typeof field === "string") fields[name] = field;
    else return null;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Comparing what the CRM holds (R5)

const PROPERTY_TYPE: Record<ReceiptField, ReceiptProperty["type"]> = Object.fromEntries(RECEIPT_PROPERTIES.map((property) => [property.name, property.type])) as Record<
  ReceiptField,
  ReceiptProperty["type"]
>;

/** A value as the CRM may hand it back: a number without its trailing zeros, a day from an instant, text trimmed. */
export function normalField(name: ReceiptField, value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (text === "") return "";
  switch (PROPERTY_TYPE[name]) {
    case "number": {
      const match = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
      if (!match) return text;
      const fraction = (match[2] ?? "").replace(/0+$/, "");
      const whole = match[1].replace(/^(-?)0+(?=\d)/, "$1");
      return fraction ? `${whole}.${fraction}` : whole;
    }
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      if (/^\d+$/.test(text)) return new Date(Number(text)).toISOString().slice(0, 10);
      const at = Date.parse(text);
      return Number.isNaN(at) ? text : new Date(at).toISOString().slice(0, 10);
    }
    default:
      return text;
  }
}

export const sameField = (name: ReceiptField, a: string | null | undefined, b: string | null | undefined) => normalField(name, a) === normalField(name, b);

/** The fields where the CRM holds something else than `expected`. */
export function differing(expected: ReceiptFields, held: Readonly<Record<string, string | null>>): ReceiptField[] {
  return RECEIPT_FIELDS.filter((name) => !sameField(name, expected[name], held[name]));
}

/** One field a person changed in the CRM since Vestiarion last wrote it. */
export interface FieldConflict {
  field: ReceiptField;
  /** What Vestiarion last wrote and read back; "" before its first write. */
  ours: string;
  /** What the CRM holds now. */
  theirs: string;
  /** What Vestiarion would write now. */
  next: string;
}

/**
 * Whether someone changed Vestiarion's fields in the CRM since it last wrote them (R5): each field the CRM holds
 * otherwise than the last write read back. Before a first write, any field already holding something is someone
 * else's. With `seen` (a person chose to write Vestiarion's figures over what the page showed them), a field holding
 * exactly what they saw is no conflict; anything else still is.
 */
export function fieldConflicts(input: {
  owned: ReceiptFields | null;
  held: Readonly<Record<string, string | null>>;
  next: ReceiptFields;
  seen?: Readonly<Record<string, string>> | null;
}): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const field of RECEIPT_FIELDS) {
    const theirs = normalField(field, input.held[field]);
    const ours = input.owned ? normalField(field, input.owned[field]) : "";
    if (theirs === ours) continue;
    if (input.seen && field in input.seen && normalField(field, input.seen[field]) === theirs) continue;
    conflicts.push({ field, ours, theirs, next: normalField(field, input.next[field]) });
  }
  return conflicts;
}

/** What the CRM held when a person chose to overwrite it, field by field. */
export function seenOf(conflicts: readonly FieldConflict[]): Record<string, string> {
  return Object.fromEntries(conflicts.map((conflict) => [conflict.field, conflict.theirs]));
}

/** Stored conflicts, or none when they do not read. */
export function readConflicts(value: unknown): FieldConflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FieldConflict[] => {
    if (typeof item !== "object" || item === null) return [];
    const { field, ours, theirs, next } = item as Record<string, unknown>;
    if (typeof field !== "string" || !(RECEIPT_FIELDS as readonly string[]).includes(field)) return [];
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return [{ field: field as ReceiptField, ours: text(ours), theirs: text(theirs), next: text(next) }];
  });
}

// ---------------------------------------------------------------------------
// The reality rule (R4)

/** The payments behind a write: their network, and whether the workspace keeps shadow mode. */
export interface ReceiptReality {
  network: Network;
  shadow: boolean;
}

export type ReceiptRealityOutcome = { ok: true } | { ok: false; refused: true; reason: "shadow" | "testnet" } | { ok: false; refused: false };

/**
 * Receipts are only ever written into a CRM of the same reality (R4). Payments on Arc mainnet outside shadow mode
 * moved real money: any account. Any other (Arc testnet, or shadow mode) only into an account the CRM itself says is a
 * test one (HubSpot: a developer test account or a sandbox). `test` null: the account was not read, so not yet, and not
 * refused either: it is read again, never guessed.
 */
export function receiptReality(payments: ReceiptReality, test: boolean | null): ReceiptRealityOutcome {
  if (payments.network === "arc-mainnet" && !payments.shadow) return { ok: true };
  if (test === true) return { ok: true };
  if (test === false) return { ok: false, refused: true, reason: payments.shadow ? "shadow" : "testnet" };
  return { ok: false, refused: false };
}

/** The words every surface says of receipts the reality rule keeps out of a real CRM account. */
export const receiptRealityRefusal = (label: string) =>
  `Not written: payments on Arc testnet and in shadow mode are written only to a ${label} developer test account or sandbox, never to a real ${label} account.`;

// ---------------------------------------------------------------------------
// Words (R8)

/** A field's value for a person: amounts with their currency, the statuses in words. */
export function fieldWords(field: ReceiptField, value: string, currency: string | null): string {
  if (value === "") return "none";
  switch (field) {
    case "vestiarion_collected":
    case "vestiarion_still_owed":
    case "vestiarion_last_receipt_amount": {
      const amount = Number(value);
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(amount)) return value;
      // To the currency's places, as the deal writes it: what HubSpot hands back without its trailing zeros reads the same.
      const digits = currency ? billDigits(currency) : 2;
      const grouped = amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 6) });
      return currency && currency !== "VND" ? `${grouped} ${currency}` : grouped;
    }
    case "vestiarion_collection_status":
      return COLLECTION_STATUS_WORDS[value as CollectionStatus] ?? value;
    case "vestiarion_reconciliation":
      return RECONCILIATION_WORDS[value as Reconciliation] ?? value;
    default:
      return value;
  }
}
