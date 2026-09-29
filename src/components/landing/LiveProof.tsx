import Link from "next/link";
import { Suspense } from "react";
import { Receipt, Verdict } from "@/components/landing/evidence/Evidence";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { fmt } from "@/components/vx/Primitives";
import type { LandingMetrics } from "@/lib/landing";

function settlementValue(value: number | null): string {
  if (value == null) return "Awaiting a confirmed live sample";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${fmt(value / 1_000)} s`;
}

function latestCycleNote(metrics: LandingMetrics): string {
  if (metrics.latestInstrumentedCycleAt) {
    const finished = new Date(metrics.latestInstrumentedCycleAt).toLocaleString("en-US", { timeZone: "UTC" });
    return `Latest recorded finish: ${finished} UTC.`;
  }
  if (metrics.instrumentedCycles > 0) return "A run record exists; no finish timestamp is stored yet.";
  return "The series starts when the next permitted run opens.";
}

function SupportingFigure({ label, value, note, measured }: {
  label: string;
  value: string;
  note: string;
  measured: boolean;
}) {
  return (
    <div className={cn("border-t border-line py-5 sm:py-6", !measured && "hatch border-dashed px-4")}>
      <Eyebrow className="text-xs">{label}</Eyebrow>
      <p className={cn("mt-2 font-mono font-semibold tracking-[-0.035em]", measured ? "text-3xl text-ink sm:text-4xl" : "text-lg text-ink-2")}>
        {value}
      </p>
      <p className="mt-2 max-w-sm text-[0.9375rem] leading-relaxed text-ink-2">{note}</p>
    </div>
  );
}

function CompactFigure({ label, value, note, measured }: {
  label: string;
  value: string;
  note: string;
  measured: boolean;
}) {
  return (
    <div className={cn("min-w-0 border-t border-line py-4", !measured && "text-ink-3")}>
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">{label}</p>
      <p className={cn("mt-2 font-mono text-2xl font-semibold", measured ? "text-ink" : "text-ink-3")}>{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-2">{note}</p>
    </div>
  );
}

async function LiveMetrics({ source }: { source: Promise<LandingMetrics> }) {
  const metrics = await source;
  const hasCycles = metrics.instrumentedCycles > 0;
  const hasTransfers = metrics.settledLiveTransfers > 0;
  const hasSettlement = metrics.medianSettlementMs != null;
  const hasFee = metrics.medianChainFeeUsd != null;
  const hasLedger = metrics.ledgerHeight > 0;
  const feeValue = metrics.medianChainFeeUsd;

  return (
    <div>
      <div className={cn("grid gap-6 border-y border-line py-7 sm:py-9 lg:grid-cols-[1.12fr_0.88fr] lg:gap-14", !hasSettlement && "hatch border-dashed px-4 sm:px-6")}>
        <div>
          <Eyebrow className="text-xs">Median live settlement</Eyebrow>
          <p className={cn("mt-3 font-mono font-semibold tracking-[-0.055em]", hasSettlement ? "text-5xl text-agent sm:text-7xl" : "max-w-xl text-3xl leading-tight text-ink-2 sm:text-4xl")}>
            {settlementValue(metrics.medianSettlementMs)}
          </p>
          <p className="mt-3 font-mono text-xs text-ink-3">
            {metrics.settlementSampleCount} confirmed live sample{metrics.settlementSampleCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="self-end">
          <p className="font-serif text-2xl leading-snug text-ink sm:text-3xl">
            Confirmation is observed at the payment provider, not inferred from the agent cycle.
          </p>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
            This is Circle create-to-first-confirm timing when those timestamps are present; the measured confirmation wait fills a missing provider interval. It is not “policy to receipt” latency.
          </p>
        </div>
      </div>

      <div className="mt-7 grid gap-x-8 sm:grid-cols-2">
        <SupportingFigure
          label="Median chain fee"
          value={feeValue == null ? "No chain-reported fee yet" : `$${fmt(feeValue)}`}
          note={hasFee ? `${metrics.chainFeeSampleCount} live fee receipt${metrics.chainFeeSampleCount === 1 ? "" : "s"}; provider estimates are excluded.` : "A configured estimate never passes as measured cost."}
          measured={hasFee}
        />
        <SupportingFigure
          label="Confirmed live transfers"
          value={hasTransfers ? String(metrics.settledLiveTransfers) : "No confirmed live transfer yet"}
          note={hasTransfers ? "Confirmed Circle payment intents with a stored execution timestamp." : "Simulated and pending payment intents do not enter this count."}
          measured={hasTransfers}
        />
      </div>

      <div className="mt-2 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-[0.75fr_0.75fr_1.5fr]">
        <CompactFigure
          label="Run records"
          value={hasCycles ? String(metrics.instrumentedCycles) : "—"}
          note={latestCycleNote(metrics)}
          measured={hasCycles}
        />
        <CompactFigure
          label="Recorded decisions"
          value={hasCycles ? String(metrics.instrumentedDecisions) : "—"}
          note={hasCycles ? "Decision counts persisted with those run records." : "Earlier ledger history is not backfilled into this series."}
          measured={hasCycles}
        />
        <div className="border-t border-line py-4">
          <Receipt slipClassName={cn("flex min-h-32 items-center justify-between gap-4 py-4", !hasLedger && "hatch border border-dashed border-line-strong")}>
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Signed ledger height</p>
              <p className="mt-2 font-serif text-2xl leading-tight text-ink">
                {hasLedger ? `Receipt #${metrics.ledgerHeight} heads the chain.` : "No receipt heads the chain yet."}
              </p>
            </div>
            <Verdict tone={hasLedger ? "proof" : "held"}>{hasLedger ? "signed" : "empty"}</Verdict>
          </Receipt>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-4xl text-xs leading-relaxed text-ink-3">
          All figures above are server-rendered from the configured Supabase project. Transfer metrics include live Arc testnet rows only; simulated rows never enter these medians.
        </p>
        <Link href="/onboarding" className="shrink-0 font-mono text-xs font-semibold text-agent underline-offset-4 hover:underline">
          Inspect the records →
        </Link>
      </div>
    </div>
  );
}

function MetricsFallback() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading live measurements</p>
      <Skeleton className="h-[70rem] rounded-none sm:h-[50rem] lg:h-[38rem]" />
    </div>
  );
}

/** `metrics` starts at the page boundary and streams behind a stable skeleton. */
export function LiveProof({ metrics }: { metrics: Promise<LandingMetrics> }) {
  return (
    <section id="measurements" aria-labelledby="measurements-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-14 pt-16 sm:px-6 sm:pb-20 sm:pt-24">
      <Reveal>
        <div className="mb-8 max-w-3xl sm:mb-10">
          <Eyebrow className="text-xs">Live database receipts</Eyebrow>
          <h2 id="measurements-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
            The numbers carry their source with them.
          </h2>
          <p className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-ink-2">
            Empty evidence stays empty. Live transfers, estimates, simulations, run records and signed ledger entries remain visibly distinct.
          </p>
        </div>
        <Suspense fallback={<MetricsFallback />}>
          <LiveMetrics source={metrics} />
        </Suspense>
      </Reveal>
    </section>
  );
}
