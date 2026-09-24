import Link from "next/link";
import type { ReactNode } from "react";
import { getChainProvider } from "@/lib/circle";
import { stats } from "@/lib/queries";
import { screeningMode } from "@/lib/compliance";
import type { CycleClockMode } from "@/lib/clock";
import { Label } from "./Primitives";
import { ProvenanceBar, type ProvenanceLeg } from "./Provenance";
import { BrandMark } from "./Brand";

const NAV = [
  { key: "treasury", href: "/console", label: "Treasury" },
  { key: "insights", href: "/insights", label: "Insights" },
  { key: "invoices", href: "/invoices", label: "AP / AR" },
  { key: "counterparties", href: "/counterparties", label: "Counterparties" },
  { key: "contractors", href: "/contractors", label: "Contractors" },
  { key: "compliance", href: "/compliance", label: "Compliance" },
  { key: "audit", href: "/audit", label: "Audit log" },
] as const;

export type NavKey = (typeof NAV)[number]["key"];

export async function ProductShell({
  active,
  day,
  clockMode,
  lastCycleAt,
  children,
}: {
  active: NavKey;
  day?: number;
  clockMode?: CycleClockMode;
  lastCycleAt?: string | null;
  children: ReactNode;
}) {
  const fallbackStats = day == null || clockMode == null || lastCycleAt === undefined ? await stats() : null;
  const currentDay = day ?? fallbackStats?.day ?? 0;
  const currentClockMode = clockMode ?? fallbackStats?.clockMode ?? "simulate";
  const currentLastCycleAt = lastCycleAt === undefined ? fallbackStats?.lastCycleAt ?? null : lastCycleAt;
  const provider = getChainProvider();
  const legs: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: provider.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: provider.earnMode === "live" },
    { label: "Screening", detail: screeningMode() === "live" ? "OpenSanctions" : "bundled list", live: screeningMode() === "live" },
  ];

  return (
    <div className="min-h-dvh bg-transparent">
      <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-0 pt-4 sm:px-6 sm:pt-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-baseline gap-3">
                <Link href="/" className="group inline-flex items-center gap-2.5 text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink hover:text-agent">
                  <BrandMark className="brand-shadow size-8 shrink-0 text-agent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
                  <span>Vestiarion</span>
                </Link>
                <Label>{currentClockMode === "simulate" ? `Day ${currentDay}` : "Wall clock"}</Label>
              </div>
              <p className="mt-2 truncate text-sm font-medium text-ink-2">{process.env.BUSINESS_NAME?.trim() || "Vestiarion workspace"}</p>
              <p className="mt-0.5 text-xs text-ink-3">{currentLastCycleAt ? `Last cycle ${new Date(currentLastCycleAt).toLocaleString()}` : "No cycle recorded yet"}</p>
            </div>
            <ProvenanceBar legs={legs} />
          </div>
          <nav aria-label="Sections" className="no-scrollbar -mb-px flex gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={item.key === active ? "page" : undefined}
                className={`shrink-0 rounded-t-md border-b-2 px-3 pb-2.5 pt-2 text-sm transition-colors ${item.key === active ? "border-agent bg-agent-soft/70 font-semibold text-agent" : "border-transparent text-ink-2 hover:bg-raised/70 hover:text-ink"}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-center font-mono text-xs text-ink-3 sm:px-6">
        <span className="rounded-full border border-line bg-surface/80 px-3 py-1.5">Hash-chained decisions · Ed25519 signed · Arc testnet</span>
      </footer>
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-ink">{title}</h1>
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
