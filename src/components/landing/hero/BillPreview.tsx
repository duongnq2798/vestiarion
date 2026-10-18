import { ArrowDown, Check, ShieldX } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { ruleLabel } from "@/lib/rule-words";
import { PrintOnView } from "./PrintOnView";
import { at, BILL_PRINT_AT, BILL_TICK_AFTER } from "./scenarios";

/**
 * What a bill looks like once the agent has decided it, as the hero shows it
 * (docs/superpowers/specs/2026-10-11-landing-clarity-design.md H2,
 * docs/superpowers/specs/2026-10-16-landing-hero-capture-design.md): two rows
 * of one list, as Bills & receivables shows them. The first, open, is a bill
 * the agent would pay, waiting for a person's verdict in shadow mode, its
 * reasoning set on a tint as the figure's focus; the second, a status row
 * under it, is one that code held. The labels are the product's own ("Waiting
 * for your verdict", "Agent's reasoning", "Do you agree with the agent?",
 * "Held for you", "Blocked by code, not by the model"); the payees and amounts
 * are examples, and the figure says so. Nothing in it can be pressed: its two
 * controls are drawn, quieter than the page's own call to action, and hidden
 * from screen readers, which hear that they are a sample's instead. The checks
 * sit in two columns only where the card is wide enough for each to keep to
 * one line.
 *
 * It prints itself once, the way the agent works through the bill (landing
 * motion M4): each part at its moment in `BILL_PRINT_AT`, the checks ticked one
 * by one, done by 2.5 s. The printing is CSS (`.bill-print` in landing-hero.css)
 * and every line is in the server's HTML: beside the headline it prints from the
 * first paint, and a page whose script never runs ends with the whole card.
 * `PrintOnView` holds each line the reader cannot see yet and prints it once it
 * is in view, which is how the card prints under the text on a narrower screen.
 * Under reduced motion each line fades in where it stands, in the same order.
 */

/** What the agent checked before deciding the first bill, said as a person would. */
const CHECKS = ["Work delivered: pull request merged", "Amount matches the milestone", "Within the contractor's limit", "Not paid before"] as const;

/** A control drawn as the product draws it, which this figure only shows. */
function DrawnButton({ children, primary = false }: { children: string; primary?: boolean }) {
  return (
    <span
      className={
        primary
          ? "inline-flex h-8 items-center rounded-lg border border-agent-line bg-agent-soft px-3 text-xs font-semibold text-agent"
          : "inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-xs font-medium text-ink"
      }
    >
      {children}
    </span>
  );
}

