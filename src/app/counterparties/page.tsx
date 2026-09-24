import AgentControls from "@/components/AgentControls";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import { Money, SectionHead } from "@/components/vx/Primitives";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { hasAgentControlSession } from "@/lib/agent-session";
import { listLedgerEntries } from "@/lib/ledger";
import { listCounterparties, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

const RISK_STYLE: Record<string, string> = {
  clear: "border-proof-line bg-proof-soft text-proof",
  medium: "border-held-line bg-held-soft text-held",
  high: "border-refused-line bg-refused-soft text-refused",
  unscreened: "border-line-strong text-ink-2",
};

export default async function CounterpartiesPage() {
  const [counterparties, dashboardStats, entries, canMutate] = await Promise.all([
    listCounterparties(),
    stats(),
    listLedgerEntries(1),
    hasAgentControlSession(),
  ]);

  return (
    <ProductShell active="counterparties" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt}>
      <PageHead
        title="Counterparties"
        sub="Add the people and businesses Vestiarion may invoice or pay. Each new record is screened immediately."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
      />

      <section className="mb-8">
        <SectionHead title="Add counterparty" meta="human-entered · screened on submission" />
        {canMutate ? (
          <CounterpartyIntake />
        ) : (
          <p className="rounded-lg border border-dashed border-line-strong px-5 py-6 text-sm text-ink-2">Unlock controls above to add a counterparty.</p>
        )}
      </section>

      <section>
        <SectionHead title="Counterparty book" meta={`${counterparties.length} records`} />
        <div className="grid gap-3 md:grid-cols-2">
          {counterparties.map((counterparty) => (
            <article key={counterparty.id} className="min-w-0 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-ink">{counterparty.name}</h3>
                  <p className="mt-0.5 text-xs capitalize text-ink-3">{counterparty.role} · {counterparty.chain || "chain not set"}</p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${RISK_STYLE[counterparty.risk_level] ?? RISK_STYLE.unscreened}`}>{counterparty.risk_level}</span>
              </div>
              <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs">
                <div className="min-w-0"><dt className="text-ink-3">Configured limit</dt><dd className="mt-0.5 text-ink">{counterparty.baseline_payment_limit == null ? "Not set" : <Money value={counterparty.baseline_payment_limit} />}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Current authority</dt><dd className="mt-0.5 text-ink">{counterparty.payment_limit == null ? "Not set" : <Money value={counterparty.payment_limit} />}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Jurisdiction</dt><dd className="mt-0.5 break-words text-ink">{counterparty.jurisdiction || "Not set"}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Last screened</dt><dd className="mt-0.5 break-words text-ink">{counterparty.last_screened_at ? new Date(counterparty.last_screened_at).toLocaleString() : "Not yet"}</dd></div>
              </dl>
              {counterparty.address && <p className="mt-3 truncate border-t border-line pt-3 font-mono text-[0.7rem] text-ink-3" title={counterparty.address}>{counterparty.address}</p>}
            </article>
          ))}
        </div>
      </section>
    </ProductShell>
  );
}
