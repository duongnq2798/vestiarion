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
  /**
   * Whether the link asks for the payee's invoice, and whether it arrived
   * (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P1, P4); absent before migration 0133.
   */
  asksInvoice?: boolean;
  invoiceSent?: boolean;
  /** Whether the link offers the payee to choose where it is paid (P1). */
  offersChain?: boolean;
  /** Whether the address on file is a mirror Vestiarion made in shadow mode, which is not the payee's to keep (P4). */
  addressMirror?: boolean;
  /** The chains the payee may choose among, its network's own first; empty or absent when it may not choose (P2). */
  chainChoices?: string[];
}

/**
 * Step 1 `address`, then `invoice` when the link asks for one not yet sent (P4), then `confirming`, `paying`, and
 * `paid` once every payment is. The invoice never outranks a payment under way: once the address is confirmed and a
 * payment is on its way or paid, the page shows that, and the invoice it can still take comes second (`invoiceOpen`).
 */
export type PayeeStage = "address" | "invoice" | "confirming" | "paying" | "paid";

/** Whether the link still takes the payee's invoice: it asks for one, none was sent, and no member closed it (0133). */
export function invoiceOpen(status: Pick<PayeeLinkStatus, "asksInvoice" | "invoiceSent">): boolean {
  return status.asksInvoice === true && status.invoiceSent !== true;
}

/** A payment to a confirmed address that is on its way or paid. */
function paymentUnderway(status: PayeeLinkStatus): boolean {
  return Boolean(status.address) && status.addressConfirmed && status.payments.some((payment) => payment.status === "matched" || payment.status === "paid");
}

export function payeeStage(status: PayeeLinkStatus): PayeeStage {
  if (status.linkState === "open") return "address";
  if (invoiceOpen(status) && !paymentUnderway(status)) return "invoice";
  if (!status.address || !status.addressConfirmed) return "confirming";
  if (status.payments.length > 0 && status.payments.every((payment) => payment.status === "paid")) return "paid";
  return "paying";
}

/**
 * After an accepted submission: the page moves on with the link's status the action answered with, or, without one,
 * reads itself again (docs/superpowers/specs/2026-10-20-payee-step-advance-design.md S1, S2).
 */
export function moveOn(answer: { status?: PayeeLinkStatus }, onSent: ((status: PayeeLinkStatus) => void) | undefined, refresh: () => void): void {
  if (answer.status && onSent) onSent(answer.status);
  else refresh();
}

/** The payment states the payee's page tells apart; any other is the business's to discuss, and reads as under review (R3). */
const PAYEE_PAYMENT_STATES: ReadonlySet<string> = new Set(["paid", "matched", "scheduled", "verified", "pending"]);

/**
 * What a payee link's page is given of its status (R1, R3, R4; payee step advance S6). The page is a client component,
 * so all of it is in the page's HTML and in each action's answer, for anyone holding the link: the address masked, each
 * payment's state one the page tells apart or `review`, a payment's transaction and dates only where the page shows them,
 * and nothing else the status read returns, now or later. An unused link's address on file is given only when the payee
 * may keep it: a mirror Vestiarion made in shadow mode is not theirs (P4), and the page says nothing of it. Every screen
 * renders from it as it did from the full status.
 */
export function payeeView(status: PayeeLinkStatus): PayeeLinkStatus {
  return {
    orgName: status.orgName,
    payeeName: status.payeeName,
    chain: status.chain,
    linkState: status.linkState,
    expiresAt: status.expiresAt,
    usedAt: status.usedAt,
    statusUntil: status.statusUntil,
    address: status.address && !(status.linkState === "open" && status.addressMirror === true) ? maskAddress(status.address) : null,
    addressConfirmed: status.addressConfirmed,
    payments: status.payments.map((payment) => {
      const state = PAYEE_PAYMENT_STATES.has(payment.status) ? payment.status : "review";
      return {
        kind: payment.kind,
        title: payment.title,
        amount: payment.amount,
        currency: payment.currency,
        status: state,
        txRef: state === "paid" ? payment.txRef : null,
        settledAt: state === "paid" ? payment.settledAt : null,
        scheduledFor: state === "scheduled" ? payment.scheduledFor : null,
      };
    }),
    asksInvoice: status.asksInvoice === true,
    invoiceSent: status.invoiceSent === true,
    chainChoices: [...(status.chainChoices ?? [])],
  };
}

export type PaymentTone = "waiting" | "progress" | "review" | "done";

/** A payment the simulator made: its reference is the simulator's (`sim_…`), never a transaction on chain. */
export function paymentSimulated(payment: Pick<PayeePayment, "status" | "txRef">): boolean {
  return payment.status === "paid" && (payment.txRef?.startsWith("sim_") ?? false);
}

/** A payment's state for its payee. A hold never says why (R3): that is the business's to discuss. */
export function paymentState(payment: PayeePayment, orgName: string): { label: string; tone: PaymentTone } {
  switch (payment.status) {
    case "paid":
      // A sandbox's payment is simulated, and says so, as the workspace's own pages do (capability and reasons R5).
      return { label: paymentSimulated(payment) ? "Paid (simulated)" : "Paid", tone: "done" };
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

/** What the payee reads when the chain it chose can no longer be chosen: the page was opened before the business's records changed (P2). */
export const CHAIN_CLOSED = "Where you are paid can no longer be chosen on this link. Reload the page.";

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
