import { ArrowRight, ArrowUpRight, FileSignature, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { Reveal } from "@/components/ui/Reveal";
import { shortHash } from "@/components/vx/Primitives";
import { utcDay, utcMinute } from "@/lib/copy";
import { txUrl } from "@/lib/payee-chains";
import { COOLING_HOURS_CHOICES } from "@/lib/payee-lock-rules";
import { GITHUB_URL } from "@/lib/site-links";
import { PAYEE_LOCK_EXAMPLE } from "./payee-lock-example";
import { landingPrefetch } from "./prefetch";
import { SAFETY_EXAMPLE } from "./safety-example";

/**
 * Safety and control, in plain words (docs/superpowers/specs/2026-10-11-landing-clarity-design.md S2): the boundary
 * between what the model proposes and what may happen. Three principles, each saying what holds it (your team, rules in
 * Vestiarion's code and, on Arc mainnet, a contract, the signed ledger), then two real cases step by step: a refusal,
 * and the payee lock holding a changed address until its payment settled on Arc (2026-10-26-landing-payee-lock-design.md
 * PLL1). The page's one dark section; the full loop is on /how-it-decides, and the proof that follows shows what has
 * actually been paid.
 */

interface PrincipleItem {
  title: string;
  lede: string;
  icon: LucideIcon;
  /** What holds the principle: the people in the workspace, the product's code and a contract on Arc, or the ledger. */
  by: string;
  points: ReadonlyArray<string>;
}

export const PRINCIPLES: ReadonlyArray<PrincipleItem> = [
  {
    title: "You set the rules",
    lede: "Your team controls spending limits, permissions and approval requirements.",
    icon: SlidersHorizontal,
    by: "Set by your team",
    points: [
      "Limits per payee, per day and per 7 days on what the agent pays on its own.",
      "Owners, admins and approvers decide what the rules hold. Whoever entered a bill approves it only if no one else can.",
      "Two approvals above a figure you choose, 100 USDC by default on Arc mainnet. Pause agent stops its cycles and payments at once.",
    ],
  },
  {
    title: "Code enforces them",
    lede: "Every payment must pass deterministic checks before execution, whatever the model proposed.",
    icon: ShieldCheck,
    by: "Enforced by code, and on Arc mainnet by a contract",
    points: [
      "Three-way match, screening, duplicates and every limit, checked before anything is signed or sent.",
      "A first payment to a new address waits for a second person. The model cannot override a rule.",
      "On Arc mainnet it pays from your wallet only through a spending-limit contract that wallet deploys. Vestiarion never holds your USDC.",
    ],
  },
  {
    title: "Every action is recorded",
    lede: "Decisions, approvals, holds and payments leave a traceable record.",
    icon: FileSignature,
    by: "Kept in the signed ledger",
    points: [
      "Each entry is signed and linked to the one before, with the facts and reasons behind it.",
      "A refusal is kept with the rule that made it, beside what the model argued.",
      "Anyone in the workspace can verify the chain in the browser, or an export offline.",
    ],
  },
];

type StepTone = (typeof SAFETY_EXAMPLE.steps)[number]["tone"] | (typeof PAYEE_LOCK_EXAMPLE.steps)[number]["tone"];

/**
 * Each step's colour, kept low on the dark ground: neutral for a proposal or an event, amber for a rule or a hold, red
 * for a refusal, green for a payment that settled (landing payee lock PLL3). Each label reads at 4.5:1 on its own tint
 * (tests/ui-tokens.test.ts reads this table, one tone a line).
 */
const STEP_TONE: Record<StepTone, { box: string; kind: string }> = {
  agent: { box: "border-ground/15 bg-ground/[0.04]", kind: "text-agent-line" },
  held: { box: "border-held-line/40 bg-held/10", kind: "text-held-line" },
  refused: { box: "border-refused-line/45 bg-refused/10", kind: "text-refused-line" },
  paid: { box: "border-proof-line/40 bg-proof/10", kind: "text-proof-line" },
};

/** An instant's time of day in UTC, to the second: "15:16:07 UTC". The day is in the case's label. */
function utcClock(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 19)} UTC`;
}

/** The waits an owner can choose after an address changes, in words: "4, 24, 48 or 72 hours". */
const WAITS = COOLING_HOURS_CHOICES.filter((hours) => hours > 0);
const WAIT_WORDS = `${WAITS.slice(0, -1).join(", ")} or ${WAITS[WAITS.length - 1]} hours`;

function Principle({ title, lede, icon: Icon, by, points }: PrincipleItem) {
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-ground/12 bg-ground/[0.03] p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-agent-line/35 bg-agent/15 text-agent-line">
          <Icon className="size-[1.125rem]" />
        </span>
        <p className="font-mono text-[0.6875rem] uppercase leading-snug tracking-[0.08em] text-on-agent-muted">{by}</p>
      </div>
      <h3 className="mt-4 text-xl font-semibold tracking-tight text-surface">{title}</h3>
      <p className="mt-1.5 text-pretty text-[0.9375rem] leading-relaxed text-on-agent-muted">{lede}</p>
      <ul className="mt-4 grid gap-2.5 border-t border-ground/12 pt-4">
        {points.map((point) => (
          <li key={point} className="flex gap-2.5 text-pretty text-sm leading-relaxed text-on-agent-muted">
            <span aria-hidden className="mt-[0.5625rem] size-1 shrink-0 rounded-full bg-agent-line/70" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * Which case it is, on which network and in which mode, always in the team's own workspace (docs/design/visual-system.md,
 * evidence): each case names its own mode, since only the refusal's workspace runs in shadow mode (landing payee lock
 * PLL2). The time or day follows.
 */
function CaseLabel({ what, network, mode, children }: { what: string; network: string; mode: string; children: ReactNode }) {
  return (
    <p className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-on-agent-muted">
      {`${what} · ${network} · ${mode} · Vestiarion team workspace · `}
      {children}
    </p>
  );
}

/** A step's detail, then the id of the rule that held or refused it, as the ledger and the API name it. */
function StepDetail({ detail, rule }: { detail: string; rule?: string }) {
  return (
    <p className="mt-1.5 text-pretty text-sm leading-relaxed text-on-agent-muted">
      {detail}
      {rule && (
        <>
          {" "}
          <code className="whitespace-nowrap rounded-md border border-held-line/40 bg-held/15 px-1.5 py-0.5 font-mono text-xs text-held-line">
            {rule}
          </code>
        </>
      )}
    </p>
  );
}

/** One real refusal, step by step: what the agent proposed, the rule that stopped it, and that nothing was sent. */
function Example() {
  const e = SAFETY_EXAMPLE;
  return (
    <section aria-labelledby="safety-example-title" className="mt-8 rounded-2xl border border-ground/12 bg-ink/60 p-5 sm:mt-10 sm:p-7">
      <div className="flex flex-col gap-x-6 gap-y-2 lg:flex-row lg:items-baseline lg:justify-between">
        <h3 id="safety-example-title" className="text-xl font-semibold tracking-tight text-surface sm:text-2xl">
          What happens when a rule fails?
        </h3>
        <CaseLabel what="A historical team decision" network={e.network.label} mode={e.mode}>
          <time dateTime={e.at} className="normal-case tracking-normal">
            {utcMinute(e.at)}
          </time>
        </CaseLabel>
      </div>
      <ol className="mt-5 grid gap-3 md:grid-cols-3 md:gap-4">
        {e.steps.map((step, index) => (
          <li key={step.kind} className="relative min-w-0">
            <div className={cn("h-full rounded-xl border p-4", STEP_TONE[step.tone].box)}>
              <p className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", STEP_TONE[step.tone].kind)}>
                {index + 1} · {step.kind}
              </p>
              <p className="mt-2 text-pretty text-[0.9375rem] font-semibold leading-snug text-surface">{step.title}</p>
              <StepDetail detail={step.detail} rule={"rule" in step ? step.rule : undefined} />
            </div>
            {/* The arrow between steps, on a screen wide enough to set them in a row. */}
            {index < e.steps.length - 1 && (
              <ArrowRight aria-hidden className="absolute -right-[0.875rem] top-1/2 z-10 hidden size-4 -translate-y-1/2 text-ground/45 md:block" />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-pretty text-sm leading-relaxed text-on-agent-muted">
        {`Signed as ledger entry #${e.entry} in that workspace. The limit moves only when an owner or admin changes it, never because of what a bill or the model says.`}
        {" "}<a href={`${GITHUB_URL}/blob/main/src/components/landing/safety-example.ts`} target="_blank" rel="noopener noreferrer" className="font-semibold text-agent-line underline underline-offset-4">View the historical case source<span className="sr-only"> (opens in a new tab)</span></a>
      </p>
    </section>
  );
}

