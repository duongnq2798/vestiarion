import type { ReactNode } from "react";
import { AgentActivity } from "@/components/AgentActivity";
import { Badge } from "@/components/ui/Badge";
import { screeningMode } from "@/lib/compliance";
import { screeningSourceLabel } from "@/lib/screening-source";
import type { CycleClockMode } from "@/lib/clock";
import { networkProfile, type Network } from "@/lib/network";
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
  network,
  children,
}: {
  day: number;
  clockMode: CycleClockMode;
  lastCycleAt: string | null;
  chainModes: { mode: "live" | "simulate"; earnMode: "live" | "simulate" };
  /** The workspace's network, which the shell names (mainnet copy C1). */
  network: Network;
  children: ReactNode;
}) {
  const legs: ProvenanceLeg[] = [...chainLegs(network, chainModes), { label: "Screening", detail: screeningSourceLabel(), live: screeningMode() === "live" }];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 motion-safe:animate-arrive sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <div className="mb-6 flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
          <Badge size="sm" className="font-mono uppercase tracking-[0.11em] text-ink-2">
            {clockMode === "simulate" ? `Day ${day}` : "Wall clock"}
          </Badge>
          {/* When the last cycle ran, or that one is running now; and a toast for each decision as it lands. */}
          <AgentActivity lastCycleAt={lastCycleAt} />
        </p>
        <ProvenanceBar legs={legs} compact />
      </div>
      {children}
      <ScrollToHash />
      <footer className="mt-12 flex justify-center">
        <Badge size="sm" className="bg-surface/80 font-mono font-normal text-ink-3">
          {shellFooterLine(network)}
        </Badge>
      </footer>
    </div>
  );
}

/**
 * The shell's Payments and Yield legs on the workspace's network (mainnet copy C1, C3): Payments names the network, and
 * Yield shows only where the network has a reserve to earn in.
 */
export function chainLegs(network: Network, modes: { mode: "live" | "simulate"; earnMode: "live" | "simulate" }): ProvenanceLeg[] {
  const profile = networkProfile(network);
  return [
    { label: "Payments", detail: profile.label, live: modes.mode === "live" },
    ...(profile.usyc ? [{ label: "Yield", detail: "USYC reserve", live: modes.earnMode === "live" }] : []),
  ];
}

/** The badge under every workspace page, naming its network. */
export function shellFooterLine(network: Network): string {
  return `Hash-chained decisions · Ed25519 signed · ${networkProfile(network).label}`;
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
