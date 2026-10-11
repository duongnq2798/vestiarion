import { Check, ShieldX } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { ruleLabel } from "@/lib/rule-words";

/**
 * What a bill looks like once the agent has decided it, as the hero shows it
 * (docs/superpowers/specs/2026-10-11-landing-clarity-design.md H2): one bill
 * the agent would pay, waiting for a person's verdict in shadow mode, and one
 * that code held. The labels are the product's own ("Waiting for your
 * verdict", "Agent's reasoning", "Do you agree with the agent?", "Held for
 * you", "Blocked by code, not by the model"); the payees and amounts are
 * examples, and the figure says so. Nothing in it can be pressed.
 */

/** What the agent checked before deciding the first bill, said as a person would. */
const CHECKS = ["Work delivered: pull request merged", "Amount matches the milestone", "Within the contractor's limit", "Not paid before"] as const;

/** A control drawn as the product draws it, which this figure only shows. */
function DrawnButton({ children, primary = false }: { children: string; primary?: boolean }) {
  return (
    <span
      className={
        primary
          ? "inline-flex h-8 items-center rounded-lg bg-agent px-3 text-xs font-semibold text-on-agent shadow-control"
          : "inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-xs font-medium text-ink"
      }
    >
      {children}
    </span>
  );
}

export function BillPreview() {
  return (
    <figure className="relative w-full min-w-0 max-w-xl lg:max-w-none">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-raised">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-ground/70 px-4 py-2.5">
          <Eyebrow>Bills &amp; receivables</Eyebrow>
          <Badge tone="simulated" size="sm">
            Sample bills
          </Badge>
        </div>

        <div className="px-4 pb-4 pt-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name="Northwind Dev" tone="agent" shape="square" size="lg" />
              <div className="min-w-0">
                <p className="truncate text-[0.9375rem] font-semibold text-ink">Northwind Dev</p>
                <p className="truncate text-xs text-ink-3">Invoice 0412 · milestone 2 of 3</p>
              </div>
            </div>
            <p className="shrink-0 text-right font-mono text-lg font-semibold tracking-tight text-ink tabular-nums">
              2,400.00<span className="ml-1 text-[0.6875rem] font-medium text-ink-3">USDC</span>
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="proof" size="sm">
              Agent: pay it
            </Badge>
            <Badge tone="agent" size="sm" dot>
              Waiting for your verdict
            </Badge>
          </div>

          <Eyebrow className="mt-4 block text-agent">Agent&apos;s reasoning</Eyebrow>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            The checkout flow was delivered and its pull request merged. The amount matches the milestone you agreed, and it is due in four days.
          </p>

          <ul aria-label="Checked before deciding" className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {CHECKS.map((check) => (
              <li key={check} className="flex items-start gap-1.5 text-xs leading-snug text-ink-2">
                <Check aria-hidden className="mt-px size-3.5 shrink-0 text-proof" strokeWidth={3} />
                {check}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-agent-line/60 bg-agent-soft/50 px-4 py-3 sm:px-5">
          <p className="text-sm font-medium text-ink">Do you agree with the agent?</p>
          <div className="flex gap-2">
            <DrawnButton primary>Agree and pay</DrawnButton>
            <DrawnButton>Disagree</DrawnButton>
          </div>
        </div>
      </div>

      {/* The second bill sits under the first, a little in from its edges: the same list, a bill the agent may not pay. */}
      <div className="relative mx-3 -mt-px rounded-b-2xl border border-t-0 border-held-line bg-surface px-4 py-3 shadow-surface sm:mx-5">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold text-ink">
            Kestrel Design <span className="hidden font-normal text-ink-3 min-[420px]:inline">· invoice 0931</span>
          </p>
          <p className="shrink-0 font-mono text-sm font-semibold text-ink tabular-nums">
            6,500.00<span className="ml-1 text-[0.625rem] font-medium text-ink-3">USDC</span>
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Badge tone="held" size="sm">
            Held for you
          </Badge>
          <p className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-ink-2">
            <ShieldX aria-hidden className="mt-px size-3.5 shrink-0 text-held" />
            <span>
              Blocked by code, not by the model. {ruleLabel("counterparty.payment_limit")}.
            </span>
          </p>
        </div>
      </div>

      <figcaption className="mt-3 text-xs leading-relaxed text-ink-3">
        Two sample bills in shadow mode. The labels, checks and outcomes are the product&apos;s own; the payees and amounts are examples.
      </figcaption>
    </figure>
  );
}
