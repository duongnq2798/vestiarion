"use client";

import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import { orgHref } from "@/lib/auth/org-paths";
import { CONTENT_FRAME } from "./frame";
import { useFrame } from "./FrameContext";
import { HOME_PATH, navItemForPathname } from "./nav";
import { statusChips, statusRows, statusSummary, type PageStatus, type StatusChip, type StatusRow, type StatusTone } from "./workspace-status";

/**
 * The bar at the top of every workspace page (workspace shell design S4): from `lg`, the sidebar toggle and where the
 * person is, and on the right when the agent last ran and the workspace's status. Below `lg` the phone bar above it
 * names the page, so this is a row of status under it.
 *
 * It is not a heading: each page keeps its own `<h1>`. The status comes from two places — the layout's platform facts
 * (through `useFrame`) and the page's own (`page`), which a loading or error state does not have, and then says less.
 */
export function WorkspaceHeader({ page, activity }: { page?: PageStatus; activity?: ReactNode }) {
  const { workspace, platform, sidebarCollapsed, toggleSidebar } = useFrame();
  const section = navItemForPathname(usePathname());
  const chips = statusChips(platform, page);
  const rows = statusRows(platform, page);

  return (
    <header className="border-line/80 lg:sticky lg:top-0 lg:z-20 lg:border-b lg:bg-ground/85 lg:backdrop-blur-xl">
      <div className={cn(CONTENT_FRAME, "flex flex-wrap items-center gap-x-3 gap-y-2 pt-4 lg:h-14 lg:flex-nowrap lg:pt-0")}>
        <div className="hidden min-w-0 items-center gap-2 lg:flex">
          <Tooltip
            content={
              <span className="inline-flex items-center gap-2">
                {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                <Kbd className="border-ground/30 bg-transparent text-ground shadow-none">[</Kbd>
              </span>
            }
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-controls="workspace-sidebar"
              aria-expanded={!sidebarCollapsed}
              onClick={toggleSidebar}
              className="-ml-2"
            >
              {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </Tooltip>
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-1.5 text-sm">
              <li className="min-w-0">
                <Link href={orgHref(workspace.slug, HOME_PATH)} className="block truncate rounded-md text-ink-3 transition-colors duration-150 ease-standard hover:text-ink" title={workspace.name}>
                  {workspace.name}
                </Link>
              </li>
              {section && (
                <>
                  <li aria-hidden className="text-line-strong">
                    <ChevronRight className="size-3.5" />
                  </li>
                  <li aria-current="page" className="shrink-0 font-medium text-ink">
                    {section.label}
                  </li>
                </>
              )}
            </ol>
          </nav>
        </div>
        {/* Mounted at every width, so its toasts always come; where room is short it is cut, never hidden. */}
        {activity && <p className="min-w-0 max-w-full truncate text-xs text-ink-3 lg:flex-1 lg:text-right">{activity}</p>}
        <StatusButton chips={chips} rows={rows} />
      </div>
    </header>
  );
}

const DOT: Record<StatusTone, string> = {
  quiet: "border border-ink-3",
  good: "bg-proof",
  mainnet: "bg-agent",
  shadow: "bg-agent",
  simulated: "border border-dashed border-ink-3",
  held: "bg-held",
  stopped: "bg-refused",
  unknown: "border border-line-strong",
};

const CHIP: Record<StatusTone, string> = {
  quiet: "border-line bg-surface text-ink-2",
  good: "border-line bg-surface text-ink-2",
  mainnet: "border-agent-line bg-agent-soft font-semibold text-agent",
  shadow: "border-agent-line bg-surface text-ink",
  simulated: "border-dashed border-line-strong bg-surface text-ink-2",
  held: "border-held-line bg-held-soft text-held",
  stopped: "border-refused-line bg-refused-soft text-refused",
  unknown: "border-line bg-surface text-ink-3",
};

function Dot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />;
}

function Chip({ chip }: { chip: StatusChip }) {
  return (
    <span className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium", CHIP[chip.tone])}>
      <Dot tone={chip.tone} />
      {chip.label}
    </span>
  );
}

/** The chips in a row, as the header's button holds them. */
export function StatusChipRow({ chips }: { chips: StatusChip[] }) {
  return (
    <>
      {chips.map((chip) => (
        <Chip key={chip.key} chip={chip} />
      ))}
    </>
  );
}

/** "Workspace status": one row per fact, each said in a sentence. */
export function StatusPanel({ rows }: { rows: StatusRow[] }) {
  return (
    <>
      <p className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Workspace status</p>
      <dl className="divide-y divide-line">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5">
            <dt className="pt-px text-xs text-ink-3">{row.label}</dt>
            <dd className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <Dot tone={row.tone} />
                {row.value}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{row.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The three chips as one button, and the panel it opens. */
function StatusButton({ chips, rows }: { chips: StatusChip[]; rows: StatusRow[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label={statusSummary(chips)}
          className="order-first -mx-1 h-auto min-h-9 max-w-full shrink-0 flex-wrap justify-start gap-1.5 rounded-2xl px-1 py-1 font-normal hover:bg-raised/50 sm:h-auto lg:order-none lg:ml-auto aria-expanded:bg-raised/70"
        >
          <StatusChipRow chips={chips} />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Workspace status" className="p-0">
        <StatusPanel rows={rows} />
      </PopoverContent>
    </Popover>
  );
}
