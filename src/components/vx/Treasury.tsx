import type { ReactNode } from "react";
import type { Account, Forecast } from "./types";
import { ArrowGlyph } from "./Glyphs";
import { Card, Label, Money, Reasoning, SectionHead } from "./Primitives";

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
      <Label className={tone === "held" ? "text-held" : undefined}>{label}</Label>
      <div className="mt-2 min-w-0 text-[1.375rem] font-semibold leading-none tracking-tight text-ink sm:text-[1.625rem]">{children}</div>
      {sub && <div className="mt-2 text-[0.8125rem] leading-snug text-ink-2">{sub}</div>}
    </>
  );
  const className = `surface-shadow block min-w-0 rounded-xl border px-4 py-4 ${tone === "held" ? "border-held-line bg-held-soft" : "border-line bg-surface"} ${href ? "transition-all hover:-translate-y-0.5 hover:border-agent-line" : ""}`;
  return href ? <a href={href} className={className}>{content}</a> : <div className={className}>{content}</div>;
}

export function BalanceTile({ accounts }: { accounts: Account[] }) {
  const live = accounts.filter((account) => !account.simulated).reduce((sum, account) => sum + account.balance, 0);
  const simulated = accounts.filter((account) => account.simulated).reduce((sum, account) => sum + account.balance, 0);
  return (
    <StatTile
      label="Balance on-chain"
      sub={simulated > 0 ? <span>+ <Money value={simulated} token="USYC" simulated className="text-ink-2" /> in the simulated reserve, not counted above</span> : "All funds shown are on-chain"}
    >
      <Money value={live} />
    </StatTile>
  );
}

export function AccountsList({ accounts }: { accounts: Account[] }) {
  return (
    <Card>
      <div className="px-4 pt-4 sm:px-5"><SectionHead title="Accounts" meta={`${accounts.length} held`} /></div>
      <ul className="divide-y divide-line border-t border-line">
        {accounts.map((account) => (
          <li key={account.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 sm:px-5 ${account.simulated ? "hatch" : ""}`}>
            <span className="min-w-0 truncate text-sm font-medium text-ink">{account.name}</span>
            <Money value={account.balance} token={account.token} simulated={account.simulated} className="text-right text-[0.9375rem] text-ink" />
            <span className="min-w-0 truncate font-mono text-xs text-ink-3">{account.chain} · {account.token}{account.simulated && <span className="ml-2 text-ink-2">simulated</span>}</span>
            <span className="text-right font-mono text-xs tabular-nums text-ink-3">{account.apy && account.apy > 0 ? `${(account.apy * 100).toFixed(2)}% APY` : "—"}</span>
          </li>
        ))}
      </ul>
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
    <Card>
      <div className="p-4 sm:p-5">
        <SectionHead title="Cash forecast" meta={`next ${forecast.horizonDays} days`} />
        <dl className="space-y-2.5">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
              <dt className="text-[0.8125rem] text-ink-2">{row.label}</dt>
              <div className="h-1.5 rounded-full bg-raised"><div className={`h-full rounded-full ${row.bar}`} style={{ width: `${(row.value / maximum) * 100}%` }} /></div>
              <dd className="text-right text-sm text-ink"><Money value={row.value} sign={row.sign} /></dd>
            </div>
          ))}
          <div className="grid grid-cols-[6.5rem_minmax(1.5rem,1fr)_auto] items-center gap-2 border-t border-line pt-2.5 sm:grid-cols-[7.5rem_1fr_auto] sm:gap-3">
            <dt className={`text-[0.8125rem] font-medium ${shortfall ? "text-held" : "text-ink"}`}>Projected</dt>
            <span />
            <dd className={`text-right text-base font-semibold ${shortfall ? "text-held" : "text-ink"}`}><Money value={projected} sign={shortfall ? "−" : undefined} /></dd>
          </div>
        </dl>
        {forecast.recommendation && (
          <div className="mt-4 rounded-md bg-agent-soft px-3.5 py-3">
            <Label className="text-agent">Agent recommends</Label>
            <Reasoning text={forecast.recommendation} className="mt-1 text-[0.9375rem]" />
          </div>
        )}
      </div>
    </Card>
  );
}

export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className="inline-flex items-center gap-1 text-[0.8125rem] text-agent hover:underline">{children}<ArrowGlyph /></a>;
}
