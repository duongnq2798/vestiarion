import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { fmt, Label } from "@/components/vx/Primitives";
import { BrandMark } from "@/components/vx/Brand";
import { getChainProvider } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { getLandingMetrics, type LandingMetrics } from "@/lib/landing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vestiarion — Verifiable Treasury Agent on Arc",
  description: "A treasury agent that screens counterparties, pays obligations, applies code-level guardrails, and signs every decision into an auditable chain on Arc testnet.",
  openGraph: {
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "See the live console, measured Arc testnet outcomes, and signed decision ledger behind an autonomous business treasury.",
    type: "website",
    siteName: "Vestiarion",
  },
  twitter: {
    card: "summary",
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "An autonomous treasury agent whose decisions, refusals, and evidence are inspectable.",
  },
};

function MetricCard({ label, value, note, href, measured }: {
  label: string;
  value: string;
  note: string;
  href: string;
  measured: boolean;
}) {
  return (
    <Link href={href} className={`group surface-shadow relative overflow-hidden rounded-2xl border p-5 transition-all hover:-translate-y-1 hover:border-agent-line sm:p-6 ${measured ? "border-line bg-surface" : "hatch border-dashed border-line-strong bg-surface/70"}`}>
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1 ${measured ? "bg-proof" : "bg-line-strong/50"}`} />
      <Label>{label}</Label>
      <p className={`mt-3 font-mono font-semibold tracking-[-0.025em] ${measured ? "text-3xl text-ink" : "text-base leading-snug text-ink-2"}`}>{value}</p>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">{note} <span className="font-semibold text-agent group-hover:underline">View evidence →</span></p>
    </Link>
  );
}

async function LiveMetrics() {
  const metrics = await getLandingMetrics();
  const hasCycles = metrics.instrumentedCycles > 0;
  const hasTransfers = metrics.settledLiveTransfers > 0;
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Instrumented cycles" value={hasCycles ? String(metrics.instrumentedCycles) : "No cycle measured yet"} note={hasCycles ? latestCycleNote(metrics) : "Phase 7 history starts with the next permitted cycle."} href="/insights" measured={hasCycles} />
        <MetricCard label="Agent decisions" value={hasCycles ? String(metrics.instrumentedDecisions) : "No decision series yet"} note={hasCycles ? "Persisted at the decision point." : "Earlier ledger entries were not backfilled into cycle metrics."} href="/insights" measured={hasCycles} />
        <MetricCard label="Live transfers settled" value={hasTransfers ? String(metrics.settledLiveTransfers) : "No measured transfer yet"} note={hasTransfers ? "Confirmed Circle payment intents on Arc testnet." : "No confirmed post-instrumentation payment intent exists."} href="/insights" measured={hasTransfers} />
        <MetricCard label="Median chain fee" value={metrics.medianChainFeeUsd == null ? "No chain-reported fee yet" : `$${fmt(metrics.medianChainFeeUsd)}`} note={metrics.medianChainFeeUsd == null ? "Provider estimates are deliberately excluded." : `${metrics.chainFeeSampleCount} chain-reported live sample${metrics.chainFeeSampleCount === 1 ? "" : "s"}.`} href="/insights" measured={metrics.medianChainFeeUsd != null} />
        <MetricCard label="Median settlement" value={metrics.medianSettlementMs == null ? "No confirmed timing yet" : `${Math.round(metrics.medianSettlementMs)} ms`} note={metrics.medianSettlementMs == null ? "Pending transfers have no invented duration." : `${metrics.settlementSampleCount} confirmed live sample${metrics.settlementSampleCount === 1 ? "" : "s"}.`} href="/insights" measured={metrics.medianSettlementMs != null} />
        <MetricCard label="Signed ledger height" value={metrics.ledgerHeight > 0 ? String(metrics.ledgerHeight) : "Ledger is empty"} note={metrics.ledgerHeight > 0 ? "Current append-only chain length." : "No entry is styled as an achievement."} href="/audit" measured={metrics.ledgerHeight > 0} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">All figures above are server-rendered from the configured Supabase project. Transfer metrics include live Arc testnet rows only; simulated rows never enter these medians.</p>
    </div>
  );
}

function latestCycleNote(metrics: LandingMetrics): string {
  return metrics.latestInstrumentedCycleAt
    ? `Latest completed ${new Date(metrics.latestInstrumentedCycleAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.`
    : "No completed instrumented cycle.";
}

function MetricsFallback() {
  return <div className="surface-shadow h-56 animate-pulse rounded-2xl border border-line bg-surface" aria-label="Loading live measurements" />;
}

const claims = [
  {
    title: "A model can recommend payment. Code can still refuse it.",
    body: "Every payable verdict crosses risk, screened-limit, evidence, and liquidity checks before the provider boundary. A blocked verdict records what the model argued and which rule overruled it.",
    href: "/console",
    evidence: "See the guardrail receipt",
  },
  {
    title: "Screening changes authority, not history.",
    body: "A live OpenSanctions match or labelled bundled fallback derives the current payment limit from the business baseline. Re-screening is reversible and failed lookups retain the previous verdict.",
    href: "/compliance",
    evidence: "Inspect tiered limits",
  },
  {
    title: "Treasury moves must beat their own cost.",
    body: "The reserve policy prices projected yield against the sweep-and-redemption round trip while protecting obligations due in 7 and 14 days. Uneconomic movement stays liquid.",
    href: "/audit?domain=treasury",
    evidence: "Read the economics",
  },
  {
    title: "The audit log is a cryptographic receipt, not a feed.",
    body: "Every human, agent, and system action is Ed25519-signed, linked to the previous entry, and independently verified against the full chain on demand.",
    href: "/audit",
    evidence: "Verify the hash chain",
  },
] as const;

function DecisionFlowDiagram() {
  const stages = ["Compliance", "AP", "Contractors", "Treasury", "Forecast"];
  return (
    <figure className="surface-shadow ledger-grid mx-auto max-w-5xl rounded-3xl border border-line bg-surface p-4 sm:p-7" aria-labelledby="flow-title" aria-describedby="flow-desc">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Label className="text-agent">01 · Observe the operating cycle</Label>
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
          <li key={stage} className={`col-span-2 min-w-0 rounded-xl border border-line bg-ground/65 px-2 py-2.5 text-center ${index === 3 ? "col-start-2" : ""}`}>
            <span className="block font-mono text-[0.5625rem] text-agent">0{index + 1}</span>
            <span className="mt-0.5 block truncate text-xs font-semibold text-ink">{stage}</span>
          </li>
        ))}
      </ol>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-line-strong" />
      <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:gap-3">
        <div className="rounded-2xl border border-agent-line bg-agent-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Label className="text-agent">02 · Reason</Label>
          <p className="mt-2 font-semibold text-agent">LLM or heuristic verdict</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">action · reasoning · confidence</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-refused-line bg-refused-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Label className="text-refused">03 · Enforce</Label>
          <p className="mt-2 font-semibold text-refused">Code guardrail</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">may override the model</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-proof-line bg-proof-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Label className="text-proof">04 · Act</Label>
          <p className="mt-2 font-semibold text-proof">Execute or hold</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">provider boundary</p>
        </div>
      </div>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-proof-line" />
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-proof-line bg-ground/80 px-3 py-3 text-left sm:px-4">
        <div className="flex items-center gap-3">
          <BrandMark className="size-8 shrink-0 text-agent" />
          <div><Label className="text-proof">05 · Sign</Label><p className="mt-0.5 text-sm font-semibold text-ink">Signed hash-chain ledger</p></div>
        </div>
        <p className="hidden max-w-md text-xs leading-relaxed text-ink-2 min-[430px]:block sm:text-right">Evidence under every stage—including refusals.</p>
      </div>
      <figcaption id="flow-desc" className="mt-4 text-xs leading-relaxed text-ink-3">The reasoning engine proposes; deterministic policy decides; every outcome leaves a signed receipt.</figcaption>
    </figure>
  );
}

function ProofPanel({ provenance }: { provenance: ProvenanceLeg[] }) {
  const steps = [
    ["01", "Observe", "book + screening evidence"],
    ["02", "Reason", "model or explicit heuristic"],
    ["03", "Enforce", "code-level policy boundary"],
    ["04", "Sign", "append-only audit receipt"],
  ] as const;
  return (
    <aside className="surface-shadow relative overflow-hidden rounded-[1.75rem] border border-line bg-surface p-5 sm:p-6">
      <div aria-hidden className="absolute -right-14 -top-16 size-44 rounded-full bg-agent-soft blur-2xl motion-safe:animate-drift" />
      <div className="relative">
        <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
          <div><Label className="text-agent">System state</Label><p className="mt-1 text-sm font-semibold text-ink">Proof before movement</p></div>
          <div className="relative">
            <BrandMark className="brand-shadow size-11 text-agent" />
            <span className="absolute -bottom-1 -right-1 rounded-full border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.5rem] font-bold text-agent">01</span>
          </div>
        </div>
        <ol className="my-5 space-y-3">
          {steps.map(([number, title, detail]) => (
            <li key={number} className="grid grid-cols-[2rem_5rem_minmax(0,1fr)] items-baseline gap-2">
              <span className="font-mono text-[0.6875rem] font-semibold text-agent">{number}</span>
              <span className="text-sm font-semibold text-ink">{title}</span>
              <span className="text-xs text-ink-3">{detail}</span>
            </li>
          ))}
        </ol>
        <ProvenanceBar legs={provenance} />
        <div className="mt-5 rounded-xl border border-refused-line bg-refused-soft px-4 py-3">
          <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-refused">Guardrail is executable policy</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">A model verdict cannot cross the payment boundary without passing deterministic checks.</p>
        </div>
      </div>
    </aside>
  );
}

export default function LandingPage() {
  const provider = getChainProvider();
  const currentScreeningMode = screeningMode();
  const provenance: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: provider.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: provider.earnMode === "live" },
    { label: "Screening", detail: currentScreeningMode === "live" ? "OpenSanctions" : "bundled list", live: currentScreeningMode === "live" },
  ];

  return (
    <div className="min-h-dvh overflow-x-hidden bg-transparent">
      <header className="sticky top-0 z-50 border-b border-line/80 bg-surface/88 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <Link href="/" className="group inline-flex items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink">
            <BrandMark className="brand-shadow size-9 shrink-0 text-agent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
            <span>Vestiarion</span>
          </Link>
          <nav aria-label="Landing navigation" className="flex items-center gap-2 sm:gap-4">
            <Link href="/insights" className="hidden text-sm text-ink-2 hover:text-ink sm:block">Measured outcomes</Link>
            <Link href="/audit" className="hidden text-sm text-ink-2 hover:text-ink sm:block">Audit proof</Link>
            <Link href="/console" className="brand-shadow rounded-xl bg-agent px-4 py-2.5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5">Open console</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
          <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
          <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_27rem] lg:items-center lg:py-24">
            <div>
              <Label className="text-agent">Autonomous treasury · Arc testnet</Label>
              <h1 className="mt-5 max-w-4xl text-balance text-5xl font-semibold leading-[0.97] tracking-[-0.055em] text-ink sm:text-7xl">Money moves.<br /><span className="font-serif font-normal italic text-agent">Evidence remains.</span></h1>
              <p className="mt-6 max-w-2xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-[1.65rem]">Vestiarion screens counterparties, matches obligations, verifies work, and manages liquidity. A model proposes each action; code enforces the boundary; a signed ledger keeps the receipt.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/console" className="brand-shadow rounded-xl bg-agent px-5 py-3 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5">See the agent run</Link>
                <Link href="/audit" className="rounded-xl border border-line-strong bg-surface/80 px-5 py-3 text-sm font-semibold text-ink transition-colors hover:border-agent-line hover:text-agent">Verify the ledger</Link>
              </div>
            </div>
            <ProofPanel provenance={provenance} />
          </div>
        </section>

        <section aria-labelledby="measurements-title" className="mx-auto max-w-6xl px-4 pb-10 pt-14 sm:px-6 sm:pb-14 sm:pt-20">
          <div className="mb-6 max-w-3xl">
            <Label>Live database receipts</Label>
            <h2 id="measurements-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Numbers only appear after the system produces them.</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">The current ledger can contain real earlier evidence while post-instrumentation cycle and transfer series remain empty. The page keeps that distinction visible.</p>
          </div>
          <Suspense fallback={<MetricsFallback />}><LiveMetrics /></Suspense>
        </section>

        <section className="border-y border-line bg-surface/55">
          <div className="mx-auto max-w-6xl px-4 pb-8 pt-12 sm:px-6 sm:pb-12 sm:pt-16">
            <Label>How a decision becomes an action</Label>
            <h2 className="mb-6 mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">One loop. Two layers of judgment. One receipt chain.</h2>
            <DecisionFlowDiagram />
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-14">
          <Label>Claims with receipts</Label>
          <h2 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Do not take the landing page’s word for it.</h2>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
            {claims.map((claim, index) => (
              <Link key={claim.title} href={claim.href} className="group surface-shadow relative overflow-hidden rounded-2xl border border-line bg-surface p-6 transition-all hover:-translate-y-1 hover:border-agent-line sm:p-7">
                <span className="absolute right-5 top-4 font-mono text-4xl font-bold text-raised">0{index + 1}</span>
                <h3 className="relative max-w-[28rem] text-xl font-semibold tracking-tight text-ink">{claim.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{claim.body}</p>
                <p className="mt-4 text-sm font-medium text-agent group-hover:underline">{claim.evidence} →</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="border-t border-line bg-agent text-on-agent">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div><h2 className="text-3xl font-semibold tracking-tight text-on-agent">Open the evidence, not a scripted demo.</h2><p className="mt-2 text-sm text-white/75">Inspect the current book, every refusal, and the chain verifier.</p></div>
            <div className="flex flex-wrap gap-3"><Link href="/console" className="rounded-xl bg-surface px-5 py-3 text-sm font-semibold text-agent">Open console</Link><Link href="/insights" className="rounded-xl border border-white/35 px-5 py-3 text-sm font-semibold text-on-agent hover:bg-white/10">Measured outcomes</Link></div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface px-4 py-7 text-center font-mono text-xs text-ink-3">Vestiarion · signed decisions · Arc testnet</footer>
    </div>
  );
}
