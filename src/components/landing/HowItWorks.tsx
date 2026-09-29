import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Reveal } from "@/components/ui/Reveal";
import { HashText, Seal } from "./evidence/Evidence";

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

function Layer({ number, name, title, tone, children, sample }: {
  number: string;
  name: string;
  title: string;
  tone: "agent" | "refused" | "proof";
  children: ReactNode;
  sample: ReactNode;
}) {
  return (
    <li
      className={cn(
        "relative flex flex-col rounded-2xl border bg-ground/[0.04] p-5 sm:p-6",
        tone === "agent" && "border-agent-line/30",
        tone === "refused" && "border-refused-line/40 bg-refused/[0.07]",
        tone === "proof" && "border-proof-line/30"
      )}
    >
      <p
        className={cn(
          "font-mono text-xs font-semibold uppercase tracking-[0.16em]",
          tone === "agent" && "text-agent-line",
          tone === "refused" && "text-refused-line",
          tone === "proof" && "text-proof-line"
        )}
      >
        {number} · {name}
      </p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-surface">{title}</h3>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-ground/70">{children}</p>
      <div className="mt-auto pt-5">{sample}</div>
    </li>
  );
}

/**
 * The page's one dark section: the loop every payment runs, drawn as the two
 * layers of judgment it crosses and the chain of receipts it leaves.
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="relative scroll-mt-16 overflow-hidden bg-ink text-ground">
      <div aria-hidden className="ledger-grid-dark absolute inset-0" />
      <div aria-hidden className="absolute -top-40 left-1/2 size-[42rem] -translate-x-1/2 rounded-full bg-agent/25 blur-3xl" />
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

        <Reveal className="mt-14">
          <div className="flex flex-col gap-3 rounded-2xl border border-ground/12 bg-ground/[0.03] p-4 sm:flex-row sm:items-center sm:gap-5 sm:p-5">
            <p className="shrink-0 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-ground/60">01 · Observe</p>
            <ul aria-label="What the agent reads each cycle" className="flex flex-wrap gap-2">
              {DOMAINS.map((domain) => (
                <li key={domain} className="rounded-full border border-ground/15 px-3 py-1 text-sm text-ground/85">
                  {domain}
                </li>
              ))}
            </ul>
            <p className="text-sm text-ground/55 sm:ml-auto">the book, screening results and verified work</p>
          </div>
        </Reveal>

        <div aria-hidden className="chain-flow mx-auto h-10 w-px text-ground/40" />

        <Reveal>
          <ol className="grid gap-4 lg:grid-cols-3">
            <Layer
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
            </Layer>
            <Layer
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
            </Layer>
            <Layer
              number="04"
              name="Act"
              title="Only then, money moves."
              tone="proof"
              sample={
                <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-ground/75">
                  <span className="rounded-md border border-proof-line/50 px-1.5 py-0.5 font-semibold uppercase tracking-[0.12em] text-proof-line">confirmed</span>
                  payment intent · Arc testnet
                </p>
              }
            >
              An allowed payment goes to Circle on Arc testnet. A refused or held one stops at the boundary, and its reason is kept.
            </Layer>
          </ol>
        </Reveal>

        <div aria-hidden className="chain-flow mx-auto h-10 w-px text-ground/40" />

        <Reveal>
          <div className="rounded-2xl border border-ground/12 bg-ground/[0.03] p-4 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
              <div className="flex items-center gap-4 lg:w-72 lg:shrink-0">
                <Seal tone="agent" className="size-16 shrink-0 text-agent-line" />
                <div>
                  <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-proof-line">05 · Sign</p>
                  <p className="mt-1 text-lg font-semibold leading-snug text-surface">Every outcome becomes a receipt — refusals included.</p>
                </div>
              </div>
              <ol aria-label="An illustrative stretch of the chain" className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
            <p className="mt-5 border-t border-ground/10 pt-4 text-[0.9375rem] leading-relaxed text-ground/65">
              Each entry is signed with Ed25519, and its hash covers the one before it. Change any entry and every later hash stops matching — the chain verifier names the first entry that breaks.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
