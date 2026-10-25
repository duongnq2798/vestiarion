import { shortPaymentId } from "../connectors/booked";
import { EVIDENCE_MEANINGS, EVIDENCE_WORDS } from "../evidence-chain";
import { chainById, homeChain, networkOfChain } from "../payee-chains";
import { ruleWords } from "../rule-words";
import { closePackMonth, type ClosePackMonth } from "./month";
import type { ClosePackCheck, ClosePackCheckKind, ClosePackEscrowMove, ClosePackOpenPayment, ClosePackRecord, ClosePackRow, ClosePackWho, Decimal } from "./types";

/**
 * The monthly close pack in words (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md, "Screens and copy"):
 * the page, the CSV and the table read the same sentences from here, so they never word a payment differently. Pure and
 * browser-safe. Every network and chain name comes from its profile.
 */

/** How a check is known: the evidence chain's seven words, and "Does not apply" for a check with nothing to look at (CP8). */
export const CHECK_KIND_WORDS: Readonly<Record<ClosePackCheckKind, string>> = { ...EVIDENCE_WORDS, not_applicable: "Does not apply" };

/** What each word means, in one sentence: the page explains them once, and the signed JSON carries them. */
export const CHECK_KIND_MEANINGS: Readonly<Record<ClosePackCheckKind, string>> = {
  ...EVIDENCE_MEANINGS,
  not_applicable: "There is nothing of this kind to check for this payment: a bank payout pays no address on chain, and a bill has no milestone.",
};

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

/** Who did a step, in words: a member's email, "a former member (1a2b3c4d)", "the payee, through their payee link". */
export function whoWords(who: ClosePackWho): string {
  switch (who.kind) {
    case "member":
      return who.email ?? `a member (${who.userId.slice(0, 8)})`;
    case "former_member":
      return `a former member (${who.userId.slice(0, 8)})`;
    case "payee_link":
      return "the payee, through their payee link";
    case "github":
      return who.login ? `the payee on GitHub (${who.login})` : "the payee on GitHub";
    default:
      return "someone the ledger does not name";
  }
}

/** A member with the role they hold now, which is not the role they held then: that is not signed (CP7). */
function whoWithRole(who: ClosePackWho): string {
  return who.kind === "member" && who.roleNow ? `${whoWords(who)} (${who.roleNow})` : whoWords(who);
}

/** "1,250.50 USDC": the decimal's own digits, 2 to 6 places, grouped by thousands; never read through a float (CP6). */
export function amountWords(amount: Decimal, token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return `${amount} ${token}`;
  const [, sign, whole, fraction = ""] = match;
  const places = fraction.replace(/0+$/, "").padEnd(2, "0").slice(0, 6);
  const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${places} ${token}`;
}

/** "2026-10-20 14:03 UTC". */
export function utcWords(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return ts;
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "Checked by code: Code checked it before it was sent." */
export function checkCell(check: ClosePackCheck): string {
  return `${CHECK_KIND_WORDS[check.kind]}: ${check.text}`;
}

/** What the agent decided, and a person's shadow-mode verdict on it (CP7). */
export function decidedLines(row: ClosePackRow): string[] {
  const agent = row.approval.agent;
  if (!agent) return ["No decision of the agent's is recorded."];
  const shadow = agent.shadow ? " in shadow mode" : "";
  const held = ruleWords(agent.guardrailRule);
  let line: string;
  if (held) line = `The agent held it for a person: ${held}.`;
  else {
    switch (agent.action) {
      case "ap_pay":
        line = `${agent.decider} decided to pay it${shadow}.`;
        break;
      case "ap_schedule":
        line = `${agent.decider} decided to pay it on a later day${shadow}.`;
        break;
      case "ap_hold":
      case "milestone_hold":
        line = `${agent.decider} decided to hold it for a person${shadow}.`;
        break;
      case "ap_flag_fraud":
        line = `${agent.decider} flagged it for review${shadow}.`;
        break;
      case "ap_request_info":
        line = `${agent.decider} asked for more information before paying it${shadow}.`;
        break;
      case "milestone_release":
        line = `${agent.decider} decided to release it${shadow}.`;
        break;
      default:
        line = `${agent.decider} decided${shadow}.`;
    }
  }
  const verdict = row.approval.verdict;
  if (!verdict) return [line];
  return [line, `${whoWords(verdict.who)} ${verdict.verdict === "agree" ? "agreed" : "disagreed"} with the agent's decision in shadow mode on ${utcWords(verdict.at)}.`];
}

/** Where a person's approval came from, after it: ", from Telegram". Nothing for the app. */
function viaWords(via: string | null): string {
  switch (via) {
    case null:
      return "";
    case "telegram":
      return ", from Telegram";
    case "slack":
      return ", from Slack";
    case "api":
      return ", through the API";
    default:
      return `, from ${via}`;
  }
}