export function BillPreview() {
  return (
    <div className="w-full min-w-0 max-w-xl lg:max-w-none">
      <figure className="@container relative">
        <PrintOnView className="bill-print overflow-hidden rounded-2xl border border-line bg-surface shadow-raised">
          <div className="px-4 pb-4 pt-3.5 sm:px-5">
            {/* The card's title is there from the first frame, so the card is never an empty box. */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.8125rem] font-medium text-ink-3">Bills &amp; receivables</p>
              <Badge tone="simulated" size="sm">
                Sample bills
              </Badge>
            </div>

            {/* On the narrowest phones the amount takes its own line, so the payee's name and invoice keep their width. */}
            <div className="mt-3.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="bp-line flex min-w-0 flex-1 basis-40 items-center gap-3" style={at(BILL_PRINT_AT.payee)}>
                <Avatar name="Northwind Dev" tone="agent" shape="square" size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-[0.9375rem] font-semibold text-ink">Northwind Dev</p>
                  <p className="text-[0.8125rem] leading-snug text-ink-3">
                    <span className="whitespace-nowrap">Invoice 0412 ·</span> <span className="whitespace-nowrap">milestone 2 of 3</span>
                  </p>
                </div>
              </div>
              <p
                className="bp-line ml-auto flex shrink-0 items-baseline gap-1 font-mono text-lg font-semibold tracking-tight text-ink tabular-nums"
                style={at(BILL_PRINT_AT.amount)}
              >
                2,400.00<span className="text-xs font-medium tracking-normal text-ink-3">USDC</span>
              </p>
            </div>

            {/* The proposal is stamped as soon as the bill is read; the wait for a person prints once every check is ticked. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="bp-stamp inline-flex" style={at(BILL_PRINT_AT.proposal)}>
                <Badge tone="proof" size="sm">
                  Agent proposes: pay it
                </Badge>
              </span>
              <span className="bp-line inline-flex" style={at(BILL_PRINT_AT.waiting)}>
                <Badge
                  tone="agent"
                  size="sm"
                  icon={<span aria-hidden className="bp-dot relative size-1.5 shrink-0 rounded-full bg-agent" style={at(BILL_PRINT_AT.breathe)} />}
                >
                  Waiting for your verdict
                </Badge>
              </span>
            </div>

            {/* The agent's reasoning, the figure's focus: what it read, and what it checked before deciding. */}
            <div className="bp-line mt-4" style={at(BILL_PRINT_AT.reasoning)}>
              <div className="rounded-lg bg-agent-soft/30 px-3 py-2.5">
                <div className="bp-line" style={at(BILL_PRINT_AT.reasoningText)}>
                  <Eyebrow className="block text-agent">Agent&apos;s reasoning</Eyebrow>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">
                    The checkout flow was delivered and its pull request merged. The amount matches the milestone you agreed, and it is due in four days.
                  </p>
                </div>
                <ul aria-label="Checked before deciding" className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 @[32rem]:grid-cols-2">
                  {CHECKS.map((check, index) => (
                    <li key={check} className="bp-line flex items-start gap-2 text-[0.8125rem] leading-snug text-ink-2" style={at(BILL_PRINT_AT.checks[index])}>
                      <Check
                        aria-hidden
                        className="bp-check mt-0.5 size-3.5 shrink-0 text-proof"
                        strokeWidth={3}
                        style={at(BILL_PRINT_AT.checks[index] + BILL_TICK_AFTER)}
                      />
                      {check}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="bp-line mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2" style={at(BILL_PRINT_AT.verdict)}>
              <p className="text-sm font-medium text-ink">Do you agree with the agent?</p>
              <div aria-hidden className="flex cursor-default select-none gap-2">
                <DrawnButton primary>Agree and pay</DrawnButton>
                <DrawnButton>Disagree</DrawnButton>
              </div>
              <span className="sr-only">In the product: Agree and pay, or Disagree. Shown here as a sample.</span>
            </div>
          </div>

          {/* The list's next row, closed: a bill the agent may not pay, held by a rule in code, as a line of status. */}
          <div className="bp-line border-t border-line bg-ground/50 px-4 py-3 sm:px-5" style={at(BILL_PRINT_AT.next)}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name="Kestrel Design" tone="agent" shape="square" size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">Kestrel Design</p>
                  <p className="text-[0.8125rem] leading-snug text-ink-3">
                    <span className="whitespace-nowrap">Invoice 0931 ·</span>{" "}
                    <span className="whitespace-nowrap font-medium text-ink-2 tabular-nums">6,500.00 USDC</span>
                  </p>
                </div>
              </div>
              <span className="bp-stamp inline-flex shrink-0" style={at(BILL_PRINT_AT.held)}>
                <Badge tone="held" size="sm">
                  Held for you
                </Badge>
              </span>
            </div>
            <p className="bp-line mt-2 flex items-start gap-1.5 text-[0.8125rem] leading-snug text-ink-2" style={at(BILL_PRINT_AT.blocked)}>
              <ShieldX aria-hidden className="bp-turn mt-0.5 size-3.5 shrink-0 text-held" style={at(BILL_PRINT_AT.shield)} />
              <span>
                <span className="font-medium text-ink">Blocked by code, not by the model.</span> {ruleLabel("counterparty.payment_limit")}.
              </span>
            </p>
          </div>
        </PrintOnView>

        <figcaption className="mt-3 text-xs leading-relaxed text-ink-3">
          Two sample bills in shadow mode. The labels, checks and outcomes are the product&apos;s own; the payees and amounts are examples.
        </figcaption>
      </figure>
      {/* The samples' real counterpart: a decision the agent made and the payment it led to, further down the page. */}
      <p className="mt-1.5">
        <a
          href="#proof"
          data-cta="hero-proof"
          className="inline-flex min-h-6 items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-2 hover:underline"
        >
          See a real decision and its transaction
          <ArrowDown aria-hidden className="size-3.5" />
        </a>
      </p>
    </div>
  );
}
