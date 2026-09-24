import AgentControls from "@/components/AgentControls";
import { Card, Label, Money, SectionHead } from "@/components/vx/Primitives";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { RiskDial } from "@/components/vx/RiskDial";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import type { RiskTier } from "@/components/vx/types";
import { listLedgerEntries, listLedgerEntriesByDomain } from "@/lib/ledger";
import { listCounterparties, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

function riskTier(value: string): RiskTier {
  return value === "clear" || value === "medium" || value === "high" ? value : "unscreened";
}

export default async function CompliancePage() {
  const [counterparties, entries, headEntries, dashboardStats] = await Promise.all([
    listCounterparties(),
    listLedgerEntriesByDomain("compliance", 100),
    listLedgerEntries(1),
    stats(),
  ]);
  const lastSweep = entries.find((entry) => entry.action === "compliance_sweep");
  const lastSweepComplete = lastSweep?.detail.complete !== false;
  const riskChanges = entries.filter((entry) => entry.action === "risk_level_changed").slice(0, 5);

  return (
    <ProductShell active="compliance" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt}>
      <PageHead
        title="Compliance"
        sub="Continuous screening changes payment authority by tier. A hit reduces a limit; it does not silently turn the counterparty into a yes/no ban."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
      />

      {lastSweep && (
        <section className={`hatch mb-6 rounded-lg border border-dashed px-4 py-3 ${lastSweepComplete ? "border-line-strong" : "border-refused-line bg-refused-wash"}`} aria-label="Latest screening sweep">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Label>Latest continuous screening sweep</Label>
              <p className="mt-1 text-sm text-ink">{lastSweep.summary}</p>
              {!lastSweepComplete && <p className="mt-1 text-xs text-refused">Incomplete — no failed lookup was treated as clear, and every previous verdict remains in force.</p>}
            </div>
            <a href={`/audit#seq-${lastSweep.seq}`} className="font-mono text-xs text-agent hover:underline">audit #{String(lastSweep.seq).padStart(4, "0")} →</a>
          </div>
        </section>
      )}

      <section>
        <SectionHead title="Counterparties" meta={`${counterparties.length} continuously screened`} />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {counterparties.map((counterparty) => (
            <Card key={counterparty.id} className="p-4 sm:p-5" tone={counterparty.risk_level === "high" ? "refused" : counterparty.risk_level === "medium" ? "held" : "default"}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-ink">{counterparty.name}</h2>
                  <p className="mt-0.5 text-sm capitalize text-ink-3">{counterparty.role}</p>
                </div>
                <Label>{counterparty.last_screened_at ? `Screened ${new Date(counterparty.last_screened_at).toLocaleString("en-US")}` : "Never screened"}</Label>
              </div>
              <div className="mt-4 border-y border-line py-3">
                <RiskDial risk={riskTier(counterparty.risk_level)} baseline={counterparty.baseline_payment_limit} effective={counterparty.payment_limit} />
                <PerformanceHistory
                  score={counterparty.performance_score}
                  inputs={counterparty.performance_inputs}
                />
                {counterparty.baseline_payment_limit != null && counterparty.payment_limit != null && (
                  <p className="mt-2 text-xs text-ink-3">
                    Business baseline <Money value={counterparty.baseline_payment_limit} /> · screened authority <Money value={counterparty.payment_limit} />
                  </p>
                )}
              </div>
              <div className="mt-3">
                <Label>Screening evidence</Label>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{counterparty.risk_notes ?? "No screening notes recorded."}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <SectionHead title="Risk-level changes" meta="events where screening changed authority" action={<a href="/audit?domain=compliance" className="text-[0.8125rem] text-agent hover:underline">Compliance audit →</a>} />
        {riskChanges.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-2">No risk tier changed after initial screening. The sweep above still proves screening ran.</p>
        ) : (
          <ol className="divide-y divide-line rounded-lg border border-held-line bg-surface">
            {riskChanges.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-held">{entry.summary}</span>
                <a href={`/audit#seq-${entry.seq}`} className="font-mono text-xs text-agent hover:underline">#{String(entry.seq).padStart(4, "0")}</a>
              </li>
            ))}
          </ol>
        )}
      </section>
    </ProductShell>
  );
}