/** Who approved it, the earlier first, and what the paying entry recorded about them (CP7). */
export function approvedLines(row: ClosePackRow): string[] {
  const { authorizedBy, approvals, flags } = row.approval;
  if (authorizedBy === "code") return ["No person approved it: code checked it and the agent paid it."];
  const lines = approvals.map((approval) => {
    const verb = approval.cosign ? "Co-signed by" : approval.paid ? "Approved and paid by" : "Approved by";
    return `${verb} ${whoWithRole(approval.who)} on ${utcWords(approval.at)}${viaWords(approval.via)}`;
  });
  if (flags.soleApprover) lines.push("Paid by the workspace's only approver.");
  if (flags.addressGiverApproved) lines.push("The person who gave the address made its first payment, as the workspace's only approver.");
  if (flags.fewApprovers) lines.push("Approved by whoever entered it or gave its address, as fewer than two others could approve.");
  if (flags.firstPayment) lines.push("The first payment to this address.");
  return lines.length > 0 ? lines : ["No entry records who approved it."];
}

/** Who gave the address paid and who confirmed it, and whether a second person stood behind it (CP7). None for a bank payout. */
export function addressLines(row: ClosePackRow): string[] {
  const address = row.approval.address;
  if (!address) return [];
  if (address.mirror) return ["A mirror address Vestiarion made in shadow mode: no person typed it."];
  const given = address.givenBy && address.givenAt ? address.givenBy : null;
  const at = address.givenAt ? utcWords(address.givenAt) : "";
  const givenLine =
    given?.kind === "payee_link"
      ? `Sent by the payee through their payee link on ${at}`
      : given?.kind === "github"
        ? `Given by the payee on GitHub${given.login ? ` (${given.login})` : ""} on ${at}`
        : given
          ? `Given by ${whoWords(given)} on ${at}`
          : "No entry names who gave it.";
  const confirmedLine =
    address.confirmedBy && address.confirmedAt
      ? `Confirmed by ${whoWords(address.confirmedBy)} on ${utcWords(address.confirmedAt)}${address.confirmedWith === "confirm" ? ", with Confirm address" : address.confirmedWith === "approval" ? ", by approving a payment to it" : ""}`
      : "Not confirmed before it was paid.";
  const second = address.secondPerson === true ? "Yes" : address.secondPerson === false ? "No" : "Not known";
  return [givenLine, confirmedLine, `A second person stood behind it: ${second}`];
}

