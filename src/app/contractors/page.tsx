import AgentControls from "@/components/AgentControls";
import { listMilestones } from "@/lib/queries";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const statusStyles: Record<string, string> = {
  pending: "bg-neutral-800 text-neutral-300",
  verified: "bg-sky-950 text-sky-300",
  paid: "bg-emerald-950 text-emerald-300",
  held: "bg-amber-950 text-amber-300",
};

export default async function ContractorsPage() {
  const milestones = await listMilestones();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-50">Contractor & Vendor Network</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Milestone pay follows the work instead of a Net-30 calendar — the agent releases
            payment the same day a milestone is verified against its source of truth.
          </p>
        </div>
        <AgentControls />
      </div>

      <div className="flex flex-col gap-3">
        {milestones.map((m) => (
          <div key={m.id} className="rounded-lg border border-neutral-800 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium text-neutral-100">{m.contractor_name}</span>
                <span className="ml-2 text-neutral-500">{m.title}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-neutral-100">${fmt(m.amount)}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    statusStyles[m.status] ?? "bg-neutral-800 text-neutral-300"
                  }`}
                >
                  {m.status}
                </span>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-neutral-500">
              <span>Verification: {m.verification_source ?? "none"}</span>
              <span>Verified: {m.verified ? "yes" : "not yet"}</span>
              {m.tx_ref && <span>Tx: {m.tx_ref}</span>}
            </div>
            {m.agent_reasoning && (
              <p className="mt-2 border-l-2 border-neutral-700 pl-3 text-sm text-neutral-300">
                {m.agent_reasoning}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
