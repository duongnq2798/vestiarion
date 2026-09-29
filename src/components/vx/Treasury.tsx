import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money, Reasoning } from "./Primitives";
import type { Account, Forecast } from "./types";

/** One figure with its label: a card, and a lifting one when it links to the page behind the number. */
export function StatTile({
  label,
  children,
  sub,
  tone = "default",
  href,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "held";
  href?: string;
}) {
  const content = (
    <>
      <Eyebrow className={tone === "held" ? "text-held" : undefined}>{label}</Eyebrow>
      <div className="mt-2 min-w-0 text-[1.375rem] font-semibold leading-none tracking-tight text-ink sm:text-[1.625rem]">{children}</div>
      {sub && <div className="mt-2 text-[0.8125rem] leading-snug text-ink-2">{sub}</div>}
    </>
  );
  const className = cn("block min-w-0 px-4 py-4", tone === "held" && "bg-held-soft");
  return href ? (
    <Card asChild interactive tone={tone} className={className}>
      <Link href={href}>{content}</Link>
    </Card>
  ) : (
    <Card tone={tone} className={className}>
      {content}
    </Card>
  );
}

/**
 * The balance tile's label and sub-line, pinned as a pure function: a
 * sandbox workspace's funds are simulated money end to end, so it always
 * gets the fixed sandbox wording, regardless of the simulated reserve
 * amount. A live workspace keeps the on-chain label, and defers to the
 * caller's own sub-line (the simulated-reserve note, which needs the `Money`
 * component) by returning `sub: null` when there is a simulated reserve to
 * mention.
 */
export function balanceTileCopy(mode: "sandbox" | "live", simulatedReserve: number): { label: string; sub: string | null } {
  if (mode === "sandbox") {
    return { label: "Balance (simulated)", sub: "Sandbox workspace: these funds are simulated, nothing is on-chain" };
  }
  return { label: "Balance on-chain", sub: simulatedReserve > 0 ? null : "All funds shown are on-chain" };
}

export function BalanceTile({ accounts, mode }: { accounts: Account[]; mode: "sandbox" | "live" }) {
  const live = accounts.filter((account) => !account.simulated).reduce((sum, account) => sum + account.balance, 0);
  const simulated = accounts.filter((account) => account.simulated).reduce((sum, account) => sum + account.balance, 0);
  const copy = balanceTileCopy(mode, simulated);
  return (
    <StatTile
      label={copy.label}
      sub={
        copy.sub ?? (
          <span>
            + <Money value={simulated} token="USYC" simulated className="text-ink-2" /> in the simulated reserve, not counted above
          </span>
        )
      }
    >
      <Money value={live} />
    </StatTile>
  );
}

export function AccountsList({ accounts }: { accounts: Account[] }) {
  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader title="Accounts" meta={`${accounts.length} held`} />
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {accounts.map((account) => (
            <li key={account.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 sm:px-5", account.simulated && "hatch")}>
              <span className="min-w-0 truncate text-sm font-medium text-ink">{account.name}</span>
              <Money value={account.balance} token={account.token} simulated={account.simulated} className="text-right text-[0.9375rem] text-ink" />
              <span className="min-w-0 truncate font-mono text-xs text-ink-3">
                {account.chain} · {account.token}
                {account.simulated && <span className="ml-2 text-ink-2">simulated</span>}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-ink-3">{account.apy && account.apy > 0 ? `${(account.apy * 100).toFixed(2)}% APY` : "—"}</span>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

export function ForecastPanel({ forecast }: { forecast: Forecast }) {
  const projected = forecast.liquid + forecast.inflow - forecast.outflow;
  const maximum = Math.max(forecast.liquid, forecast.inflow, forecast.outflow, Math.abs(projected), 0.000001);
  const rows: Array<{ label: string; value: number; sign?: "+" | "−"; bar: string }> = [
    { label: "Liquid now", value: forecast.liquid, bar: "bg-ink-3" },
    { label: "Expected in", value: forecast.inflow, sign: "+", bar: "bg-ink-2" },
    { label: "Committed out", value: forecast.outflow, sign: "−", bar: "bg-line-strong" },
  ];
  const shortfall = projected < 0;

  return (
    <Card asChild>
      <section>
        <CardContent className="p-4 sm:p-5">
          <SectionHeader title="Cash forecast" meta={`next ${forecast.horizonDays} days`} />
          <dl className="space-y-2.5">
            {rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
                <dt className="text-[0.8125rem] text-ink-2">{row.label}</dt>
                <div className="h-1.5 rounded-full bg-raised">
                  <div className={cn("h-full rounded-full", row.bar)} style={{ width: `${(row.value / maximum) * 100}%` }} />
                </div>
                <dd className="text-right text-sm text-ink">
                  <Money value={row.value} sign={row.sign} />
                </dd>
              </div>
            ))}
            <div className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 border-t border-line pt-2.5 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
              <dt className={cn("text-[0.8125rem] font-medium", shortfall ? "text-held" : "text-ink")}>Projected</dt>
              <span />
              <dd className={cn("text-right text-base font-semibold", shortfall ? "text-held" : "text-ink")}>
                <Money value={projected} sign={shortfall ? "−" : undefined} />
              </dd>
            </div>
          </dl>
          {forecast.recommendation && (
            <Callout tone="agent" title="Agent recommends" className="mt-4">
              <Reasoning text={forecast.recommendation} className="text-[0.9375rem]" />
            </Callout>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

/** A text link to the page behind a section, with an arrow. */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="link" className="text-[0.8125rem]">
      <Link href={href}>
        {children}
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  );
}
