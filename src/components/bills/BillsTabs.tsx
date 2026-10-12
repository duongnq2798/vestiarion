"use client";

import Link, { useLinkStatus } from "next/link";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import type { BillsTab } from "@/lib/bills-view";
import { nextTabIndex } from "./tab-keys";

export interface BillsTabLink {
  key: BillsTab;
  label: string;
  href: string;
  /** A number beside the label, such as what needs a person. */
  count?: number;
}

export const tabId = (key: BillsTab) => `bills-tab-${key}`;
export const panelId = (key: BillsTab) => `bills-panel-${key}`;

/** A small mark while the tab's content is read from the server. */
function Pending() {
  const { pending } = useLinkStatus();
  return pending ? <Spinner className="size-3.5 text-ink-3" /> : null;
}

/**
 * Bills & receivables' three tabs (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B1, B2): WAI-ARIA tabs whose
 * tabs are links, so each is an address. Manual activation: Left and Right move focus (wrapping), Home and End go to the
 * ends, Enter or Space opens the tab, which the server renders. Only the tab shown is in the tab order.
 */
export function BillsTabs({ tabs, active, label = "Bills and receivables" }: { tabs: BillsTabLink[]; active: BillsTab; label?: string }) {
  const refs = useRef<Array<HTMLAnchorElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (event.key === " ") {
      // A link opens on Enter by itself; Space opens a tab too.
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="mb-5 inline-flex h-11 w-full max-w-full items-stretch gap-1 overflow-x-auto rounded-xl border border-line bg-raised/60 p-1 [scrollbar-width:none] sm:h-10 sm:w-fit"
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        return (
          <Link
            key={tab.key}
            ref={(element) => {
              refs.current[index] = element;
            }}
            href={tab.href}
            scroll={false}
            role="tab"
            id={tabId(tab.key)}
            aria-selected={selected}
            aria-controls={panelId(tab.key)}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors duration-150 ease-standard focus-visible:outline-offset-1 sm:flex-none",
              selected ? "border border-line bg-surface text-ink shadow-control" : "border border-transparent text-ink-2 hover:text-ink"
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && <span className="font-mono text-xs tabular-nums text-ink-3">{tab.count}</span>}
            <Pending />
          </Link>
        );
      })}
    </div>
  );
}
