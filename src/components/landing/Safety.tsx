import { ArrowRight, ArrowUpRight, FileSignature, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { Reveal } from "@/components/ui/Reveal";
import { utcMinute } from "@/lib/copy";
import { SAFETY_EXAMPLE } from "./safety-example";

/**
 * Safety and control, in plain words (docs/superpowers/specs/2026-10-11-landing-clarity-design.md S2): the boundary
 * between what the model proposes and what may happen. Three principles, each saying what holds it (your team, rules in
 * Vestiarion's code and, on Arc mainnet, a contract, the signed ledger), then one real refusal step by step. The page's
 * one dark section; the full loop is on /how-it-decides, and the proof that follows shows what has actually been paid.
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

/** Each step's colour, kept low on the dark ground: neutral for the proposal, amber for the rule, red for the hold. */
const STEP_TONE: Record<(typeof SAFETY_EXAMPLE.steps)[number]["tone"], { box: string; kind: string }> = {
  agent: { box: "border-ground/15 bg-ground/[0.04]", kind: "text-agent-line" },
  held: { box: "border-held-line/40 bg-held/10", kind: "text-held-line" },
  refused: { box: "border-refused-line/45 bg-refused/10", kind: "text-refused-line" },
};

function Principle({ title, lede, icon: Icon, by, points }: PrincipleItem) {
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-ground/12 bg-ground/[0.03] p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-agent-line/35 bg-agent/15 text-agent-line">
          <Icon className="size-[1.125rem]" />
        </span>
        <p className="font-mono text-[0.6875rem] uppercase leading-snug tracking-[0.08em] text-ground/60">{by}</p>
      </div>
      <h3 className="mt-4 text-xl font-semibold tracking-tight text-surface">{title}</h3>
      <p className="mt-1.5 text-pretty text-[0.9375rem] leading-relaxed text-ground/80">{lede}</p>
      <ul className="mt-4 grid gap-2.5 border-t border-ground/12 pt-4">
        {points.map((point) => (
          <li key={point} className="flex gap-2.5 text-pretty text-sm leading-relaxed text-ground/75">
            <span aria-hidden className="mt-[0.5625rem] size-1 shrink-0 rounded-full bg-agent-line/70" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </article>
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
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ground/60">
          {`A real decision · ${e.network.label} · shadow mode · our demo workspace · `}
          <time dateTime={e.at} className="normal-case tracking-normal">
            {utcMinute(e.at)}
          </time>
        </p>
      </div>
      <ol className="mt-5 grid gap-3 md:grid-cols-3 md:gap-4">
        {e.steps.map((step, index) => (
          <li key={step.kind} className="relative min-w-0">
            <div className={cn("h-full rounded-xl border p-4", STEP_TONE[step.tone].box)}>
              <p className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", STEP_TONE[step.tone].kind)}>
                {index + 1} · {step.kind}
              </p>
              <p className="mt-2 text-pretty text-[0.9375rem] font-semibold leading-snug text-surface">{step.title}</p>
              <p className="mt-1.5 text-pretty text-sm leading-relaxed text-ground/75">
                {step.detail}
                {"rule" in step && (
                  <>
                    {" "}
                    <code className="whitespace-nowrap rounded-md border border-held-line/40 bg-held/15 px-1.5 py-0.5 font-mono text-xs text-held-line">
                      {step.rule}
                    </code>
                  </>
                )}
              </p>
            </div>
            {/* The arrow between steps, on a screen wide enough to set them in a row. */}
            {index < e.steps.length - 1 && (
              <ArrowRight aria-hidden className="absolute -right-[0.875rem] top-1/2 z-10 hidden size-4 -translate-y-1/2 text-ground/45 md:block" />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-pretty text-sm leading-relaxed text-ground/65">
        {`Signed as ledger entry #${e.entry} in that workspace. The limit moves only when an owner or admin changes it, never because of what a bill or the model says.`}
      </p>
    </section>
  );
}

export function Safety() {
  return (
    // focus-inverse: an agent-blue focus ring would barely show on the dark ground, so rings here are white.
    <section id="safety" aria-labelledby="safety-title" className="focus-inverse relative scroll-mt-16 bg-ink text-ground">
      <div aria-hidden className="ledger-grid-dark absolute inset-0" />
      <div aria-hidden className="absolute inset-x-0 top-0 h-[32rem] overflow-hidden">
        <div className="absolute -top-48 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-agent/20 blur-3xl" />
      </div>
      <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <Reveal>
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-agent-line">Safety and control</p>
          <h2 id="safety-title" className="mt-4 max-w-4xl text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.045em] text-surface sm:text-6xl">
            The AI suggests. <span className="font-serif font-normal italic text-agent-line">Your rules decide.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-ground/80">
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

        <div className="mt-8 flex flex-col items-start gap-x-8 border-t border-ground/15 pt-5 text-[0.9375rem] sm:mt-10 sm:flex-row sm:flex-wrap sm:items-center">
          <Link
            href="/docs/guides/controls"
            className="inline-flex min-h-11 items-center gap-1 font-semibold text-agent-line underline-offset-4 hover:underline"
          >
            Explore all safety controls
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/how-it-decides"
            className="inline-flex min-h-11 items-center gap-1 font-medium text-ground/80 underline-offset-4 hover:text-agent-line hover:underline"
          >
            How a decision is made, step by step
            <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/docs/research/model-vs-policy"
            className="inline-flex min-h-11 items-center gap-1 font-medium text-ground/80 underline-offset-4 hover:text-agent-line hover:underline"
          >
            When the model and the policy disagree
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
