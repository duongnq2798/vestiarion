import type { ReactNode } from "react";
import { AgentActivity } from "@/components/AgentActivity";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import type { CycleClockMode } from "@/lib/clock";
import { networkProfile, type Network } from "@/lib/network";
import type { ShellStatus } from "@/lib/shell-status";
import { CONTENT_FRAME } from "./frame";
import { FrameBanners } from "./FrameContext";
import { ScrollToHash } from "./ScrollToHash";
import { WorkspaceHeader } from "./WorkspaceHeader";

/**
 * The page's side of the workspace frame: its header — where the person is,
 * when the agent last ran, and the workspace's status — then the layout's
 * banners and the page's own content (workspace shell design S4, S5).
 * Navigation lives in `AppFrame`, drawn by the layout. Each page mounts its own
 * shell, so its content rises into place on every navigation and stays still
 * on a refresh.
 *
 * Renders what the page hands it and reads no tenant data of its own. React
 * can render a child after the page function has returned, which is outside
 * the organization's scope, so the page loads everything inside `inOrg` and
 * passes it down rather than letting the shell fetch — the screening status
 * included, which read here would be the deployment's rather than the
 * workspace's.
 */
export function ProductShell({
  day,
  clockMode,
  lastCycleAt,
  chainModes,
  network,
  status,
  children,
}: {
  day: number;
  clockMode: CycleClockMode;
  lastCycleAt: string | null;
  /** The page's modes, and whether nothing can pay now (`shellModes()`), which the header says as held (final review I2). */
  chainModes: { mode: "live" | "simulate"; earnMode: "live" | "simulate"; held: boolean };
  /** The workspace's network, which the footer names (mainnet copy C1). */
  network: Network;
  /** Shadow mode and screening, read in the workspace's scope (`shellStatus()`). */
  status: ShellStatus;
  children: ReactNode;
}) {
  return (
    <>
      <WorkspaceHeader
        page={{ chain: chainModes, shadow: status.shadow, screening: status.screening, clock: { mode: clockMode, day } }}
        // When the last cycle ran, or that one is running now; and a toast for each decision as it lands.
        activity={<AgentActivity lastCycleAt={lastCycleAt} />}
      />
      <div className={cn(CONTENT_FRAME, "pb-10 pt-4 motion-safe:animate-arrive sm:pt-6 lg:pt-7")}>
        <FrameBanners />
        {children}
        <ScrollToHash />
        <footer className="mt-12 flex justify-center">
          <Badge size="sm" className="bg-surface/80 font-mono font-normal text-ink-3">
            {shellFooterLine(network)}
          </Badge>
        </footer>
      </div>
    </>
  );
}

/** The badge under every workspace page, naming its network. */
export function shellFooterLine(network: Network): string {
  return `Hash-chained decisions · Ed25519 signed · ${networkProfile(network).label}`;
}

/** A workspace page's title, the line under it, and its own actions on the right. The title is the page's only `<h1>`. */
export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-ink">{title}</h1>
        {sub && <p className="mt-1.5 max-w-3xl text-pretty text-sm leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
