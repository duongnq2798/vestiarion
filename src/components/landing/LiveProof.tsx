import Link from "next/link";
import { Suspense } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { fmt } from "@/components/vx/Primitives";
import type { LandingMetrics } from "@/lib/landing";

function MetricCard({ label, value, note, href, measured }: {
  label: string;
  value: string;
  note: string;
  href: string;
  measured: boolean;
}) {
  return (
    <Card asChild interactive tone={measured ? "default" : "simulated"} className={cn("group relative overflow-hidden p-5 sm:p-6", !measured && "hatch bg-surface/70")}>
      <Link href={href}>
        <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", measured ? "bg-proof" : "bg-line-strong/50")} />
        <Eyebrow>{label}</Eyebrow>
        <p className={cn("mt-3 font-mono font-semibold tracking-[-0.025em]", measured ? "text-3xl text-ink" : "text-base leading-snug text-ink-2")}>{value}</p>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          {note} <span className="font-semibold text-agent group-hover:underline">View evidence →</span>
        </p>
      </Link>
    </Card>
  );
}

async function LiveMetrics({ source }: { source: Promise<LandingMetrics> }) {
  const metrics = await source;
  const hasCycles = metrics.instrumentedCycles > 0;
  const hasTransfers = metrics.settledLiveTransfers > 0;
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Instrumented cycles" value={hasCycles ? String(metrics.instrumentedCycles) : "No cycle measured yet"} note={hasCycles ? latestCycleNote(metrics) : "Phase 7 history starts with the next permitted cycle."} href={"/onboarding"} measured={hasCycles} />
        <MetricCard label="Agent decisions" value={hasCycles ? String(metrics.instrumentedDecisions) : "No decision series yet"} note={hasCycles ? "Persisted at the decision point." : "Earlier ledger entries were not backfilled into cycle metrics."} href={"/onboarding"} measured={hasCycles} />
        <MetricCard label="Live transfers settled" value={hasTransfers ? String(metrics.settledLiveTransfers) : "No measured transfer yet"} note={hasTransfers ? "Confirmed Circle payment intents on Arc testnet." : "No confirmed post-instrumentation payment intent exists."} href={"/onboarding"} measured={hasTransfers} />
        <MetricCard label="Median chain fee" value={metrics.medianChainFeeUsd == null ? "No chain-reported fee yet" : `$${fmt(metrics.medianChainFeeUsd)}`} note={metrics.medianChainFeeUsd == null ? "Provider estimates are deliberately excluded." : `${metrics.chainFeeSampleCount} chain-reported live sample${metrics.chainFeeSampleCount === 1 ? "" : "s"}.`} href={"/onboarding"} measured={metrics.medianChainFeeUsd != null} />
        <MetricCard label="Median settlement" value={metrics.medianSettlementMs == null ? "No confirmed timing yet" : `${Math.round(metrics.medianSettlementMs)} ms`} note={metrics.medianSettlementMs == null ? "Pending transfers have no invented duration." : `${metrics.settlementSampleCount} confirmed live sample${metrics.settlementSampleCount === 1 ? "" : "s"}.`} href={"/onboarding"} measured={metrics.medianSettlementMs != null} />
        <MetricCard label="Signed ledger height" value={metrics.ledgerHeight > 0 ? String(metrics.ledgerHeight) : "Ledger is empty"} note={metrics.ledgerHeight > 0 ? "Current append-only chain length." : "No entry is styled as an achievement."} href={"/onboarding"} measured={metrics.ledgerHeight > 0} />
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
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading live measurements</p>
      <Skeleton className="h-56 rounded-2xl" />
    </div>
  );
}

/** `metrics` is started by the page and streams in behind a skeleton. */
export function LiveProof({ metrics }: { metrics: Promise<LandingMetrics> }) {
  return (
    <section id="measurements" aria-labelledby="measurements-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-10 pt-14 sm:px-6 sm:pb-14 sm:pt-20">
      <Reveal>
        <div className="mb-6 max-w-3xl">
          <Eyebrow>Live database receipts</Eyebrow>
          <h2 id="measurements-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Numbers only appear after the system produces them.</h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">The current ledger can contain real earlier evidence while post-instrumentation cycle and transfer series remain empty. The page keeps that distinction visible.</p>
        </div>
        <Suspense fallback={<MetricsFallback />}>
          <LiveMetrics source={metrics} />
        </Suspense>
      </Reveal>
    </section>
  );
}