/**
 * The payee lock, by name, and one real payment it held (docs/superpowers/specs/2026-10-26-landing-payee-lock-design.md
 * PLL1-PLL6): what the lock does, set apart from what happened; the five steps at the times the ledger recorded them;
 * then the payment on Arc, with the chain's time told from the ledger's. The lock is held by code and people, so the
 * proof claims only what the transaction shows. Laid out in two columns on a wide screen, the steps on the right.
 */
function PayeeLockExample() {
  const e = PAYEE_LOCK_EXAMPLE;
  const paid = e.steps[e.steps.length - 1];
  const guide = "/docs/guides/first-payment#payee-lock";
  return (
    <section aria-labelledby="safety-payee-lock-title" className="mt-6 rounded-2xl border border-ground/12 bg-ink/60 p-5 sm:mt-8 sm:p-7">
      <div className="flex flex-col gap-x-6 gap-y-2 lg:flex-row lg:items-baseline lg:justify-between">
        <h3 id="safety-payee-lock-title" className="text-xl font-semibold tracking-tight text-surface sm:text-2xl">
          What happens when a payment address changes?
        </h3>
        <CaseLabel what="A historical team payment" network={e.network.label} mode={e.mode}>
          <time dateTime={e.day} className="normal-case tracking-normal">
            {utcDay(e.day)}
          </time>
        </CaseLabel>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-6">
        <div className="min-w-0">
          <p className="text-pretty text-[0.9375rem] leading-relaxed text-on-agent-muted">
            <strong className="font-semibold text-surface">The payee lock.</strong> With it on, a changed payment address is paid only after a person
            confirms it, recording how they checked it with the vendor, and after any wait you set. Whoever entered the address cannot confirm it while
            someone else can.
          </p>
          <p className="mt-3 text-pretty text-sm leading-relaxed text-on-agent-muted">
            {`An owner turns it on in Settings, with a wait of ${WAIT_WORDS}, or none. A workspace created on Arc mainnet starts with it on, with no wait.`}
          </p>
        </div>
        <ol className="grid min-w-0 gap-3 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {e.steps.map((step, index) => (
            <li key={step.entry} className={cn("min-w-0 rounded-xl border p-4", STEP_TONE[step.tone].box)}>
              <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-[0.6875rem]">
                <span className={cn("font-semibold uppercase tracking-[0.1em]", STEP_TONE[step.tone].kind)}>
                  {index + 1} · {step.kind}
                </span>
                <span className="tabular-nums text-on-agent-muted">
                  <time dateTime={step.at}>{utcClock(step.at)}</time>
                  {` · entry #${step.entry}`}
                </span>
              </p>
              <p className="mt-2 text-pretty text-[0.9375rem] font-semibold leading-snug text-surface">{step.title}</p>
              <StepDetail detail={step.detail} rule={"rule" in step ? step.rule : undefined} />
            </li>
          ))}
        </ol>
        <div className={cn("min-w-0 self-start rounded-xl border p-4", STEP_TONE.paid.box)}>
          <p className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", STEP_TONE.paid.kind)}>{`Proof on ${e.network.label}`}</p>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-on-agent-muted">
            {`${e.payment.amount} from the workspace's wallet to the confirmed address. `}
            <a
              href={txUrl(e.network.id, e.payment.hash)}
              title={e.payment.hash}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-proof-line underline underline-offset-4"
            >
              Transaction <span className="font-mono tabular-nums">{shortHash(e.payment.hash)}</span>
              <ArrowUpRight aria-hidden className="size-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
            <dt className="text-on-agent-muted">Block</dt>
            <dd className="text-surface">{e.payment.block}</dd>
            <dt className="text-on-agent-muted">Confirmed on chain</dt>
            <dd className="text-surface">
              <time dateTime={e.payment.confirmedAt}>{utcClock(e.payment.confirmedAt)}</time>
            </dd>
            <dt className="text-on-agent-muted">Recorded in the ledger</dt>
            <dd className="text-surface">
              <time dateTime={paid.at}>{utcClock(paid.at)}</time>
            </dd>
          </dl>
          <p className="mt-3 text-pretty text-sm leading-relaxed text-on-agent-muted">
            Vestiarion&apos;s code and your people hold the lock, not a contract. The transaction shows what followed: the payment settled only after both
            holds ended, to the confirmed address, for the bill&apos;s amount.
          </p>
        </div>
      </div>
      <p className="mt-4 text-pretty text-sm leading-relaxed text-on-agent-muted">
        {`Each time is when that workspace's signed ledger recorded the step. The lock was turned on at ${utcClock(e.lockOn.at)}, as entry #${e.lockOn.entry}. The refused confirmation is not a ledger entry.`}
        {" "}<a href={`${GITHUB_URL}/blob/main/src/components/landing/payee-lock-example.ts`} target="_blank" rel="noopener noreferrer" className="font-semibold text-agent-line underline underline-offset-4">View the payee lock case source<span className="sr-only"> (opens in a new tab)</span></a>
        {" · "}
        <Link href={guide} prefetch={landingPrefetch(guide)} className="font-semibold text-agent-line underline underline-offset-4">
          How the payee lock works
        </Link>
      </p>
    </section>
  );
}

