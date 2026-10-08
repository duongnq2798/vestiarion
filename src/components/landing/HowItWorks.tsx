import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Reveal } from "@/components/ui/Reveal";
import { HashText, Seal } from "./evidence/Evidence";
import { DecisionPipeline } from "./pipeline/DecisionPipeline";

const DOMAINS = ["Compliance", "Payables", "Contractors", "Treasury", "Forecast"] as const;

/**
 * An illustrative stretch of the chain: one cycle's receipts, a refusal among
 * them. Sequence numbers and hashes are made up; the domains and actions are
 * the kinds the agent writes.
 */
const RECEIPTS = [
  { seq: 1041, what: "compliance · screened", hash: "3c9e5a01b2d4f6e8a0c2e4f6a8b0d2f4e6a8c0e2a4b6d8f0a2c4e6b8d0f23a71", tone: "plain" },
  { seq: 1042, what: "ap · refused", hash: "9f02d4c6e8a0b2d4f6a8c0e2a4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b5", tone: "refused" },
  { seq: 1043, what: "ap · paid", hash: "b4e1a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7c0d8", tone: "proof" },
  { seq: 1044, what: "treasury · hold", hash: "e7a24c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d1f96", tone: "plain" },
] as const;

/** One step of the loop: its number and name, what happens, and a sample of what it leaves. */
function Step({ number, name, title, tone, children, sample }: {
  number: string;
  name: string;
  title: string;
  tone: "ground" | "agent" | "refused" | "proof";
  children: ReactNode;
  sample: ReactNode;
}) {
  return (
    <>
      <p
        className={cn(
          "font-mono text-xs font-semibold uppercase tracking-[0.16em]",
          tone === "ground" && "text-ground/70",
          tone === "agent" && "text-agent-line",
          tone === "refused" && "text-refused-line",
          tone === "proof" && "text-proof-line"
        )}
      >
        {number} · {name}
      </p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-surface sm:text-[1.75rem]">{title}</h3>
      <p className="mt-2 max-w-xl text-[0.9375rem] leading-relaxed text-ground/70">{children}</p>
      <div className="mt-5 max-w-xl">{sample}</div>
    </>
  );
}

const STEPS: ReactNode[] = [
  <Step
    key="observe"
    number="01"
    name="Observe"
    title="The agent reads the whole book."
    tone="ground"
    sample={
      <ul aria-label="What the agent reads each cycle" className="flex flex-wrap gap-2">
        {DOMAINS.map((domain) => (
          <li key={domain} className="rounded-full border border-ground/15 px-3 py-1 text-sm text-ground/85">
            {domain}
          </li>
        ))}
      </ul>
    }
  >
    Each cycle starts from the book, screening results and verified work.
  </Step>,
  <Step
    key="reason"
    number="02"
    name="Reason"
    title="The model proposes."
    tone="agent"
    sample={
      <pre className="overflow-x-auto rounded-xl border border-ground/10 bg-ink/60 p-3 font-mono text-xs leading-relaxed text-ground/80">
        {"{ action: "}<span className="text-agent-line">{'"pay"'}</span>{",\n  confidence: 0.81,\n  reasoning: "}<span className="text-ground/60">{'"…"'}</span>{" }"}
      </pre>
    }
  >
    An LLM — or, when none is configured, a transparent heuristic — returns an action, its reasoning and a confidence. It can argue. It cannot pay.
  </Step>,
  <Step
    key="enforce"
    number="03"
    name="Enforce"
    title="Code decides."
    tone="refused"
    sample={
      <ul className="space-y-1.5 font-mono text-xs">
        <li className="flex items-center gap-2 text-ground/75"><Check aria-hidden className="size-3.5 text-proof-line" strokeWidth={3} />invoice.duplicate_of_settled</li>
        <li className="flex items-center gap-2 text-ground/75"><Check aria-hidden className="size-3.5 text-proof-line" strokeWidth={3} />counterparty.high_risk</li>
        <li className="flex items-center gap-2 font-semibold text-refused-line"><X aria-hidden className="size-3.5" strokeWidth={3} />counterparty.payment_limit<span className="sr-only">, failed</span></li>
      </ul>
    }
  >
    Duplicate, risk and payment-limit rules run as ordinary code. They can overrule the model; nothing the model writes can overrule them.
  </Step>,
  <Step
    key="act"
    number="04"
    name="Act"
    title="Only then, money moves."
    tone="proof"
    sample={
      <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-ground/75">
        <span className="rounded-md border border-proof-line/50 px-1.5 py-0.5 font-semibold uppercase tracking-[0.12em] text-proof-line">confirmed</span>
        payment intent · Arc
      </p>
    }
  >
    An allowed payment goes to Circle on Arc. A refused or held one stops at the boundary, and its reason is kept.
  </Step>,
  <Step
    key="sign"
    number="05"
    name="Sign"
    title="Every outcome becomes a receipt — refusals included."
    tone="proof"
    sample={
      <div className="flex items-start gap-4">
        <Seal tone="agent" className="hidden size-14 shrink-0 text-agent-line min-[440px]:block" />
        <ol aria-label="An illustrative stretch of the chain" className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
          {RECEIPTS.map((receipt, index) => (
            <li
              key={receipt.seq}
              className={cn(
                "relative rounded-xl border px-3.5 py-3 font-mono text-xs",
                receipt.tone === "refused" ? "border-refused-line/45 bg-refused/10" : receipt.tone === "proof" ? "border-proof-line/40 bg-proof/10" : "border-ground/15 bg-ground/[0.04]"
              )}
            >
              <p className="flex flex-col gap-0.5">
                <span className="font-semibold text-surface">#{receipt.seq}</span>
                <span className={cn(receipt.tone === "refused" ? "text-refused-line" : receipt.tone === "proof" ? "text-proof-line" : "text-ground/70")}>{receipt.what}</span>
              </p>
              <p className="mt-2 text-ground/55">
                hash <HashText value={receipt.hash} className="text-ground/80" />
              </p>
              <p className="text-ground/55">
                prev {index === 0 ? <span className="text-ground/80">…</span> : <HashText value={RECEIPTS[index - 1].hash} className="text-ground/80" />}
              </p>
            </li>
          ))}
        </ol>
      </div>
    }
  >
    Each entry is signed with Ed25519, and its hash covers the one before it. Change any entry and every later hash stops matching — the chain verifier names the first entry that breaks.
  </Step>,
];

/**
 * The page's one dark section: the loop every payment runs, told step by step
 * as the reader scrolls, beside a diagram of it that lights the step being read
 * (docs/superpowers/specs/2026-10-08-landing-motion-design.md M1).
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="relative scroll-mt-16 bg-ink text-ground">
      <div aria-hidden className="ledger-grid-dark absolute inset-0" />
      <div aria-hidden className="absolute inset-x-0 top-0 h-[42rem] overflow-hidden">
        <div className="absolute -top-40 left-1/2 size-[42rem] -translate-x-1/2 rounded-full bg-agent/25 blur-3xl" />
      </div>
      <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <Reveal>
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-agent-line">How a decision becomes an action</p>
          <h2 id="how-it-works-title" className="mt-4 max-w-4xl text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.045em] text-surface sm:text-6xl">
            One loop. Two layers of judgment. <span className="font-serif font-normal italic text-agent-line">One receipt chain.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-ground/70">
            Each cycle the agent reads the whole book. A model argues for an action, code decides whether it may happen, and only then does money move. Every outcome is signed into the chain.
          </p>
        </Reveal>

        <div className="mt-14 sm:mt-20">
          <DecisionPipeline steps={STEPS} />
        </div>
      </div>
    </section>
  );
}
