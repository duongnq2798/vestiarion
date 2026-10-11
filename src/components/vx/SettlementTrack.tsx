import { Check, ChevronRight, Circle, CircleAlert, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import { utcMinute } from "@/lib/copy";
import { networkProfile, type Network } from "@/lib/network";
import { chainById, txUrl } from "@/lib/payee-chains";
import { ageText, GATEWAY_FAILED, SETTLEMENT_STAGES, type Settlement, type SettlementConflict, type SettlementMismatch, type SettlementStage, type StageMark } from "@/lib/settlement";
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
export const MISMATCH_SENTENCE: Record<SettlementMismatch, string> = {
  confirmed_not_marked_paid: "Confirmed, but the bill is not marked paid yet: the agent's next cycle marks it.",
  marked_paid_not_confirmed: "The bill is marked paid, but Circle has not confirmed this transfer.",
  marked_paid_other_transaction: "The bill is marked paid with another transaction than this one.",
  no_signed_entry: "The bill is marked paid with this transaction, but no signed entry names it.",
};

/** What a send Circle never answered means, and what Vestiarion does about it (I18, payment safety R4). */
export const UNKNOWN_OUTCOME =
  "Outcome unknown: Circle did not answer when this payment was sent, so it may have taken the transfer. Vestiarion looks for it on Circle before anything else is sent, and sends a new transfer only once Circle shows none.";

/** The same for a payout to another chain, which Circle cannot list this way: it is asked for again under its own key (R4). */
export const UNKNOWN_OUTCOME_ACROSS =
  "Outcome unknown: Circle did not answer when this payment was sent, so it may have taken the transfer. A payout to another chain is asked for again under the same payment key, which Circle takes only once, so it is never sent twice.";

/** What an unknown outcome means for this payment, without its "Outcome unknown: " lead. */
export function unknownOutcome(settlement: Pick<Settlement, "crossChain">): string {
  return (settlement.crossChain ? UNKNOWN_OUTCOME_ACROSS : UNKNOWN_OUTCOME).replace(/^Outcome unknown: /, "");
}

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
      return `Outcome unknown · checking with Circle${sent}${attempt}`;
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

/** Circle's state word, said as it is. */
const circleWord = (state: string | null | undefined) => (state ? ` (Circle: ${state})` : "");

/** What a reached stage says, from its source (L2, L4). */
function reachedLine(stage: SettlementStage, mark: StageMark, settlement: Settlement, network: Network): string {
  const label = networkProfile(network).label;
  switch (stage) {
    case "proposed":
      return mark.by === "person" ? "A person chose to pay it." : "The agent decided to pay it.";
    case "authorized":
      return mark.by === "two_people" ? "Two people approved it." : mark.by === "person" ? "A person approved it." : "Code's checks passed, so the agent could pay it on its own.";
    case "submitted":
      return settlement.attempt > 1 ? `Vestiarion sent it to Circle, as attempt ${settlement.attempt}.` : "Vestiarion sent it to Circle.";
    case "pending":
      if (mark.state === "STUCK") return "Circle shows it stuck: it was sent and can still be mined (Circle: STUCK).";
      // Gateway's failure is not an end: its attestation may still be minted, so nothing is sent again (L3).
      if (mark.state === GATEWAY_FAILED) return "Gateway reported it failed, but it may still be minted on the payee's chain, so nothing is sent again (Circle: GATEWAY_FAILED).";
      // The watch names Circle's word only when Circle answered it; otherwise it told the payment from its age alone.
      if (mark.by === "watch") return mark.state ? `Not confirmed when the transfer watch asked Circle${circleWord(mark.state)}.` : "Not confirmed when the transfer watch checked it.";
      return `Circle took it and had not confirmed it yet${circleWord(mark.state)}.`;
    case "confirmed":
      return settlement.simulated ? "Simulated in the sandbox: confirmed at once, with nothing on chain." : `Circle confirmed it on ${label}.`;
    case "available":
      // Said of the transfer, whatever its token (USDC or EURC); never of a bank, which Vestiarion does not see (L4).
      return mark.chain
        ? `Minted on ${chainById(mark.chain).label}: the money is in the payee's wallet there.`
        : `A confirmed transfer on ${label} is final: the money is in the payee's wallet there. Moving it to a bank is the payee's own step, which Vestiarion does not see.`;
    case "reconciled":
      return "The bill is marked paid with this transaction, and a signed entry records it.";
  }
}

/** What a stage not reached says. */
function waitingLine(stage: SettlementStage, settlement: Settlement, ended: boolean, furthest: number): string {
  // Said first: a confirmed payment that reached no wallet says why, even once the books caught up after it.
  if (stage === "available" && settlement.stages.confirmed) return settlement.simulated ? "A simulated payment reaches no wallet." : "Not minted on the payee's chain yet.";
  if (SETTLEMENT_STAGES.indexOf(stage) < furthest) return "Not recorded here.";
  return ended ? "Not reached." : "Not yet.";
}

/** How an attempt ended, in a sentence (L3): the payee was not paid, never "no money moved". */
function endLine(end: { end: "failed" | "cancelled" | "not_sent"; state: string | null; reason: string | null }): string {
  if (end.end === "cancelled") return "Cancelled: Circle cancelled it. The payee was not paid.";
  if (end.end === "not_sent") return "Not sent: the send did not reach Circle, so the payee was not paid.";
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
      {tx && <Hash value={tx} href={mark.chain ? `${chainById(mark.chain).explorerTx}${tx}` : txUrl(network, tx)} />}
    </span>
  );
}

export function SettlementTrack({
  id,
  settlement,
  orgSlug,
  network,
  now,
  defaultOpen = false,
}: {
  id: string;
  settlement: Settlement;
  orgSlug: string;
  /** The workspace's network: each stage names it and links its transactions there. */
  network: Network;
  /** When the page read it: what a payment in flight's age counts to. */
  now: number;
  defaultOpen?: boolean;
}) {
  const ended = settlement.end !== null;
  const unknown = settlement.status === "unknown";
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
        <span className={cn("text-right text-xs font-normal tabular-nums", settlement.mismatch || ended || unknown ? "text-held" : "text-ink-3")}>{settlementSummary(settlement, now)}</span>
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
            {settlement.mismatch && <li>{MISMATCH_SENTENCE[settlement.mismatch]}</li>}
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
