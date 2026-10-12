import { Check, ChevronRight, Circle, CircleAlert, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import { bookedLine, type BookedMark } from "@/lib/connectors/booked";
import { utcMinute } from "@/lib/copy";
import { networkProfile, type Network } from "@/lib/network";
import { chainById, txUrl } from "@/lib/payee-chains";
import {
  ageText,
  GATEWAY_FAILED,
  SETTLEMENT_STAGES,
  type BridgeStep,
  type Settlement,
  type SettlementConflict,
  type SettlementMismatch,
  type SettlementStage,
  type StageMark,
} from "@/lib/settlement";
import { Hash } from "./Primitives";

/**
 * Where a payment is (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L7): its seven stages, each
 * with when it was reached, the source that says so, and its entry or transaction, under the card's decision trail.
 * Folded until opened, like the trail; its summary says where the payment is now in words, so nothing is told by
 * colour alone. `#settlement-<id>` opens it (`ScrollToHash`).
 */

/** The id a link opens the track at. */
export function settlementAnchor(id: string): string {
  return `settlement-${id}`;
}

const NAME: Record<SettlementStage, string> = {
  proposed: "Proposed",
  authorized: "Authorized",
  submitted: "Submitted",
  pending: "Pending",
  confirmed: "Confirmed",
  available: "In the payee's wallet",
  reconciled: "Reconciled",
};

/** How the books disagree, as the summary says it after the stage. */
const MISMATCH_SHORT: Record<SettlementMismatch, string> = {
  confirmed_not_marked_paid: "not yet marked paid",
  marked_paid_not_confirmed: "marked paid, not confirmed",
  marked_paid_other_transaction: "marked paid with another transaction",
  no_signed_entry: "no signed entry names it",
};

/** How the books disagree, in a sentence under the stages (L5). */
const MISMATCH_SENTENCE: Record<SettlementMismatch, string> = {
  confirmed_not_marked_paid: "Confirmed, but the bill is not marked paid yet.",
  marked_paid_not_confirmed: "The bill is marked paid, but Circle has not confirmed this transfer.",
  marked_paid_other_transaction: "The bill is marked paid with another transaction than this one.",
  no_signed_entry: "The bill is marked paid with this transaction, but no signed entry names it.",
};

/** Who marks a confirmed transfer's bill paid: whoever comes back to the bill (L5, L10). No one: nothing is promised. */
const MARKS_PAID = {
  cycle: "Confirmed, but the bill is not marked paid yet: the agent's next cycle marks it.",
  approvals: "Confirmed, but the bill is not marked paid yet: Approve and pay in Approvals records it.",
  contractors: "Confirmed, but the bill is not marked paid yet: Pay now on Contractors records it.",
} as const;

/** How this payment's books disagree, in a sentence under the stages and on Treasury (L5). */
export function mismatchSentence(settlement: Pick<Settlement, "mismatch" | "followUp">): string | null {
  if (!settlement.mismatch) return null;
  if (settlement.mismatch === "confirmed_not_marked_paid" && settlement.followUp) return MARKS_PAID[settlement.followUp];
  return MISMATCH_SENTENCE[settlement.mismatch];
}

/** What a send Circle never answered means, and what Vestiarion does about it (I18, payment safety R4). */
export const UNKNOWN_OUTCOME =
  "Outcome unknown: Circle did not answer when this payment was sent, so it may have taken the transfer. Vestiarion looks for it on Circle before anything else is sent, and sends a new transfer only once Circle shows none.";

/** The same for a payout to another chain, which Circle cannot list this way: it is asked for again under its own key (R4). */
export const UNKNOWN_OUTCOME_ACROSS =
  "Outcome unknown: Circle did not answer when this payment was sent, so it may have taken the transfer. A payout to another chain is asked for again under the same payment key, which Circle takes only once, so it is never sent twice.";

/**
 * Who an unknown send waits for, once the agent's cycle no longer comes back to its bill (L10): nothing looks for it
 * until a person's Approve and pay, or Pay now on a held milestone, which looks for it first and sends nothing twice.
 */
const WAITS_FOR_PERSON = {
  approvals: "Nothing checks it on its own now: it waits for a person's Approve and pay in Approvals.",
  contractors: "Nothing checks it on its own now: it waits for a person's Pay now on Contractors.",
} as const;

/** What an unknown outcome means for this payment, without its "Outcome unknown: " lead, and whom it waits for. */
export function unknownOutcome(settlement: Pick<Settlement, "crossChain" | "followUp">): string {
  const meaning = (settlement.crossChain ? UNKNOWN_OUTCOME_ACROSS : UNKNOWN_OUTCOME).replace(/^Outcome unknown: /, "");
  return settlement.followUp && settlement.followUp !== "cycle" ? `${meaning} ${WAITS_FOR_PERSON[settlement.followUp]}` : meaning;
}

/** Who looks for an unknown send now, in the summary: the cycle checks it with Circle; a held bill waits for a person (L10). */
const UNKNOWN_SHORT = {
  cycle: " · checking with Circle",
  approvals: " · waiting for a person in Approvals",
  contractors: " · waiting for a person on Contractors",
} as const;

/** Where the payment is now, in a few words: the track's summary, and Treasury's row. */
export function settlementSummary(settlement: Settlement, now: number): string {
  const attempt = settlement.attempt > 1 ? ` · attempt ${settlement.attempt}` : "";
  const sent = settlement.inFlightSince ? ` · sent ${ageText(now - Date.parse(settlement.inFlightSince))} ago` : "";
  const books = settlement.mismatch ? ` · ${MISMATCH_SHORT[settlement.mismatch]}` : "";
  switch (settlement.status) {
    case "reconciled":
      return `Reconciled${attempt}`;
    case "confirmed":
      return `Confirmed${books}${attempt}`;
    case "in_flight":
      return `${settlement.stage === "pending" ? "Pending" : "Submitted"}${sent}${books}${attempt}`;
    case "unknown":
      // Said to be checked only while the agent's cycle comes back to the bill; promised to no one when no one does.
      return `Outcome unknown${settlement.followUp ? UNKNOWN_SHORT[settlement.followUp] : ""}${sent}${attempt}`;
    // Not in flight: nothing watches it any more, so no age counts (L3).
    case "gateway_failed":
      return `Gateway reported it failed${books}${attempt}`;
    case "failed":
      return `Failed${books}${attempt}`;
    case "cancelled":
      return `Cancelled${books}${attempt}`;
    case "not_sent":
      return `Not sent${books}${attempt}`;
    case "waiting":
      return "Not sent yet";
  }
}

/** A payee chain as the track names it; one no network lists (a row from before it was refused) by its own id, unlinked. */
function payeeChain(chain: string): { label: string; explorerTx: string | null } {
  try {
    const entry = chainById(chain);
    return { label: entry.label, explorerTx: entry.explorerTx };
  } catch {
    return { label: chain, explorerTx: null };
  }
}

/** Circle's state word, said as it is, and when it was read (`asOf`) once that is not the stage's own time. */
const circleWord = (state: string | null | undefined, asOf: string | null = null) => {
  const when = asOf ? `as of ${asOf}` : "";
  return state ? ` (Circle: ${state}${when ? `, ${when}` : ""})` : when ? ` (${when})` : "";
};

/**
 * When the pending stage's word was read, in UTC, once that is another minute than the stage's: the stage is reached when
 * Circle took the transfer, and each later read, the agent's cycle's or the transfer watch's, only updates the word (L2).
 */
function wordReadAt(mark: Pick<StageMark, "at" | "stateAt">): string | null {
  if (!mark.stateAt) return null;
  const read = utcMinute(mark.stateAt);
  return mark.at && utcMinute(mark.at) === read ? null : read;
}

/**
 * What Circle's word for a CCTP payout means when it is about the payout's step on the network, not the payout (L3): its
 * burn is confirmed and the mint is not recorded yet, or its approve is confirmed and the burn is not sent yet. The
 * transfer watch's read is said as the watch's. The pending stage says it as a sentence, with when the word was read
 * (`asOf`), and Treasury's row in its line.
 */
export function stepConfirmedLine(step: BridgeStep, mark: Pick<StageMark, "by" | "state">, network: Network, asOf: string | null = null): string {
  const on = `the ${step.step} on ${networkProfile(network).label}`;
  const confirmed = mark.by === "watch" ? `When the transfer watch asked, Circle had confirmed ${on}` : `Circle confirmed ${on}`;
  const toCome = step.step === "approve" ? "the burn that pays the payee has not been sent yet" : `the mint on ${step.chain ? payeeChain(step.chain).label : "the payee's chain"} is not recorded yet`;
  return `${confirmed}; ${toCome}${circleWord(mark.state, asOf)}`;
}

/** What a reached stage says, from its source (L2, L4). */
function reachedLine(stage: SettlementStage, mark: StageMark, settlement: Settlement, network: Network): string {
  const label = networkProfile(network).label;
  switch (stage) {
    case "proposed":
      return mark.by === "person" ? "A person chose to pay it." : "The agent decided to pay it.";
    case "authorized":
      return mark.by === "two_people" ? "Two people approved it." : mark.by === "person" ? "A person approved it." : "Code's checks passed, so the agent could pay it on its own.";
    case "submitted": {
      const which = settlement.attempt > 1 ? `, as attempt ${settlement.attempt}` : "";
      // A send Circle never took was started, not sent: the end below says so (L3). The sandbox never contacts Circle.
      if (settlement.end?.end === "not_sent") return `Vestiarion started sending it${which}.`;
      return settlement.simulated ? `Vestiarion simulated sending it${which}.` : `Vestiarion sent it to Circle${which}.`;
    }
    case "pending": {
      // The stage's time is when Circle took it; Circle's word says when it was read, once that is later (L2).
      const asOf = wordReadAt(mark);
      if (mark.state === "STUCK") return `Circle shows it stuck: it was sent and can still be mined${circleWord(mark.state, asOf)}.`;
      // Gateway's failure is not an end: its attestation may still be minted, so nothing is sent again (L3). Neither the
      // transfer watch nor the agent's cycle reads it again: only a person's Approve and pay does.
      if (mark.state === GATEWAY_FAILED) {
        return `Gateway reported it failed, but it may still be minted on the payee's chain, so nothing is sent again${circleWord(mark.state, asOf)}. Nothing checks it on its own: check with Circle whether it was minted.`;
      }
      // A CCTP payout's burn (or approve) Circle confirmed: Circle's word is the step's, never the payout's (L3).
      if (settlement.stepConfirmed) return `${stepConfirmedLine(settlement.stepConfirmed, mark, network, asOf)}.`;
      // The watch names Circle's word only when Circle answered it; otherwise it told the payment from its age alone.
      if (mark.by === "watch") return mark.state ? `Not confirmed when the transfer watch asked Circle${circleWord(mark.state, asOf)}.` : `Not confirmed when the transfer watch checked it${circleWord(null, asOf)}.`;
      return `Circle took it and had not confirmed it yet${circleWord(mark.state, asOf)}.`;
    }
    case "confirmed":
      if (settlement.simulated) return "Simulated in the sandbox: confirmed at once, with nothing on chain.";
      // A payout to another chain is confirmed once it is minted there, which the next stage names.
      return settlement.crossChain ? "Circle confirmed it." : `Circle confirmed it on ${label}.`;
    case "available":
      // Said of the transfer, whatever its token (USDC or EURC); never of a bank, which Vestiarion does not see (L4).
      return mark.chain
        ? `Minted on ${payeeChain(mark.chain).label}: the money is in the payee's wallet there.`
        : `A confirmed transfer on ${label} is final: the money is in the payee's wallet there. Moving it to a bank is the payee's own step, which Vestiarion does not see.`;
    case "reconciled":
      return "The bill is marked paid with this transaction, and a signed entry records it.";
  }
}

/** What the reconciled stage says when the entries were not all read and none read names the transaction (L5). */
export const RECORDING_UNREAD =
  "The bill is marked paid with this transaction. The signed entry that records it is older than the entries this page reads, so it is not checked here.";

/** What a stage not reached says. */
function waitingLine(stage: SettlementStage, settlement: Settlement, ended: boolean, furthest: number): string {
  // Said first: a confirmed payment that reached no wallet says why, even once the books caught up after it.
  if (stage === "available" && settlement.stages.confirmed) return settlement.simulated ? "A simulated payment reaches no wallet." : "Not minted on the payee's chain yet.";
  if (stage === "reconciled" && settlement.recordingUnread) return RECORDING_UNREAD;
  if (SETTLEMENT_STAGES.indexOf(stage) < furthest) return "Not recorded here.";
  return ended ? "Not reached." : "Not yet.";
}

/** How an attempt ended, in a sentence (L3): the payee was not paid, never "no money moved". */
function endLine(end: { end: "failed" | "cancelled" | "not_sent"; state: string | null; reason: string | null }): string {
  if (end.end === "cancelled") return "Cancelled: Circle cancelled it. The payee was not paid.";
  if (end.end === "not_sent") {
    // Circle never took it: Circle refused the request, a check stopped it, the connection was never made, or Circle
    // listed nothing after a send it never answered. The row does not say which, so the recorded reason does (L3).
    const reason = end.reason?.trim().replace(/\.$/, "");
    return `Not sent: it stopped before Circle took the transfer${reason ? ` (${reason})` : ""}. The payee was not paid.`;
  }
  const why = [end.state, end.reason].filter(Boolean).join(": ");
  return `Failed: Circle ended it${why ? ` (${why})` : ""}. The payee was not paid.`;
}

function conflictLine(conflict: SettlementConflict): string {
  const at = utcMinute(conflict.at);
  if (conflict.kind === "failure_after_confirmed") return `A failure recorded on ${at}, after Circle confirmed this transfer, is ignored: a confirmed transfer stays confirmed.`;
  if (conflict.kind === "confirmed_after_failure") return `Circle confirmed this transfer on ${at}, after it was recorded as ended: the confirmation stands, since money moved.`;
  return `Circle showed this transfer on ${at}, though it was recorded as never sent: Circle's answer stands.`;
}

const ICON = {
  done: { icon: Check, className: "text-proof", word: "reached" },
  open: { icon: Circle, className: "text-ink-3", word: "not reached" },
  ended: { icon: X, className: "text-refused", word: "ended" },
  unknown: { icon: CircleAlert, className: "text-held", word: "unknown" },
} as const;

function StageRow({ kind, title, at, children }: { kind: keyof typeof ICON; title: string; at?: string | null; children: ReactNode }) {
  const { icon: Icon, className, word } = ICON[kind];
  return (
    <li className="relative flex gap-2.5">
      <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", className)} strokeWidth={2.5} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={cn("font-medium", kind === "open" ? "text-ink-3" : "text-ink")}>{title}</span>
          <span className="sr-only">, {word}</span>
          {at && (
            <time dateTime={at} className="font-mono text-xs tabular-nums text-ink-3">
              {utcMinute(at)}
            </time>
          )}
        </p>
        <div className={cn("mt-0.5 text-xs leading-5", kind === "open" ? "text-ink-3" : "text-ink-2")}>{children}</div>
      </div>
    </li>
  );
}

/** A transaction on a payee chain's explorer, when the chain has one the track knows. */
const linkOn = (explorerTx: string | null, tx: string) => (explorerTx ? `${explorerTx}${tx}` : undefined);

function Refs({ mark, orgSlug, network }: { mark: StageMark; orgSlug: string; network: Network }) {
  const tx = mark.txHash && /^0x[0-9a-fA-F]{64}$/.test(mark.txHash) ? mark.txHash : null;
  if (mark.seq == null && !tx) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-x-2 align-baseline">
      {mark.seq != null && (
        <Link href={orgHref(orgSlug, `/audit#seq-${mark.seq}`)} className="font-mono text-ink-3 hover:text-ink hover:underline">
          #{String(mark.seq).padStart(4, "0")}
        </Link>
      )}
      {tx && <Hash value={tx} href={mark.chain ? linkOn(payeeChain(mark.chain).explorerTx, tx) : txUrl(network, tx)} />}
    </span>
  );
}