export function Safety() {
  return (
    <Section id="safety" tone="ink" aria-labelledby="safety-title" className="scroll-mt-16">
        <Reveal>
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-agent-line">Safety and control</p>
          <Heading id="safety-title" className="mt-4 max-w-4xl text-balance">
            The AI suggests. <span className="font-serif font-normal italic text-agent-line">Your rules in code decide.</span>
          </Heading>
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-on-agent-muted">
            A model reads each bill and proposes what to do. Rules in code check every proposal before money moves, and can refuse it. In shadow mode nothing is
            paid until a person agrees; in a live workspace the agent pays on its own only what passes every check.
          </p>
        </Reveal>

        <Reveal delay={60} className="mt-10 grid grid-cols-1 gap-4 sm:mt-12 md:grid-cols-3 md:gap-5">
          {PRINCIPLES.map((principle) => (
            <Principle key={principle.title} {...principle} />
          ))}
        </Reveal>

        <Example />
        <PayeeLockExample />

        <div className="mt-8 flex flex-col items-start gap-x-8 border-t border-ground/15 pt-5 text-[0.9375rem] sm:mt-10 sm:flex-row sm:flex-wrap sm:items-center">
          <Link
            href="/docs/guides/controls"
            prefetch={false}
            className="inline-flex min-h-11 items-center gap-1 font-semibold text-agent-line underline-offset-4 hover:underline"
          >
            Explore all safety controls
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/how-it-decides"
            className="inline-flex min-h-11 items-center gap-1 font-medium text-on-agent-muted underline-offset-4 hover:text-agent-line hover:underline"
          >
            How a decision is made, step by step
            <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/docs/research/model-vs-policy"
            prefetch={false}
            className="inline-flex min-h-11 items-center gap-1 font-medium text-on-agent-muted underline-offset-4 hover:text-agent-line hover:underline"
          >
            When the model and the policy disagree
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
    </Section>
  );
}
