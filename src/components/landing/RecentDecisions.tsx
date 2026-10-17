import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock,
  Flag,
  Hourglass,
  MessageCircleQuestion,
  ShieldX,
  UserCheck,
  UserX,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import type { DecisionOutcomeKind, RecentDecisionView } from "@/lib/latest-decision";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import type { RecentDecisions } from "@/lib/platform/recent-decisions";
import { TRY_HREF, TRY_LABEL } from "./cta";

/**
 * The agent's decisions before its latest one, under it in the proof (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md
 * D3-D5): how many it made this past week on each network, then a short list, one row per bill, newest first. Each row
 * says what came of it in a word, what it was in a sentence, why, on which network with real or test money, and links
 * the transaction only when one went out. Static: it is read as the page loads, and nothing moves or refreshes.
 */

const ICONS: Record<DecisionOutcomeKind, LucideIcon> = {
  paid: CircleCheck,
  confirming: Clock,
  failed: CircleX,
  person_agreed: UserCheck,
  person_disagreed: UserX,
  awaiting_person: Hourglass,
  refused: ShieldX,
  flagged: Flag,
  scheduled: CalendarClock,
  asked: MessageCircleQuestion,
  held: CirclePause,
};

function decisions(count: number): string {
  if (count === 0) return "no decisions";
  return count === 1 ? "1 decision" : `${count.toLocaleString("en-US")} decisions`;
}

/** The past week's count, each network on its own: decisions, never money, and never the two added together. */
export function pastWeekSentence({ mainnet, testnet }: RecentDecisions["pastWeek"]): string {
  if (mainnet === 0 && testnet === 0) return "The agent made no decisions in the team's workspaces in the past 7 days.";
  return `In the past 7 days the agent made ${decisions(mainnet)} on ${ARC_MAINNET.label} and ${decisions(testnet)} on ${ARC_TESTNET.label} in the team's workspaces.`;
}

/** The earlier decisions, or nothing when there are none to list. */
export function RecentDecisionList({ recent }: { recent: { decisions: RecentDecisionView[]; pastWeek: RecentDecisions["pastWeek"] } }) {
  if (recent.decisions.length === 0) return null;
  return (
    <div className="mt-6 border-t border-line pt-5 sm:mt-8 sm:pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 id="earlier-decisions-title" className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-2">
          Earlier decisions
        </h3>
        <Link
          href="/how-it-decides"
          data-cta="proof-how-it-decides"
          className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-agent underline-offset-2 hover:underline"
        >
          How the agent decides
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-ink-2">
        {pastWeekSentence(recent.pastWeek)} A few of the newest, one row per bill, with the latest refusal by code among them when there is one.
        Customers&apos; decisions stay private: they are only counted, in the figures below.
      </p>
      <ol aria-labelledby="earlier-decisions-title" className="mt-4 divide-y divide-line border-y border-line">
        {recent.decisions.map((decision) => (
          <DecisionRow key={decision.seq} decision={decision} />
        ))}
      </ol>
      <p className="mt-4 text-pretty text-sm leading-relaxed text-ink-2">
        In shadow mode it decides on your own bills, with no wallet or funds to start.{" "}
        <Link href={TRY_HREF} data-cta="proof-try" className="inline-flex items-center gap-1 font-semibold text-agent underline-offset-4 hover:underline">
          {TRY_LABEL}
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </p>
    </div>
  );
}

/**
 * One decision. On a phone: what came of it and when on one line, the sentence under it, then the network and the
 * transaction. From a tablet up: what came of it in a column of its own, so the eye runs down paid, held, refused; the
 * network goes under the sentence, and beside it, at the right, only on a wide screen.
 */
function DecisionRow({ decision }: { decision: RecentDecisionView }) {
  const Icon = ICONS[decision.outcome.kind];
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 py-3.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:gap-x-6 sm:gap-y-1">
      <div className="col-start-1 row-start-1 self-center sm:row-span-2 sm:self-start sm:pt-0.5">
        <Badge tone={decision.outcome.tone} size="sm" shape="tag" icon={<Icon aria-hidden />}>
          {decision.outcome.label}
        </Badge>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1 lg:row-span-2">
        <p className="text-pretty text-[0.9375rem] font-medium leading-snug text-ink">{decision.headline}</p>
        {decision.detail && <p className="mt-0.5 text-pretty text-sm leading-relaxed text-ink-2">{decision.detail}</p>}
      </div>
      <p className="col-start-2 row-start-1 self-center text-right font-mono text-xs text-ink-3 sm:col-start-3 sm:self-start sm:pt-1">
        <time dateTime={decision.at} title={decision.atUtc}>
          {decision.ago}
        </time>
      </p>
      <p className="col-span-2 row-start-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs sm:col-start-2 sm:row-start-2 lg:col-span-1 lg:col-start-3 lg:justify-end">
        <span className={cn(decision.realMoney ? "font-semibold text-ink" : "text-ink-3")}>
          {decision.networkLabel} · {decision.realMoney ? "real money" : "test money"}
        </span>
        {decision.txUrl && (
          <a
            href={decision.txUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-cta="proof-transaction"
            className="inline-flex min-h-6 items-center gap-0.5 font-sans font-medium text-agent underline-offset-2 hover:underline"
          >
            Transaction
            <ArrowUpRight aria-hidden className="size-3.5" />
            <span className="sr-only">{` on the ${decision.networkLabel} explorer (opens in a new tab)`}</span>
          </a>
        )}
      </p>
    </li>
  );
}
