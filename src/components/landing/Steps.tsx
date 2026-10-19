import { Check, FileText, Inbox, Sheet } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { Reveal } from "@/components/ui/Reveal";

/**
 * How it works, in three steps a business owner can follow (docs/superpowers/specs/2026-10-11-landing-clarity-design.md
 * S1): add bills, see the agent's decision, agree and then let it pay. Shadow mode separates the first two from the
 * third, so the section says so in its title. Each step carries a small drawing of what it looks like; the drawings
 * are decoration, and the words say everything.
 */
const STEPS: ReadonlyArray<{ title: string; body: string; picture: ReactNode }> = [
  {
    title: "Add your bills",
    body: "Type a bill in, drop in the PDF, import a list, or forward the email. Add the contractors and suppliers you pay.",
    picture: (
      <ul className="grid gap-1.5">
        {[
          { icon: FileText, label: "invoice-0412.pdf" },
          { icon: Inbox, label: "Forwarded by email" },
          { icon: Sheet, label: "bills-october.csv" },
        ].map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[0.6875rem] text-ink-2 shadow-surface">
            <Icon className="size-3.5 shrink-0 text-agent" />
            {label}
          </li>
        ))}
      </ul>
    ),
  },
  {
    title: "See what the agent decides",
    body: "For each bill: pay now, pay on a later day, hold it for a person, or ask for what's missing. Every decision comes with its reason and the checks it passed.",
    picture: (
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="proof" size="sm">
          Pay now
        </Badge>
        <Badge size="sm">Pay on the due date</Badge>
        <Badge tone="held" size="sm">
          Held for you
        </Badge>
        <Badge tone="agent" size="sm">
          Needs a purchase order
        </Badge>
      </div>
    ),
  },
  {
    title: "Agree, then let it pay",
    body: "In shadow mode you agree or disagree with each decision and keep paying as you do today. Once you trust it, it pays in USDC within the limits you set, and holds the rest for you.",
    picture: (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex h-7 items-center focus-inverse rounded-lg bg-agent px-2.5 font-semibold text-on-agent">Agree</span>
        <span className="inline-flex h-7 items-center rounded-lg border border-line-strong bg-surface px-2.5 font-medium text-ink">Disagree</span>
        <span className="inline-flex items-center gap-1 font-medium text-proof">
          <Check className="size-3.5" strokeWidth={3} />
          Paid within your limits
        </span>
      </div>
    ),
  },
];

export function Steps() {
  return (
    <Section id="how-it-works" tone="surface" aria-labelledby="how-it-works-title" className="scroll-mt-16 border-b border-line">
        <Reveal>
          <div className="max-w-3xl">
            <Eyebrow className="text-agent">How it works</Eyebrow>
            <Heading id="how-it-works-title" className="mt-3 max-w-4xl text-balance">
              Evaluate first. <span className="font-serif font-normal italic text-agent">Turn on payments later.</span>
            </Heading>
            <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
              The first two steps need no wallet and no money. Most teams start in shadow mode, beside the way they pay today, and let the agent
              pay once its decisions match their own.
            </p>
          </div>
        </Reveal>
        <Reveal delay={60} className="mt-10">
          <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex min-w-0 flex-col rounded-2xl border border-line bg-ground/60 p-5 sm:p-6">
                <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-agent">Step {index + 1}</span>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">{step.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{step.body}</p>
                {/* Decoration: on a phone the words carry each step alone, so the section stays short. */}
                <div aria-hidden className="mt-auto hidden pt-5 sm:block">
                  {step.picture}
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
    </Section>
  );
}
