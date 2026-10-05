import { utcDay } from "./copy";
import { CHECKSUM_MISMATCH } from "./address-checksum";

/**
 * The freelancer's side of a payment
 * (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md): which of the three steps a
 * payee link is at, and each payment's state in the payee's words. Pure: the page reads the link's
 * status once (`payeeLinkStatus`) and decides everything here.
 */

export interface PayeePayment {
  kind: "milestone" | "invoice";
  title: string;
  amount: number;
  currency: "USDC" | "EURC";
  status: string;
  txRef: string | null;
  settledAt: string | null;
  scheduledFor: string | null;
}

export interface PayeeLinkStatus {
  orgName: string;
  payeeName: string;
  chain: string;
  /** `open` until the payee sends an address through the link; `used` after. */
  linkState: "open" | "used";
  expiresAt: string;
  usedAt: string | null;
  /** Until when the link shows this page: its expiry while unused, 30 days after use (R1). */
  statusUntil: string;
  address: string | null;
  addressConfirmed: boolean;
  payments: PayeePayment[];
}

/** Step 1 `address`, step 2 `confirming`, step 3 `paying`, and `paid` once every payment is. */
export type PayeeStage = "address" | "confirming" | "paying" | "paid";

export function payeeStage(status: PayeeLinkStatus): PayeeStage {
  if (status.linkState === "open") return "address";
  if (!status.address || !status.addressConfirmed) return "confirming";
  if (status.payments.length > 0 && status.payments.every((payment) => payment.status === "paid")) return "paid";
  return "paying";
}

export type PaymentTone = "waiting" | "progress" | "review" | "done";

/** A payment's state for its payee. A hold never says why (R3): that is the business's to discuss. */
export function paymentState(payment: PayeePayment, orgName: string): { label: string; tone: PaymentTone } {
  switch (payment.status) {
    case "paid":
      return { label: "Paid", tone: "done" };
    case "matched":
      return { label: "On its way", tone: "progress" };
    case "scheduled":
      return { label: payment.scheduledFor ? `Scheduled for ${utcDay(payment.scheduledFor)}` : "Scheduled", tone: "progress" };
    case "verified":
      return { label: "Being prepared", tone: "progress" };
    case "pending":
      return payment.kind === "milestone"
        ? { label: `Waiting for ${orgName} to approve the work`, tone: "waiting" }
        : { label: "Being prepared", tone: "progress" };
    default:
      return { label: `With ${orgName} for review`, tone: "review" };
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What the payee reads when what they typed is not an address, in the form and from the server alike. */
export const NOT_AN_ADDRESS = "That doesn't look like a wallet address. It starts with 0x and has 42 characters in all.";

/** What the payee reads when the address's capital letters do not match its checksum: a character is likely mistyped (payment safety A3). */
export const ADDRESS_CHECKSUM = `${CHECKSUM_MISMATCH} Copy it again from your wallet.`;

/** Whether the text is an EVM address, as the payee's form checks it before the server does. */
export function looksLikeAddress(raw: string): boolean {
  return ADDRESS.test(raw.trim());
}

/** `0x1234…abcd`: how the page shows an address it did not just ask for (R4). */
export function maskAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** `0x` and the rest in fours, so a person can read an address back against their wallet. */
export function groupAddress(address: string): string[] {
  const body = address.trim().replace(/^0x/i, "");
  const groups = body.match(/.{1,4}/g) ?? [];
  return ["0x", ...groups];
}

/** The payments' total per currency, USDC first: "30.50 USDC", or "25.00 USDC and 10.00 EURC". */
export function amountsLine(payments: PayeePayment[]): string {
  const totals = new Map<string, number>();
  for (const payment of payments) totals.set(payment.currency, (totals.get(payment.currency) ?? 0) + payment.amount);
  return ["USDC", "EURC"]
    .filter((currency) => totals.has(currency))
    .map((currency) => `${(totals.get(currency) as number).toFixed(2)} ${currency}`)
    .join(" and ");
}