/** A bill's own figure: whole when it is whole, else to the cent, as the evidence chain writes it. */
function writtenWords(amount: number, currency: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** "Invoice INV-2041, 1,250.00 USDC, due 2026-10-15"; a milestone by its title (CP7). */
export function billWords(row: ClosePackRow): string {
  const bill = row.bill;
  if (bill.kind === "milestone") return `Milestone "${bill.title}", ${amountWords(bill.amount, bill.currency)}`;
  const amount = amountWords(bill.amount, bill.currency);
  const written = bill.written ? ` (written as ${writtenWords(bill.written.amount, bill.written.currency)})` : "";
  const head = bill.number ? `Invoice ${bill.number}, ${amount}` : `A bill of ${amount}`;
  const due = bill.dueDate ? `, due ${bill.dueDate}` : "";
  const discount = row.discount ? `. ${amountWords(row.discount, row.token)} off for paying early` : "";
  return `${head}${written}${due}${discount}`;
}

/** The address paid in full; a bank payout's account by its bank and last 4 digits; a simulated payee address. */
export function paidToWords(row: ClosePackRow): string {
  const bank = row.payee.bank;
  if (bank) {
    const account = `Bank account${bank.bankCode ? ` ${bank.bankCode}` : ""}${bank.last4 ? ` ending ${bank.last4}` : ""}`;
    const rail = bank.rail ? `, by ${bank.rail.toUpperCase()}` : "";
    const received = bank.receiverAmount && bank.receiverCurrency ? `: ${amountWords(bank.receiverAmount, bank.receiverCurrency)}` : "";
    return `${account}${rail}, through BlindPay${received}`;
  }
  if (row.transaction.route === "simulated" && !row.approval.address) return "A simulated payee address: nothing was paid on chain.";
  return row.payee.address ?? "No address is recorded.";
}

/** The label of the chain a CCTP payout burned on: its network's own chain, from the payee chain's profile. */
function sourceChainLabel(chain: string | null): string | null {
  if (!chain) return null;
  try {
    return homeChain(networkOfChain(chain)).label;
  } catch {
    return null;
  }
}

function chainLabel(chain: string | null): string | null {
  if (!chain) return null;
  try {
    return chainById(chain).label;
  } catch {
    return null;
  }
}

/** How it was paid, by its route: "Transfer on <chain>", "Minted on <chain>, through CCTP from <chain>", … (CP9). */
export function transactionWords(row: ClosePackRow): string {
  const transaction = row.transaction;
  const on = transaction.chainLabel ?? chainLabel(transaction.chain) ?? "its chain";
  switch (transaction.route) {
    case "cctp": {
      const from = sourceChainLabel(transaction.chain);
      return `Minted on ${on}, through CCTP${from ? ` from ${from}` : ""}`;
    }
    case "gateway":
      return `From a Circle Gateway balance, minted on ${on}`;
    case "escrow":
      return `Released from escrow on ${on}`;
    case "bank":
      return "Bank payout through BlindPay";
    case "simulated":
      return transaction.simulatedRef ? `Simulated: nothing moved on chain (${transaction.simulatedRef})` : "Simulated: nothing moved on chain";
    default:
      return `Transfer on ${on}`;
  }
}

/** A CCTP payout's burn on the workspace's own chain: "Burn on <chain>: <hash>"; null for any other route. */
export function burnWords(row: ClosePackRow): string | null {
  const transaction = row.transaction;
  if (transaction.route !== "cctp" || !transaction.sourceTxHash) return null;
  return `Burn on ${sourceChainLabel(transaction.chain) ?? "the workspace's chain"}: ${transaction.sourceTxHash}`;
}

/** Whether the bill is marked paid with this transaction, and its booking in the accounting tool (CP10). */
export function booksWords(row: ClosePackRow): string {
  const books = row.books;
  const marked =
    books.mismatch === "confirmed_not_marked_paid"
      ? "Circle confirmed it, but the bill is not marked paid."
      : books.mismatch === "marked_paid_other_transaction"
        ? "The bill is marked paid with another transaction."
        : books.mismatch === "no_signed_entry"
          ? "No signed entry names this transaction."
          : books.mismatch === "marked_paid_not_confirmed"
            ? "The bill is marked paid, but Circle has not confirmed its transfer."
            : books.markedPaid
              ? "Marked paid with this transaction."
              : "Circle confirmed it, but the bill is not marked paid.";
  const booked = books.booked;
  if (!booked) return marked;
  const words =
    booked.state === "confirmed"
      ? `Booked in ${booked.tool}${booked.paymentId ? ` (payment ${shortPaymentId(booked.paymentId)})` : ""}`
      : booked.state === "sent"
        ? `Sent to ${booked.tool}`
        : booked.state === "refused"
          ? `Not booked in ${booked.tool}`
          : `Not booked in ${booked.tool} yet`;
  return `${marked} ${words}.`;
}

/** "#5619 approval_paid, signed with key 1a2b3c4d5e6f7a8b: Verified" (CP10). */
export function recordWords(record: ClosePackRecord | null): string {
  if (!record) return "No entry records this payment's transaction.";
  const key = record.signingKeyId ? `, signed with key ${record.signingKeyId}` : "";
  const check = record.check;
  const state = check.ok === true ? "Verified" : check.ok === false ? `Not verified: ${check.reason}` : `Not checked here: ${check.reason}`;
  return `#${record.seq} ${record.action}${key}: ${state}`;
}

/** A payment sent in the month that was not settled in it, by its state (CP3). */
export function openStateWords(payment: ClosePackOpenPayment, month: ClosePackMonth): string {
  const sent = payment.sentAt ? utcWords(payment.sentAt) : null;
  switch (payment.state) {
    case "settled_later": {
      const settled = payment.settledAt ? utcWords(payment.settledAt) : null;
      const counts = payment.settledAt ? closePackMonth(payment.settledAt.slice(0, 7), new Date(payment.settledAt)) : null;
      return `${sent ? `Sent on ${sent}, settled` : "Settled"}${settled ? ` on ${settled}` : " later"}: it counts in ${counts?.label ?? `the month after ${month.label}`}'s pack.`;
    }
    case "waiting":
      return "Waiting to be sent.";
    case "in_flight":
      return sent ? `Sent on ${sent}, not confirmed yet.` : "Sent, not confirmed yet.";
    case "unknown":
      return "Outcome unknown: Circle did not answer when it was sent, so it may have taken the transfer.";
    case "gateway_failed":
      return "Gateway reported it failed, but it may still be minted on the payee's chain.";
    case "failed":
      return `The transfer failed${payment.reason ? ` (${payment.reason})` : ""}. The payee was not paid.`;
    case "cancelled":
      return "Circle cancelled the transfer. The payee was not paid.";
    case "not_sent":
      return `Not sent: it stopped before Circle took the transfer${payment.reason ? ` (${payment.reason})` : ""}. The payee was not paid.`;
    case "refunded":
      return "BlindPay refunded the bank payout, so the USDC came back. The vendor was not paid.";
  }
}

/** "Locked 500.00 USDC in escrow for "Homepage redesign" on <time>" (CP4). */
export function escrowWords(move: ClosePackEscrowMove): string {
  const amount = amountWords(move.amount, "USDC");
  if (move.kind === "funded") return `Locked ${amount} in escrow${text(move.title) ? ` for "${move.title}"` : ""} on ${utcWords(move.at)}`;
  return `Refunded ${amount} from escrow to the workspace on ${utcWords(move.at)}`;
}
