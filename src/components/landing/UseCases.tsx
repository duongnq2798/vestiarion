"use client";

import { ArrowRight, CalendarClock, Check, ShieldCheck, ShieldX, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { landingPrefetch } from "./prefetch";
import { useTabGlide } from "./tab-glide";

/**
 * Who it is for, one kind of team at a time (docs/superpowers/specs/2026-10-11-landing-clarity-design.md U1): a bill
 * that team knows, what Vestiarion does with it, and the decision it ends with, drawn as the agent's decision rather
 * than a receipt (docs/superpowers/specs/2026-10-16-landing-use-case-decisions-design.md): what it checked, each check
 * passed or failed, and what it decided and why. Every step and check is something the agent or the product does
 * today, and each case links to the guide that says how. The payees and amounts are examples. Every panel is in the
 * page's HTML; only the chosen one shows.
 */

/** How a decision ended: paid, held for a person, or set for a later day. */
type Outcome = "proof" | "held" | "neutral";
export interface UseCase {
  id: string;
  tab: string;
  situation: string;
  steps: [string, string, string];
  guide: { href: string; label: string };
  decision: {
    payee: string;
    what: string;
    amount: string;
    tone: Outcome;
    label: string;
    /** What the agent checked, in a person's words; a check that failed is the reason it did not pay. */
    checks: ReadonlyArray<{ text: string; passed: boolean }>;
    reason: string;
  };
}

export const USE_CASES: readonly UseCase[] = [
  {
    id: "agencies",
    tab: "Software agencies",
    situation: "A contractor invoices for a milestone: the checkout flow.",
    steps: [
      "Checks the work was delivered: its pull request merged on GitHub, or someone on your team marked it approved.",
      "Compares the amount with the milestone you agreed, and makes sure it was not paid before.",
      "Pays the contractor in USDC once it all holds. Someone new gets a link to say where they want to be paid.",
    ],
    guide: { href: "/docs/guides/pay-a-contractor", label: "How contractor payments work" },
    decision: {
      payee: "Northwind Dev",
      what: "Milestone 2 of 3 · checkout flow",
      amount: "2,400.00",
      tone: "proof",
      label: "Paid",
      checks: [
        { text: "Pull request merged on GitHub", passed: true },
        { text: "Amount matches the milestone", passed: true },
        { text: "Not paid before", passed: true },
        { text: "Within the contractor's limit", passed: true },
      ],
      reason: "Every check passed, so the agent paid it in USDC, within the limits you set.",
    },
  },
  {
    id: "studios",
    tab: "Creative studios",
    situation: "A freelance designer sends the invoice for a campaign's assets.",
    steps: [
      "Matches it to the amount you agreed, and checks someone on your team approved the work.",
      "Holds it for a person when it is above that freelancer's limit, or when their payment address changed.",
      "Keeps a signed record of who approved what and when, so month end is not a hunt through chat threads.",
    ],
    guide: { href: "/studios", label: "Vestiarion for studios" },
    decision: {
      payee: "Kestrel Design",
      what: "Campaign assets · October",
      amount: "6,500.00",
      tone: "held",
      label: "Held for you",
      checks: [
        { text: "Amount matches the fee you agreed", passed: true },
        { text: "Work approved by your team", passed: true },
        { text: "Above the freelancer's 5,000 USDC limit", passed: false },
      ],
      reason: "Blocked by code, not by the model. A person decides it in Approvals.",
    },
  },
  {
    id: "devops",
    tab: "Cloud & DevOps",
    situation: "Your hosting provider's monthly invoice arrives.",
    steps: [
      "Checks it against the purchase order, and that the service was received.",
      "Flags a bill that repeats one you already paid.",
      "Picks the day to pay: the last day of an early-payment discount, or the due date, never later.",
    ],
    guide: { href: "/docs/guides/first-payment#5-when-the-agent-pays", label: "When the agent pays" },
    decision: {
      payee: "Halcyon Hosting",
      what: "Servers · October",
      amount: "1,180.00",
      tone: "neutral",
      label: "Scheduled",
      checks: [
        { text: "Matches purchase order PO-2210", passed: true },
        { text: "Service received", passed: true },
        { text: "Not a repeat of a bill already paid", passed: true },
      ],
      reason: "Set to pay on the discount's last day, to take 2% off, and never after the due date.",
    },
  },
  {
    id: "web3",
    tab: "Web3 studios",
    situation: "A contributor's pull request with a bounty on it is merged.",
    steps: [
      "You attach the bounty with a comment on the pull request: /bounty 250.",
      "Once it is merged, the agent pays its author in USDC, within your daily limit.",
      "The payment's transaction is posted on the pull request, for anyone to check.",
    ],
    guide: { href: "/docs/guides/github#3-attach-a-bounty-from-a-comment", label: "Bounties from GitHub" },
    decision: {
      payee: "mira-dev",
      what: "Bounty on pull request 184",
      amount: "250.00",
      tone: "proof",
      label: "Paid",
      checks: [
        { text: "Bounty attached: /bounty 250", passed: true },
        { text: "Pull request 184 merged", passed: true },
        { text: "Within your daily limit", passed: true },
      ],
      reason: "Paid to its author in USDC. The transaction is posted on the pull request.",
    },
  },
];

/** The other kinds of payment the agent handles, each with the guide that says how. */
const ALSO = [
  { href: "/docs/guides/first-payment#pay-something-every-period", label: "Retainers and subscriptions" },
  { href: "/docs/guides/first-payment#invoices-in-eurc", label: "Bills in EURC" },
  { href: "/docs/guides/first-payment#pay-a-payee-on-another-chain", label: "Payees on other chains" },
  { href: "/docs/guides/get-paid", label: "Getting paid by clients" },
] as const;

/** The decision's band: its tint and the mark beside why it ended as it did. */
const BAND: Record<Outcome, { tint: string; icon: LucideIcon; mark: string }> = {
  proof: { tint: "bg-proof-soft/60", icon: ShieldCheck, mark: "text-proof" },
  held: { tint: "bg-held-soft/60", icon: ShieldX, mark: "text-held" },
  neutral: { tint: "bg-ground/80", icon: CalendarClock, mark: "text-ink-2" },
};

/** The agent's decision on the case's bill: who and how much, what it checked, and what it decided and why. */
function Decision({ decision }: { decision: UseCase["decision"] }) {
  const band = BAND[decision.tone];
  const BandIcon = band.icon;
  return (
    <div role="group" aria-label={`Example decision: ${decision.payee}`} className="rounded-2xl border border-line bg-surface p-4 shadow-surface sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>Example decision</Eyebrow>
        <Badge tone={decision.tone} size="sm">
          {decision.label}
        </Badge>
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={decision.payee} tone="agent" shape="square" size="lg" />
          <div className="min-w-0">
            <p className="truncate text-[0.9375rem] font-semibold text-ink">{decision.payee}</p>
            <p className="text-[0.8125rem] leading-snug text-ink-3">{decision.what}</p>
          </div>
        </div>
        <p className="flex shrink-0 items-baseline gap-1 font-mono text-base font-semibold text-ink tabular-nums">
          {decision.amount}
          <span className="text-xs font-medium text-ink-3">USDC</span>
        </p>
      </div>

      <div className="mt-4 border-t border-line pt-3.5">
        <Eyebrow>What the agent checked</Eyebrow>
        <ul className="mt-2 grid gap-1.5">
          {decision.checks.map((check) => (
            <li key={check.text} className="flex items-start gap-2 text-[0.8125rem] leading-snug text-ink-2">
              {check.passed ? (
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-proof" strokeWidth={3} />
              ) : (
                <X aria-hidden className="mt-0.5 size-3.5 shrink-0 text-held" strokeWidth={3} />
              )}
              <span className={check.passed ? undefined : "font-medium text-ink"}>
                {check.text}
                <span className="sr-only">{check.passed ? ": passed" : ": failed"}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className={cn("mt-3.5 flex items-start gap-2 rounded-lg px-3 py-2.5", band.tint)}>
        <BandIcon aria-hidden className={cn("mt-0.5 size-4 shrink-0", band.mark)} />
        <p className="text-[0.8125rem] leading-snug text-ink-2">
          <span className="font-semibold text-ink">Decision: </span>
          {decision.reason}
        </p>
      </div>

      <Link href="/how-it-decides" className="mt-3 inline-flex min-h-6 items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-4 hover:underline">
        How the agent decides
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}

export function UseCases() {
  const { root: glideRoot, onValueChange: glideFrom } = useTabGlide();
  return (
    <section id="who-its-for" aria-labelledby="who-its-for-title" className="scroll-mt-16 border-b border-line">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-3xl">
          <Eyebrow className="text-agent">Who it&apos;s for</Eyebrow>
          <h2 id="who-its-for-title" className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-5xl">
            For small businesses that pay people for their work.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
            If you pay contractors, freelancers or suppliers and check each invoice by hand, the agent does the checking and shows its work.
          </p>
        </div>

        <Tabs ref={glideRoot} defaultValue={USE_CASES[0].id} onValueChange={glideFrom} className="mt-8 gap-6">
          <TabsList aria-label="Kinds of team" className="grid h-auto grid-cols-2 gap-1 sm:flex sm:h-10">
            {USE_CASES.map((useCase) => (
              <TabsTrigger key={useCase.id} value={useCase.id} className="h-9 px-2 sm:h-auto sm:px-3">
                {useCase.tab}
              </TabsTrigger>
            ))}
          </TabsList>
          {USE_CASES.map((useCase) => (
            <TabsContent key={useCase.id} value={useCase.id} forceMount className="min-w-0 data-[state=inactive]:hidden">
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center lg:gap-12">
                <div className="min-w-0">
                  <p className="text-pretty font-serif text-2xl leading-snug text-ink sm:text-3xl">{useCase.situation}</p>
                  <ol className="mt-5 grid gap-3">
                    {useCase.steps.map((step) => (
                      <li key={step} className="flex items-start gap-3 text-[0.9375rem] leading-relaxed text-ink-2">
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-proof-line bg-proof-soft">
                          <Check aria-hidden className="size-3 text-proof" strokeWidth={3} />
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <Link
                    href={useCase.guide.href}
                    prefetch={landingPrefetch(useCase.guide.href)}
                    className="mt-5 inline-flex min-h-6 items-center gap-1 text-[0.9375rem] font-medium text-agent underline-offset-4 hover:underline"
                  >
                    {useCase.guide.label}
                    <ArrowRight aria-hidden className="size-4" />
                  </Link>
                </div>
                <Decision decision={useCase.decision} />
              </div>
            </TabsContent>
          ))}
        </Tabs>

        <p className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5 text-sm text-ink-2">
          <span className="font-medium text-ink">It also handles</span>
          {ALSO.map((item) => (
            <Link key={item.href} href={item.href} prefetch={landingPrefetch(item.href)} className="inline-flex min-h-6 items-center text-agent underline-offset-4 hover:underline">
              {item.label}
            </Link>
          ))}
        </p>
        <p className="mt-2 text-xs text-ink-3">Payees and amounts are examples. The steps are what the agent does today.</p>
      </div>
    </section>
  );
}
