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
 * examples, and the figure says so. Nothing in it can be pressed: its two
 * controls are drawn, hidden from screen readers, which hear that they are a
 * sample's instead (docs/superpowers/specs/2026-10-16-landing-hero-capture-design.md).
 * The checks sit in two columns only where the card is wide enough for each
 * to keep to one line.
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
    <figure className="@container relative w-full min-w-0 max-w-xl lg:max-w-none">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-raised">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-ground/70 px-4 py-2.5">
          <Eyebrow>Bills &amp; receivables</Eyebrow>
          <Badge tone="simulated" size="sm">
            Sample bills
          </Badge>
        </div>

        <div className="px-4 pb-4 pt-4 sm:px-5">
          {/* On the narrowest phones the amount takes its own line, so the payee's name and invoice keep their width. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
              <Avatar name="Northwind Dev" tone="agent" shape="square" size="lg" />
              <div className="min-w-0">
                <p className="truncate text-[0.9375rem] font-semibold text-ink">Northwind Dev</p>
                <p className="text-[0.8125rem] leading-snug text-ink-3">
                  <span className="whitespace-nowrap">Invoice 0412 ·</span> <span className="whitespace-nowrap">milestone 2 of 3</span>
                </p>
              </div>
            </div>
            <p className="ml-auto flex shrink-0 items-baseline gap-1 font-mono text-lg font-semibold tracking-tight text-ink tabular-nums">
              2,400.00<span className="text-xs font-medium tracking-normal text-ink-3">USDC</span>
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="proof" size="sm">
              Agent proposes: pay it
            </Badge>
            <Badge tone="agent" size="sm" dot>
              Waiting for your verdict
            </Badge>
          </div>

          <Eyebrow className="mt-4 block text-agent">Agent&apos;s reasoning</Eyebrow>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            The checkout flow was delivered and its pull request merged. The amount matches the milestone you agreed, and it is due in four days.
          </p>

          <ul aria-label="Checked before deciding" className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 @[32rem]:grid-cols-2">
            {CHECKS.map((check) => (
              <li key={check} className="flex items-start gap-2 text-[0.8125rem] leading-snug text-ink-2">
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-proof" strokeWidth={3} />
                {check}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-agent-line/60 bg-agent-soft/50 px-4 py-3 sm:px-5">
          <p className="text-sm font-medium text-ink">Do you agree with the agent?</p>
          <div aria-hidden className="flex cursor-default select-none gap-2">
            <DrawnButton primary>Agree and pay</DrawnButton>
            <DrawnButton>Disagree</DrawnButton>
          </div>
          <span className="sr-only">In the product: Agree and pay, or Disagree. Shown here as a sample.</span>
        </div>
      </div>

      {/* The second bill sits under the first, a little in from its edges: the same list, a bill the agent may not pay. */}
      <div className="relative mx-3 -mt-px rounded-b-2xl border border-t-0 border-held-line bg-held-soft/40 px-4 pb-3.5 pt-3 shadow-surface sm:mx-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">Kestrel Design</p>
            <p className="text-[0.8125rem] leading-snug text-ink-3">Invoice 0931</p>
          </div>
          <p className="flex shrink-0 items-baseline gap-1 font-mono text-[0.9375rem] font-semibold text-ink tabular-nums">
            6,500.00<span className="text-[0.6875rem] font-medium text-ink-3">USDC</span>
          </p>
        </div>
        <Badge tone="held" size="sm" className="mt-2">
          Held for you
        </Badge>
        <p className="mt-2 flex items-start gap-2 text-[0.8125rem] leading-snug text-ink-2">
          <ShieldX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-held" />
          <span>
            <span className="font-medium text-ink">Blocked by code, not by the model.</span> {ruleLabel("counterparty.payment_limit")}.
          </span>
        </p>
      </div>

      <figcaption className="mt-3 text-xs leading-relaxed text-ink-3">
        Two sample bills in shadow mode. The labels, checks and outcomes are the product&apos;s own; the payees and amounts are examples.
      </figcaption>
    </figure>
  );
}
