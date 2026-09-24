import Link from "next/link";
import type { ReactNode } from "react";
import { getChainProvider } from "@/lib/circle";
import { stats } from "@/lib/queries";
import { screeningMode } from "@/lib/compliance";
import { Label } from "./Primitives";
import { ProvenanceBar, type ProvenanceLeg } from "./Provenance";

const NAV = [
  { key: "treasury", href: "/", label: "Treasury" },
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
  children,
}: {
  active: NavKey;
  day?: number;
  children: ReactNode;
}) {
  const currentDay = day ?? (await stats()).day;
  const provider = getChainProvider();
  const legs: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: provider.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: provider.earnMode === "live" },
    { label: "Screening", detail: screeningMode() === "live" ? "OpenSanctions" : "bundled list", live: screeningMode() === "live" },
  ];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-0 pt-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-baseline gap-3">
                <span className="text-[0.8125rem] font-semibold uppercase tracking-[0.22em] text-ink">Vestiarion</span>
                <Label>Day {currentDay}</Label>
              </div>
              <p className="mt-1 truncate text-sm text-ink-2">{process.env.BUSINESS_NAME?.trim() || "Vestiarion workspace"}</p>
            </div>
            <ProvenanceBar legs={legs} />
          </div>
          <nav aria-label="Sections" className="no-scrollbar -mb-px flex gap-5 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={item.key === active ? "page" : undefined}
                className={`shrink-0 border-b-2 pb-2.5 text-sm ${item.key === active ? "border-agent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 pt-2 text-center font-mono text-xs text-ink-3 sm:px-6">
        Hash-chained decisions · Ed25519 signed · Arc testnet
      </footer>
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-5 py-8 sm:px-8 sm:py-10">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 max-w-prose text-sm leading-relaxed text-ink-2">{body}</div>
    </div>
  );
}
