import AgentControls from "@/components/AgentControls";
import { listAccounts, listTreasuryActions, latestForecast, stats } from "@/lib/queries";
import { getChainProvider } from "@/lib/circle";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function DashboardPage() {
  const [accounts, actions, forecast, s] = await Promise.all([
    listAccounts(),
    listTreasuryActions(),
    latestForecast(),
    stats(),
  ]);
  const provider = getChainProvider();
  const totalLiquid = accounts.reduce((sum, a) => sum + a.balance, 0);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-50">Treasury Overview</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Northstar Studio · day {s.day} · payments:{" "}
              <span className={provider.mode === "live" ? "text-emerald-400" : "text-amber-400"}>
                {provider.mode === "live" ? "Arc testnet (live)" : "simulated"}
              </span>
              {" · "}yield:{" "}
              <span className={provider.earnMode === "live" ? "text-emerald-400" : "text-amber-400"}>
                {provider.earnMode === "live" ? "USYC (live)" : "simulated"}
              </span>
            </p>
          </div>
          <AgentControls />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total balance (USDC-eq)" value={`$${fmt(totalLiquid)}`} />
        <StatCard label="Agent decisions logged" value={s.decisionsLogged.toString()} />
        <StatCard
          label="Paid out to date"
          value={`$${fmt(s.totalPaidOut)}`}
          hint={s.onchainTransfers > 0 ? `${s.onchainTransfers} on-chain` : undefined}
        />
        <StatCard label="Flagged for review" value={s.flagged.toString()} tone={s.flagged > 0 ? "warn" : "ok"} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-neutral-100">Accounts</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Account</th>
                <th className="px-4 py-2 font-normal">Chain</th>
                <th className="px-4 py-2 font-normal">Token</th>
                <th className="px-4 py-2 font-normal text-right">Balance</th>
                <th className="px-4 py-2 font-normal text-right">APY</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-neutral-800">
                  <td className="px-4 py-2 text-neutral-100">{a.name}</td>
                  <td className="px-4 py-2 text-neutral-400">{a.chain}</td>
                  <td className="px-4 py-2 text-neutral-400">{a.token}</td>
                  <td className="px-4 py-2 text-right font-mono text-neutral-100">${fmt(a.balance)}</td>
                  <td className="px-4 py-2 text-right text-neutral-400">
                    {a.apy > 0 ? `${(a.apy * 100).toFixed(2)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {forecast && (
        <section>
          <h2 className="mb-3 text-lg font-medium text-neutral-100">
            14-Day Cash Flow Forecast
          </h2>
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-neutral-800 p-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase text-neutral-500">Projected inflow</div>
              <div className="mt-1 font-mono text-lg text-emerald-400">
                +${fmt(forecast.projected_inflow)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">Projected outflow</div>
              <div className="mt-1 font-mono text-lg text-rose-400">
                -${fmt(forecast.projected_outflow)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">Liquid balance</div>
              <div className="mt-1 font-mono text-lg text-neutral-100">
                ${fmt(forecast.liquid_balance)}
              </div>
            </div>
          </div>
          {forecast.recommendation && (
            <p className="mt-2 text-sm text-neutral-400">{forecast.recommendation}</p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-medium text-neutral-100">Recent Treasury Actions</h2>
        {actions.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No sweeps or redemptions yet — run an agent cycle to see the treasury allocate idle
            cash into USYC.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {actions.map((a) => (
              <li key={a.id} className="rounded-lg border border-neutral-800 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-neutral-100">
                    {a.action === "sweep_to_usyc" ? "Sweep → USYC" : "Redeem ← USYC"}: $
                    {fmt(a.amount)}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-neutral-400">{a.reasoning}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold ${
          tone === "warn" ? "text-amber-400" : "text-neutral-50"
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-emerald-400">{hint}</div>}
    </div>
  );
}
