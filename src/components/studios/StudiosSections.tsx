import { ArrowRight, FileText, Scale, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatFigure } from "@/components/open/OpenNumbersTable";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import type { NetworkProfile } from "@/lib/network";
import type { OpenNumbers } from "@/lib/platform/open-numbers";

/**
 * The sections of /studios, the page for small studios that pay outside contractors per deliverable. Each says only
 * what the code does today; the one figure, how often code refused the agent, is read live from the open numbers by
 * the page and passed in, one network at a time, never added across them.
 */

/**
 * The one call to action: sign in, then open a workspace with shadow mode ticked (`?shadow=1`). A signed-out visitor
 * is sent by the proxy to `/login?next=%2Fonboarding%3Fshadow%3D1` and comes back here after the link; a signed-in one
 * goes straight on, which a link to /login itself would not do, since the sign-in page never skips its form.
 */
export const REVIEW_HREF = "/onboarding?shadow=1";
export const REVIEW_LABEL = "Review your first invoice";
export const GUIDED_SETUP_ID = "guided-setup";

const sectionClass = "mx-auto max-w-6xl scroll-mt-16 px-4 py-14 sm:px-6 sm:py-20";
const linkClass = "font-medium text-agent underline-offset-4 hover:underline";

function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-3xl">
      <Eyebrow className="text-xs">{eyebrow}</Eyebrow>
      <h2 id={id} className="mt-3 text-balance text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        {title}
      </h2>
      {children && <div className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

export function StudiosHero() {
  return (
    <section aria-labelledby="studios-hero-title" className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[24rem] rounded-full bg-proof-soft/70 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[26rem] rounded-full bg-agent-soft/70 blur-3xl motion-safe:animate-drift" />
      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:py-24">
        <div className="max-w-3xl">
          <Eyebrow className="text-agent">For studios that pay contractors per deliverable.</Eyebrow>
          <h1 id="studios-hero-title" className="mt-5 text-balance text-4xl font-semibold leading-[1] tracking-[-0.05em] text-ink sm:text-6xl">
            Check every contractor invoice before you pay it.
          </h1>
          <p className="mt-6 max-w-2xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-2xl">
            An agent compares each invoice with what you agreed and what was delivered, then says pay, wait or stop — and why. You approve. In shadow mode,
            nothing is paid from your accounts.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button asChild size="lg">
              <Link href={REVIEW_HREF}>{REVIEW_LABEL}</Link>
            </Button>
            <a href={`#${GUIDED_SETUP_ID}`} className={`text-[0.9375rem] ${linkClass}`}>
              Prefer a guided setup? Ask for one
            </a>
          </div>
          <p className="mt-3 text-[0.8125rem] text-ink-3">
            Email sign-in, then a workspace of your own with shadow mode on.{" "}
            <Link href="/docs/guides/shadow-mode" className={linkClass}>
              How shadow mode works
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

export function Problem() {
  return (
    <section aria-labelledby="studios-problem-title" className={sectionClass}>
      <Reveal>
        <SectionHead id="studios-problem-title" eyebrow="The problem" title="Every invoice, checked by hand.">
          <p>
            Each contractor invoice gets checked by hand against the brief, the delivery, the amount, and whether it was already paid. At month end they
            land together. Later, nobody can say why something was paid.
          </p>
        </SectionHead>
      </Reveal>
    </section>
  );
}

const STEPS: ReadonlyArray<{ title: string; icon: typeof FileText; body: ReactNode }> = [
  {
    title: "Add an invoice",
    icon: FileText,
    body: "Type it, upload the PDF, import a CSV, or forward it by email or Telegram.",
  },
  {
    title: "The agent decides",
    icon: Scale,
    body: "Pay now, schedule, hold, or ask for what's missing, with the reason in plain words.",
  },
  {
    title: "You agree or disagree",
    icon: ShieldCheck,
    body: "Your call is recorded. In shadow mode you keep paying the way you do today.",
  },
];

export function Steps() {
  return (
    <section aria-labelledby="studios-how-title" className="border-y border-line bg-surface">
      <div className={sectionClass}>
        <Reveal>
          <SectionHead id="studios-how-title" eyebrow="How it works" title="Three steps for each invoice." />
          <ol className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex min-w-0 flex-col bg-surface px-5 py-6 sm:px-6">
                <span className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-agent">
                  <step.icon aria-hidden className="size-4" />
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 text-xl font-semibold tracking-tight text-ink">{step.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

/** One network's open numbers, or null when they could not be read. */
export interface NetworkRefusals {
  profile: NetworkProfile;
  numbers: OpenNumbers | null;
}

const times = (count: number) => `${formatFigure(count, "count")} ${count === 1 ? "time" : "times"}`;

/** How often code refused the agent on one network, all time: every workspace's, with customers' apart. */
function refusalLine({ profile, numbers }: NetworkRefusals & { numbers: OpenNumbers }): string {
  const { total, customers } = numbers.sides;
  if (total.refusedByCode === 0) return `${profile.label}: code has not had to refuse the agent yet.`;
  return `${profile.label}: code refused the agent ${times(total.refusedByCode)}, ${formatFigure(customers.refusedByCode, "count")} of them in customers' workspaces.`;
}

/**
 * The trust block. `refusals` are the open numbers the page read, one network each; a network that could not be read
 * is left out, and with none read the sentence about the count is not drawn at all.
 */
export function Trust({ refusals }: { refusals: NetworkRefusals[] }) {
  const read = refusals.filter((entry): entry is NetworkRefusals & { numbers: OpenNumbers } => entry.numbers !== null);
  return (
    <section aria-labelledby="studios-trust-title" className={sectionClass}>
      <Reveal>
        <SectionHead id="studios-trust-title" eyebrow="Trust" title="You stay the one who approves." />
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {[
            "No money of yours moves in shadow mode.",
            "Your contractors don't need wallets.",
            "Rules in code refuse a payment the agent wants when it breaks one of your rules.",
            "Every decision is a signed record you can verify in your browser.",
          ].map((promise) => (
            <li key={promise} className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-5 py-4 text-[0.9375rem] leading-relaxed text-ink">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
              <span>{promise}</span>
            </li>
          ))}
        </ul>
        {read.length > 0 && (
          <div className="mt-6 rounded-2xl border border-line bg-ground/60 px-5 py-4 text-sm leading-6 text-ink-2">
            <p className="font-medium text-ink">How often code refused the agent, read live from the open numbers:</p>
            <ul className="mt-2 space-y-1">
              {read.map((entry) => (
                <li key={entry.profile.id}>{refusalLine(entry)}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              All time, across every workspace, the team&apos;s own included, with customers&apos; counted apart. Each network is counted on its own.{" "}
              <Link href="/open" className={linkClass}>
                Open numbers
              </Link>
            </p>
          </div>
        )}
        <p className="mt-6 text-sm text-ink-2">
          What we store and who sees it:{" "}
          <Link href="/privacy" className={linkClass}>
            Privacy
          </Link>
        </p>
      </Reveal>
    </section>
  );
}

export const FAQ: ReadonlyArray<{ question: string; answer: ReactNode }> = [
  {
    question: "Why would I trust an AI with payments?",
    answer:
      "You don't have to, to start. In shadow mode it pays nothing from your accounts: it proposes, and you agree or disagree. In a live workspace it pays only what passes the rules in code you set, holds the rest for a person, and signs every decision.",
  },
  {
    question: "Will it move my money automatically?",
    answer: (
      <>
        Not in shadow mode: you keep paying the way you do today. In a live workspace it pays only within the limits you set, holds a first payment to a new
        address until a second person stands behind it, and <strong>Pause agent</strong> stops it at any time.
      </>
    ),
  },
  {
    question: "Do I need USDC?",
    answer: "No. Shadow mode works beside how you pay today. USDC on Arc matters only if you later want the agent to pay a share of your bills itself.",
  },
  {
    question: "What if the AI is wrong?",
    answer:
      "You disagree and write why, and that invoice is not paid. Your agreement rate is shown, so you can judge the agent on your own invoices. Code also refuses decisions that break your rules; the count is read live above.",
  },
  {
    question: "Do my contractors need wallets?",
    answer:
      "No, and they install nothing. In shadow mode, on Arc testnet, a contractor without an Arc address can be given a mirror address: a wallet Vestiarion makes for them in your workspace.",
  },
  {
    question: "Is it production-ready?",
    answer: (
      <>
        It runs in production today: shadow mode on Arc testnet, and on Arc mainnet the agent pays real bills in USDC from a wallet you hold, within the
        spending limits you set. <Link href="/open" className={linkClass}>Open numbers</Link> shows what has run on each network, customers counted apart
        from the team. Your signed record exports as JSON that verifies without us; the CSV export is for spreadsheets and is not signed.
      </>
    ),
  },
];

export function Faq() {
  return (
    <section aria-labelledby="studios-faq-title" className="border-y border-line bg-surface">
      <div className={sectionClass}>
        <Reveal>
          <SectionHead id="studios-faq-title" eyebrow="Questions" title="What studios ask first." />
          <dl className="mt-8 grid gap-x-10 gap-y-7 md:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.question} className="min-w-0">
                <dt className="text-base font-semibold text-ink">{item.question}</dt>
                <dd className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}

export function GuidedSetup({ children }: { children: ReactNode }) {
  return (
    <section id={GUIDED_SETUP_ID} aria-labelledby="studios-guided-title" className={sectionClass}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-14">
        <SectionHead id="studios-guided-title" eyebrow="Guided setup" title="Prefer to set it up together?">
          <p>
            Tell us a little about your studio and we&apos;ll set up a call. Bring one recent contractor invoice: we set up shadow mode with you, you see what
            the agent decides and why, and your contractors don&apos;t need to do anything.
          </p>
        </SectionHead>
        <div className="relative min-w-0">{children}</div>
      </div>
    </section>
  );
}

export function StudiosFinalCta() {
  return (
    <section aria-labelledby="studios-final-title" className="focus-inverse border-t border-agent bg-agent text-on-agent">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 sm:px-6 sm:py-20 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <h2 id="studios-final-title" className="text-balance text-3xl font-semibold tracking-[-0.045em] text-on-agent sm:text-5xl">
            Try it on one invoice you already have.
          </h2>
          <p className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-on-agent/85">
            If the agent&apos;s reasons don&apos;t save you time or catch anything, it isn&apos;t worth switching.
          </p>
        </div>
        <Button asChild size="lg" variant="inverse" className="self-start lg:self-auto">
          <Link href={REVIEW_HREF}>
            {REVIEW_LABEL}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </section>
  );
}