/** In the books: the payment booked in the accounting tool, as the tool stated it when read back. */
function BookingRow({ mark, orgSlug, network }: { mark: BookedMark; orgSlug: string; network: Network }) {
  const line = bookedLine(mark);
  return (
    <ol className="space-y-2.5 border-t border-line pt-3" aria-label="In the books">
      <StageRow kind={line.reached ? "done" : mark.state === "refused" || mark.state === "failed" ? "unknown" : "open"} title={line.title} at={line.reached ? mark.at : null}>
        {line.text}
        <Refs mark={{ at: mark.at, by: "books", seq: mark.seq }} orgSlug={orgSlug} network={network} />
      </StageRow>
    </ol>
  );
}

export function SettlementTrack({
  id,
  settlement,
  orgSlug,
  network,
  now,
  defaultOpen = false,
  booking = null,
}: {
  id: string;
  settlement: Settlement;
  orgSlug: string;
  /** The workspace's network: each stage names it and links its transactions there. */
  network: Network;
  /** When the page read it: what a payment in flight's age counts to. */
  now: number;
  defaultOpen?: boolean;
  /**
   * Its booking in the accounting tool, after the seven stages (accounting write-back W10): what the tool said when
   * Vestiarion read it back, from the signed entries; none for a payable not brought in from one.
   */
  booking?: BookedMark | null;
}) {
  const ended = settlement.end !== null;
  const unknown = settlement.status === "unknown";
  const gatewayFailed = settlement.status === "gateway_failed";
  // The furthest stage reached: stages before it with nothing recorded say so, rather than "not yet".
  const furthest = settlement.stage ? SETTLEMENT_STAGES.indexOf(settlement.stage) : -1;
  // An end, or an unknown outcome, is told where the payment stopped: after the send, or after Circle's last word.
  const stopAfter: SettlementStage = settlement.stages.pending ? "pending" : "submitted";
  return (
    <details id={settlementAnchor(id)} open={defaultOpen} className="group/settlement scroll-mt-4 border-t border-line">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-ink-2 transition-colors duration-150 ease-standard hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/settlement:rotate-90" />
          Where the payment is
        </span>
        <span className={cn("text-right text-xs font-normal tabular-nums", settlement.mismatch || ended || unknown || gatewayFailed ? "text-held" : "text-ink-3")}>{settlementSummary(settlement, now)}</span>
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1 sm:px-5">
        <ol className="space-y-2.5" aria-label="The payment's stages">
          {SETTLEMENT_STAGES.flatMap((stage) => {
            const mark = settlement.stages[stage];
            const row = mark ? (
              <StageRow key={stage} kind="done" title={NAME[stage]} at={mark.at}>
                {reachedLine(stage, mark, settlement, network)}
                <Refs mark={mark} orgSlug={orgSlug} network={network} />
                {stage === "pending" && settlement.readFailedAt && <span className="block">Circle could not be read just now; nothing is sent again until it answers.</span>}
              </StageRow>
            ) : (
              <StageRow key={stage} kind="open" title={NAME[stage]}>
                {waitingLine(stage, settlement, ended, furthest)}
              </StageRow>
            );
            if (stage !== stopAfter) return [row];
            return [
              row,
              settlement.end ? (
                <StageRow key="end" kind="ended" title={settlement.end.end === "cancelled" ? "Cancelled" : settlement.end.end === "not_sent" ? "Not sent" : "Failed"} at={settlement.end.at}>
                  {endLine(settlement.end)}
                </StageRow>
              ) : unknown ? (
                <StageRow key="unknown" kind="unknown" title="Outcome unknown" at={settlement.unknownSince}>
                  {unknownOutcome(settlement)}
                </StageRow>
              ) : null,
            ].filter((item) => item !== null);
          })}
        </ol>
        {booking && <BookingRow mark={booking} orgSlug={orgSlug} network={network} />}
        {settlement.earlier.length > 0 && (
          <div className="text-xs text-ink-2">
            <p className="font-medium text-ink">Earlier attempts</p>
            <ul className="mt-1 space-y-0.5">
              {settlement.earlier.map((attempt) => (
                <li key={attempt.attempt}>
                  Attempt {attempt.attempt}
                  {attempt.at ? `, ${utcMinute(attempt.at)}` : ""}: {attempt.end ? endLine({ end: attempt.end, state: attempt.state, reason: attempt.reason }) : "No end recorded."}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(settlement.mismatch || settlement.conflicts.length > 0) && (
          <ul className="space-y-0.5 text-xs text-held">
            {settlement.mismatch && <li>{mismatchSentence(settlement)}</li>}
            {settlement.conflicts.map((conflict) => (
              <li key={`${conflict.kind}-${conflict.at}`}>{conflictLine(conflict)}</li>
            ))}
          </ul>
        )}
        {settlement.stages.confirmed && !settlement.simulated && (
          <p className="text-xs text-ink-3">A confirmed transfer cannot be charged back or reversed. A refund would be a new transfer back, a separate payment.</p>
        )}
      </div>
    </details>
  );
}
