import { Check, ChevronRight, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { DecisionCard } from "./DecisionCard";
import type { DecisionSignal } from "./decision-signals";
import { Money, OutcomeBadge } from "./Primitives";
import type { Decision } from "./types";

/**
 * Decisions as a list to scan (AP / AR, Contractors): one row each, with who, what, the date that matters,
 * the amount and the outcome; opening a row shows the decision's full card, with its reasoning, evidence,
 * receipts and actions. Rows are `<details>`: they open without JavaScript and for find-in-page.
 */

export interface DecisionRowItem {
  decision: Decision;
  /** The date the row leads with: when it is due, scheduled, or was decided. */
  date?: { label: string; tone?: "held" } | null;
  /** What a person can do with the decision, in its card's footer (a receipt, a pay link). */
  footerAction?: ReactNode;
  /** What the row waits for, in a few words, under its title: a held milestone's reason. */
  hint?: string;
  /** What a person decides, above the card: a held milestone's reason and its actions. */
  before?: ReactNode;
  /** A form under the card, such as a milestone's verification. */
  after?: ReactNode;
  /** Open from the start: for a screenshot of the opened row. */
  open?: boolean;
  /** What the agent checked, as a short line under the title (`payableSignals`), so it shows before the row opens. */
  signals?: DecisionSignal[];
  /** Why it waits for a person, in one line under the title (`stoppedWhy`); the card, once opened, has the whole. */
  why?: string | null;
}

export function DecisionRows({ items, orgSlug, className }: { items: DecisionRowItem[]; orgSlug: string; className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.decision.id}>
            <DecisionRow item={item} orgSlug={orgSlug} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DecisionRow({ item, orgSlug }: { item: DecisionRowItem; orgSlug: string }) {
  const { decision, date } = item;
  const refused = decision.outcome === "refused";
  return (
    <Disclosure
      variant="bare"
      defaultOpen={item.open}
      summaryClassName="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 sm:grid-cols-[minmax(0,1fr)_9.5rem_7.5rem_12.5rem_1rem] sm:px-5"
      summary={
        <>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink">{decision.subject}</span>
            <span className="block truncate text-xs text-ink-3">
              {decision.memo ?? decision.action}
              {date && <span className={cn("sm:hidden", date.tone === "held" && "text-held")}> · {date.label}</span>}
            </span>
            {item.hint && <span className="block text-xs font-medium text-held">{item.hint}</span>}
            {item.signals && item.signals.length > 0 && <Signals signals={item.signals} />}
            {item.why && (
              <span className="mt-1 block text-xs leading-5 text-ink-2">
                <span className="font-medium text-ink">Why</span> · {item.why}
              </span>
            )}
          </span>
          <span className={cn("hidden whitespace-nowrap font-mono text-xs sm:block", date?.tone === "held" ? "text-held" : "text-ink-2")}>{date?.label ?? ""}</span>
          <span className="hidden justify-self-end sm:block">
            {decision.amount != null && <Money value={decision.amount} token={decision.token} struck={refused} className={cn("text-sm font-semibold", refused ? "text-ink-3" : "text-ink")} />}
          </span>
          <span className="flex flex-col items-end gap-1">
            {decision.amount != null && <Money value={decision.amount} token={decision.token} struck={refused} className="text-sm font-semibold text-ink sm:hidden" />}
            <OutcomeBadge outcome={decision.outcome} label={decision.outcomeLabel} />
          </span>
          <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
        </>
      }
    >
      <div className="space-y-3 border-t border-line bg-ground/40 p-3 sm:p-4">
        {item.before}
        <DecisionCard decision={decision} orgSlug={orgSlug} footerAction={item.footerAction} />
        {item.after}
      </div>
    </Disclosure>
  );
}

const SIGNAL = {
  ok: { icon: Check, className: "text-proof", label: "passed" },
  missing: { icon: X, className: "text-held", label: "in the way" },
  neutral: { icon: Minus, className: "text-ink-3", label: "noted" },
} as const;

/** The checks behind a decision, one word or two each, marked passed, in the way, or noted. */
function Signals({ signals }: { signals: DecisionSignal[] }) {
  return (
    <span role="list" aria-label="What the agent checked" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2">
      {signals.map((signal) => {
        const { icon: Icon, className, label } = SIGNAL[signal.state];
        return (
          <span role="listitem" key={signal.label} className="inline-flex items-center gap-1 whitespace-nowrap">
            <Icon aria-hidden className={cn("size-3 shrink-0", className)} strokeWidth={2.5} />
            {signal.label}
            <span className="sr-only">, {label}</span>
          </span>
        );
      })}
    </span>
  );
}

/** A heading inside a section, over one group of rows, with how many it holds. */
export function RowGroupHeading({ title, count, action }: { title: string; count: number; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex flex-wrap items-baseline justify-between gap-x-3 first:mt-0">
      <h3 className="text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-3">{count}</span>
      </h3>
      {action}
    </div>
  );
}
