import { ArrowRight, Check, X } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { Reveal } from "@/components/ui/Reveal";
import { ruleLabel } from "@/lib/rule-words";

/**
 * Safety and control, in plain words (docs/superpowers/specs/2026-10-11-landing-clarity-design.md S2): the difference
 * between what the model proposes and what may happen, drawn as two bills that take the same first step and end apart,
 * then the questions a cautious owner asks, each answered as the product behaves and tagged with what enforces it. The
 * page's one dark section; the full loop, step by step, is on /how-it-decides.
 */

type Tone = "agent" | "proof" | "refused" | "plain";

interface Node {
  who: string;
  what: string;
  tone: Tone;
  mark?: "pass" | "fail";
}

const LANES: ReadonlyArray<{ label: string; nodes: Node[] }> = [
  {
    label: "A bill that passes",
    nodes: [
      { who: "The agent", what: "Proposes: pay it", tone: "agent" },
      { who: "Rules in code", what: "Every check passes", tone: "proof", mark: "pass" },
      { who: "Payment", what: "Paid in USDC on Arc", tone: "proof" },
      { who: "Record", what: "Signed into the ledger", tone: "plain" },
    ],
  },
  {
    label: "A bill that does not",
    nodes: [
      { who: "The agent", what: "Proposes: pay it", tone: "agent" },
      { who: "Rules in code", what: ruleLabel("counterparty.payment_limit"), tone: "refused", mark: "fail" },
      { who: "Payment", what: "Held for a person", tone: "refused" },
      { who: "Record", what: "Signed, with the reason", tone: "plain" },
    ],
  },
];

/** What enforces an answer: the product's code, a contract on Arc, or the people in the workspace. */
type Enforcer = "Rules in Vestiarion's code" | "A contract on Arc" | "Your team";

const QUESTIONS: ReadonlyArray<{ question: string; answer: string; by: Enforcer }> = [
  {
    question: "Can the AI pay without my say-so?",
    answer:
      "Only within what you allow. In shadow mode it pays nothing until a person agrees. In a live workspace it pays only bills that pass every check and fit the agent's spending limit, and holds the rest for you in Approvals.",
    by: "Rules in Vestiarion's code",
  },
  {
    question: "Who holds the money?",
    answer:
      "On Arc mainnet the treasury can be a wallet you hold, in your browser or with a passkey. The agent pays from it only through a contract your wallet deploys, capped per day and per 7 days, and Vestiarion never holds your USDC. You can connect your own Circle account instead.",
    by: "A contract on Arc",
  },
  {
    question: "What happens when a bill fails a check?",
    answer:
      "It is held, flagged as a likely duplicate, or sent back for what is missing, with the reason in plain words. A person decides it in Approvals, and the refusal is kept in the record.",
    by: "Rules in Vestiarion's code",
  },
  {
    question: "Who approves the big or unusual ones?",
    answer:
      "A first payment to a new address waits for a second person. Above a figure you choose, two people approve; on Arc mainnet that starts at 100 USDC. Each payee also has a limit of its own.",
    by: "Your team",
  },
  {
    question: "Can I stop it?",
    answer: "Yes. Pause agent stops every cycle and every payment at once, with a reason your whole team sees. People can still pay or reject from Approvals.",
    by: "Your team",
  },
  {
    question: "What if a payment fails?",
    answer:
      "Vestiarion never sends a second transfer while the first could still settle. If a payment has not confirmed 15 minutes after it was sent, your team is told, in the console and by email.",
    by: "Rules in Vestiarion's code",
  },
];

const NODE_TONE: Record<Tone, string> = {
  agent: "border-agent-line/60 bg-agent/15",
  proof: "border-proof-line/50 bg-proof/15",
  refused: "border-refused-line/55 bg-refused/15",
  plain: "border-ground/15 bg-ground/[0.05]",
};

const WHO_TONE: Record<Tone, string> = {
  agent: "text-agent-line",
  proof: "text-proof-line",
  refused: "text-refused-line",
  plain: "text-ground/70",
};

function Lane({ label, nodes }: { label: string; nodes: Node[] }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ground/70">{label}</p>
      <ol className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-[repeat(4,minmax(0,1fr))] md:gap-4">
        {nodes.map((node, index) => (
          <li key={node.who} className="relative min-w-0">
            <div className={cn("h-full min-w-0 rounded-xl border px-3 py-2.5 sm:px-3.5 sm:py-3", NODE_TONE[node.tone])}>
              <p className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", WHO_TONE[node.tone])}>{node.who}</p>
              <p className="mt-1 flex min-w-0 items-start gap-1.5 text-sm font-medium leading-snug text-surface sm:mt-1.5">
                {node.mark === "pass" && <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-proof-line" strokeWidth={3} />}
                {node.mark === "fail" && <X aria-hidden className="mt-0.5 size-3.5 shrink-0 text-refused-line" strokeWidth={3} />}
                <span>
                  {node.what}
                  {node.mark === "fail" && <span className="sr-only">: this check failed</span>}
                </span>
              </p>
            </div>
            {index < nodes.length - 1 && (
              <ArrowRight aria-hidden className="absolute -right-4 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-ground/45 md:block" />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Safety() {
  return (
    <section id="safety" aria-labelledby="safety-title" className="relative scroll-mt-16 bg-ink text-ground">
      <div aria-hidden className="ledger-grid-dark absolute inset-0" />
      <div aria-hidden className="absolute inset-x-0 top-0 h-[32rem] overflow-hidden">
        <div className="absolute -top-48 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-agent/20 blur-3xl" />
      </div>
      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-agent-line">Safety and control</p>
          <h2 id="safety-title" className="mt-4 max-w-4xl text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.045em] text-surface sm:text-6xl">
            The AI suggests. <span className="font-serif font-normal italic text-agent-line">Your rules decide.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-ground/80">
            A model reads each bill and proposes what to do. Before any money moves, rules in code check that proposal, and they can refuse it.
            Nothing the model writes can change them.
          </p>
        </Reveal>

        <Reveal delay={60} className="mt-10 grid grid-cols-1 gap-6 sm:mt-12">
          {LANES.map((lane) => (
            <Lane key={lane.label} label={lane.label} nodes={lane.nodes} />
          ))}
        </Reveal>

        <div className="mt-10 border-t border-ground/15 pt-8 sm:mt-16 sm:pt-10">
          <h3 className="text-2xl font-semibold tracking-tight text-surface sm:text-3xl">Who controls what</h3>
          <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 sm:mt-8 sm:gap-y-8 md:grid-cols-2 lg:grid-cols-3">
            {QUESTIONS.map((item) => (
              <div key={item.question} className="min-w-0">
                <dt className="text-base font-semibold text-surface">{item.question}</dt>
                <dd className="mt-2 text-[0.9375rem] leading-relaxed text-ground/80">{item.answer}</dd>
                <dd className="mt-3">
                  <span className="inline-flex rounded-full border border-ground/20 px-2.5 py-0.5 font-mono text-[0.6875rem] text-ground/75">
                    {item.by}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-ground/15 pt-6 text-[0.9375rem] sm:flex-row sm:flex-wrap sm:gap-x-8">
          <p className="text-ground/80">Every decision, payment and refusal is signed into a record your team can verify.</p>
          <Link href="/how-it-decides" className="inline-flex min-h-6 items-center gap-1 font-semibold text-agent-line underline-offset-4 hover:underline">
            How a decision is made, step by step
            <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link href="/docs/research/model-vs-policy" className="inline-flex min-h-6 items-center gap-1 font-semibold text-agent-line underline-offset-4 hover:underline">
            When the model and the rules disagreed
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
