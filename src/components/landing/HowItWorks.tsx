import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { BrandMark } from "@/components/vx/Brand";

function DecisionFlowDiagram() {
  const stages = ["Compliance", "AP", "Contractors", "Treasury", "Forecast"];
  return (
    <figure className="ledger-grid mx-auto max-w-5xl rounded-2xl border border-line bg-surface p-4 shadow-surface sm:p-7" aria-labelledby="flow-title" aria-describedby="flow-desc">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Eyebrow className="text-agent">01 · Observe the operating cycle</Eyebrow>
          <h3 id="flow-title" className="mt-2 text-lg font-semibold tracking-tight text-ink sm:text-xl">Five stages. One accountable book.</h3>
        </div>
        <span className="hidden rounded-full border border-line bg-surface px-3 py-1 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-ink-3 sm:block">one cycle</span>
      </div>

      <ol className="mt-5 hidden grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2 sm:grid" aria-label="Agent cycle stages">
        {stages.map((stage, index) => (
          <li key={stage} className="contents">
            <div className="min-w-0 rounded-xl border border-line bg-ground/65 px-2 py-3 text-center">
              <span className="block font-mono text-[0.625rem] text-agent">0{index + 1}</span>
              <span className="mt-1 block truncate text-sm font-semibold text-ink">{stage}</span>
            </div>
            {index < stages.length - 1 && <span aria-hidden className="text-center font-mono text-sm text-ink-3">→</span>}
          </li>
        ))}
      </ol>
      <ol className="mt-4 grid grid-cols-6 gap-2 sm:hidden" aria-label="Agent cycle stages">
        {stages.map((stage, index) => (
          <li key={stage} className={cn("col-span-2 min-w-0 rounded-xl border border-line bg-ground/65 px-2 py-2.5 text-center", index === 3 && "col-start-2")}>
            <span className="block font-mono text-[0.5625rem] text-agent">0{index + 1}</span>
            <span className="mt-0.5 block truncate text-xs font-semibold text-ink">{stage}</span>
          </li>
        ))}
      </ol>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-line-strong" />
      <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:gap-3">
        <div className="rounded-2xl border border-agent-line bg-agent-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-agent">02 · Reason</Eyebrow>
          <p className="mt-2 font-semibold text-agent">LLM or heuristic verdict</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">action · reasoning · confidence</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-refused-line bg-refused-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-refused">03 · Enforce</Eyebrow>
          <p className="mt-2 font-semibold text-refused">Code guardrail</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">may override the model</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-proof-line bg-proof-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-proof">04 · Act</Eyebrow>
          <p className="mt-2 font-semibold text-proof">Execute or hold</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">provider boundary</p>
        </div>
      </div>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-proof-line" />
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-proof-line bg-ground/80 px-3 py-3 text-left sm:px-4">
        <div className="flex items-center gap-3">
          <BrandMark className="size-8 shrink-0 text-agent" />
          <div>
            <Eyebrow className="text-proof">05 · Sign</Eyebrow>
            <p className="mt-0.5 text-sm font-semibold text-ink">Signed hash-chain ledger</p>
          </div>
        </div>
        <p className="hidden max-w-md text-xs leading-relaxed text-ink-2 min-[430px]:block sm:text-right">Evidence under every stage—including refusals.</p>
      </div>
      <figcaption id="flow-desc" className="mt-4 text-xs leading-relaxed text-ink-3">The reasoning engine proposes; deterministic policy decides; every outcome leaves a signed receipt.</figcaption>
    </figure>
  );
}

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-16 border-y border-line bg-surface/55">
      <div className="mx-auto max-w-6xl px-4 pb-8 pt-12 sm:px-6 sm:pb-12 sm:pt-16">
        <Reveal>
          <Eyebrow>How a decision becomes an action</Eyebrow>
          <h2 id="how-it-works-title" className="mb-6 mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">One loop. Two layers of judgment. One receipt chain.</h2>
          <DecisionFlowDiagram />
        </Reveal>
      </div>
    </section>
  );
}
