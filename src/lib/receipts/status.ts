import { chainById } from "../payee-chains";
import type { ReceiptFacts } from "./facts";
import type { OnChainCheck } from "./onchain";
import type { EntryCheck } from "./verify";

/**
 * What a shared receipt says of where its payment is (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md
 * L7, I17): reconciled, or only confirmed, and from which source each is known. A receipt is only ever built from a
 * payment Circle confirmed (`buildReceipt`), so confirmed is the least it says; reconciled needs this page's own checks:
 * the transfer found on the chain, and the workspace's signed entry that records it.
 */

export interface ReceiptStatus {
  state: "reconciled" | "confirmed" | "not_reconciled";
  label: string;
  sentence: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "1 October 2026, 08:28 UTC", the same on the server and in every browser; empty for a time that is not one. */
export function receiptTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function receiptStatus(view: { facts: ReceiptFacts; records: { seq: number }; checks: { signed: EntryCheck; recorded: EntryCheck; onChain: OnChainCheck } }): ReceiptStatus {
  const { facts, records, checks } = view;
  const chain = chainById(facts.chain).label;
  const when = receiptTime(facts.paidAt);
  const confirmed = `Confirmed by Circle${when ? ` on ${when}` : ""}, as the paying workspace recorded it.`;
  if (checks.signed.ok === false || checks.recorded.ok === false || checks.onChain.state === "mismatch") {
    return { state: "not_reconciled", label: "Not reconciled", sentence: `${confirmed} A check below does not pass, so it is not reconciled.` };
  }
  if (checks.signed.ok === true && checks.recorded.ok === true && checks.onChain.state === "matches") {
    return {
      state: "reconciled",
      label: "Reconciled",
      sentence: `${confirmed} This page found the transfer on ${chain} in block ${checks.onChain.block}, and entry #${records.seq} in the workspace's signed ledger records it.`,
    };
  }
  const why =
    checks.onChain.state === "unreadable"
      ? `${chain} did not answer this page`
      : checks.recorded.ok === null
        ? "the entry that records it could not be checked here"
        : "the workspace's signature could not be checked here";
  return { state: "confirmed", label: "Confirmed", sentence: `${confirmed} Not reconciled just now: ${why}.` };
}
