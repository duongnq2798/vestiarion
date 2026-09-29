import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState as EmptyStateBase } from "@/components/ui/EmptyState";
import { screeningMode } from "@/lib/compliance";
import type { CycleClockMode } from "@/lib/clock";
import { ProvenanceBar, type ProvenanceLeg } from "./Provenance";
import { ScrollToHash } from "./ScrollToHash";

/**
 * The page's side of the workspace frame: the agent's clock and what is live
 * or simulated, above the page's own content. Navigation lives in `AppFrame`,
 * drawn by the layout. Each page mounts its own shell, so its content rises
 * into place on every navigation and stays still on a refresh.
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
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 motion-safe:animate-arrive sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <div className="mb-6 flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
          <Badge size="sm" className="font-mono uppercase tracking-[0.11em] text-ink-2">
            {clockMode === "simulate" ? `Day ${day}` : "Wall clock"}
          </Badge>
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" />
            {lastCycleAt ? `Last cycle ${new Date(lastCycleAt).toLocaleString()}` : "No cycle recorded yet"}
          </span>
        </p>
        <ProvenanceBar legs={legs} compact />
      </div>
      {children}
      <ScrollToHash />
      <footer className="mt-12 flex justify-center">
        <Badge size="sm" className="bg-surface/80 font-mono font-normal text-ink-3">
          Hash-chained decisions · Ed25519 signed · Arc testnet
        </Badge>
      </footer>
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-5 border-b border-line pb-6 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-ink sm:text-3xl">{title}</h1>
        {sub && <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** Kept for the pages Plan B2 moves over; new code imports `EmptyState` from `@/components/ui/EmptyState`. */
export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return <EmptyStateBase title={title} body={body} titleAs="h2" />;
}
