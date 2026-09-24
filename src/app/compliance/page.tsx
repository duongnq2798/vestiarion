import AgentControls from "@/components/AgentControls";
import { listCounterparties } from "@/lib/queries";

export const dynamic = "force-dynamic";

const riskStyles: Record<string, string> = {
  unscreened: "bg-neutral-800 text-neutral-400",
  clear: "bg-emerald-950 text-emerald-300",
  medium: "bg-amber-950 text-amber-300",
  high: "bg-rose-950 text-rose-300",
};

export default async function CompliancePage() {
  const counterparties = await listCounterparties();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-50">Compliance Intelligence</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Continuous screening, not a one-time gate: every counterparty is re-checked on each
            agent cycle, and a hit tiers the payment limit down instead of a blunt refusal.
          </p>
        </div>
        <AgentControls />
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-normal">Counterparty</th>
              <th className="px-4 py-2 font-normal">Role</th>
              <th className="px-4 py-2 font-normal">Risk</th>
              <th className="px-4 py-2 font-normal">Payment limit</th>
              <th className="px-4 py-2 font-normal">Last screened</th>
              <th className="px-4 py-2 font-normal">Notes</th>
            </tr>
          </thead>
          <tbody>
            {counterparties.map((c) => (
              <tr key={c.id} className="border-t border-neutral-800 align-top">
                <td className="px-4 py-2 text-neutral-100">{c.name}</td>
                <td className="px-4 py-2 text-neutral-400">{c.role}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      riskStyles[c.risk_level] ?? riskStyles.unscreened
                    }`}
                  >
                    {c.risk_level}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-neutral-300">
                  {c.payment_limit != null ? `$${c.payment_limit.toLocaleString()}` : "—"}
                </td>
                <td className="px-4 py-2 text-neutral-500">
                  {c.last_screened_at ? new Date(c.last_screened_at).toLocaleString() : "never"}
                </td>
                <td className="px-4 py-2 text-neutral-400">{c.risk_notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
