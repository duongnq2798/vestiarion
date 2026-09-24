import AgentControls from "@/components/AgentControls";
import { listInvoices } from "@/lib/queries";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const statusStyles: Record<string, string> = {
  pending: "bg-neutral-800 text-neutral-300",
  matched: "bg-sky-950 text-sky-300",
  paid: "bg-emerald-950 text-emerald-300",
  held: "bg-amber-950 text-amber-300",
  flagged: "bg-rose-950 text-rose-300",
  awaiting_info: "bg-amber-950 text-amber-300",
  received: "bg-emerald-950 text-emerald-300",
};

export default async function InvoicesPage() {
  const invoices = await listInvoices();
  const payable = invoices.filter((i) => i.direction === "payable");
  const receivable = invoices.filter((i) => i.direction === "receivable");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-50">AP / AR Automation</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Three-way match (PO ↔ goods received ↔ invoice) plus risk screening decide pay,
            hold, request info, or flag as fraud — with the agent&apos;s reasoning attached to
            every line.
          </p>
        </div>
        <AgentControls />
      </div>

      <Section title="Payable (AP)" rows={payable} />
      <Section title="Receivable (AR)" rows={receivable} />
    </div>
  );
}

function Section({
  title,
  rows,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof listInvoices>>;
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium text-neutral-100">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing here.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((inv) => (
            <div key={inv.id} className="rounded-lg border border-neutral-800 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-neutral-100">{inv.counterparty_name}</span>
                  <span className="ml-2 text-neutral-500">{inv.memo}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-neutral-100">${fmt(inv.amount)}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      statusStyles[inv.status] ?? "bg-neutral-800 text-neutral-300"
                    }`}
                  >
                    {inv.status.replace("_", " ")}
                  </span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-neutral-500">
                <span>PO: {inv.po_reference ?? "none on file"}</span>
                <span>Goods received: {inv.goods_received ? "yes" : "no"}</span>
                {inv.tx_ref && !inv.tx_ref.startsWith("sim_") && (
                  <span className="text-emerald-400">on-chain</span>
                )}
                <span>Due: {new Date(inv.due_date).toLocaleDateString()}</span>
                {inv.tx_ref && <span>Tx: {inv.tx_ref}</span>}
              </div>
              {inv.agent_reasoning && (
                <p className="mt-2 border-l-2 border-neutral-700 pl-3 text-sm text-neutral-300">
                  {inv.agent_reasoning}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
