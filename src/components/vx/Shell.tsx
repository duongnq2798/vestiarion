import type { ReactNode } from "react";
import { screeningMode } from "@/lib/compliance";
import type { CycleClockMode } from "@/lib/clock";
import { ProvenanceBar, type ProvenanceLeg } from "./Provenance";
import { ScrollToHash } from "./ScrollToHash";

/**
 * The page's side of the workspace frame: the agent's clock and what is live
 * or simulated, above the page's own content. Navigation lives in `AppFrame`,
 * drawn by the layout.
 *
 * Renders what the page hands it and reads no tenant data of its own. React
 * can render a child after the page function has returned, which is outside
 * the organization's scope, so the page loads everything inside `inOrg` and
 * passes it down rather than letting the shell fetch.
 */
export function ProductShell({
  day,
  clockMode,
  lastCycleAt,
  chainModes,
  children,
}: {
  day: number;
  clockMode: CycleClockMode;
  lastCycleAt: string | null;
  chainModes: { mode: "live" | "simulate"; earnMode: "live" | "simulate" };
  children: ReactNode;
}) {
  const legs: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: chainModes.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: chainModes.earnMode === "live" },
    { label: "Screening", detail: screeningMode() === "live" ? "OpenSanctions" : "bundled list", live: screeningMode() === "live" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <div className="mb-6 flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
          <span className="rounded-full border border-line-strong bg-surface px-2.5 py-1 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-2">
            {clockMode === "simulate" ? `Day ${day}` : "Wall clock"}
          </span>
          <span>{lastCycleAt ? `Last cycle ${new Date(lastCycleAt).toLocaleString()}` : "No cycle recorded yet"}</span>
        </p>
        <ProvenanceBar legs={legs} compact />
      </div>
      {children}
      <ScrollToHash />
      <footer className="mt-12 flex justify-center">
        <span className="rounded-full border border-line bg-surface/80 px-3 py-1.5 text-center font-mono text-xs text-ink-3">
          Hash-chained decisions · Ed25519 signed · Arc testnet
        </span>
      </footer>
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-5 border-b border-line pb-6 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-ink sm:text-3xl">{title}</h1>
        {sub && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="hatch rounded-xl border border-dashed border-line-strong bg-surface/80 px-5 py-8 sm:px-8 sm:py-10">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 max-w-prose text-sm leading-relaxed text-ink-2">{body}</div>
    </div>
  );
}
