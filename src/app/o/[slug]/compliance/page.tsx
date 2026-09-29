import type { Metadata } from "next";
import Link from "next/link";
import AgentControls from "@/components/AgentControls";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { pad } from "@/components/vx/AuditLedger";
import { Money } from "@/components/vx/Primitives";
import { MoreLink } from "@/components/vx/Treasury";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { RiskDial } from "@/components/vx/RiskDial";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import type { RiskTier } from "@/components/vx/types";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesByDomain } from "@/lib/ledger";
import { listCounterparties, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("compliance") };

function riskTier(value: string): RiskTier {
  return value === "clear" || value === "medium" || value === "high" ? value : "unscreened";
}

export default async function CompliancePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
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
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("compliance")}
          sub="Continuous screening changes payment authority by tier. A hit reduces a limit; it does not silently turn the counterparty into a yes/no ban."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />

        {lastSweep && (
          <Callout tone={lastSweepComplete ? "proof" : "refused"} title="Latest continuous screening sweep" className="mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-ink">{lastSweep.summary}</p>
                {!lastSweepComplete && <p className="mt-1 text-xs text-refused">Incomplete — no failed lookup was treated as clear, and every previous verdict remains in force.</p>}
              </div>
              <MoreLink href={orgHref(slug, `/audit#seq-${lastSweep.seq}`)}>audit #{pad(lastSweep.seq)}</MoreLink>
            </div>
          </Callout>
        )}

        <section>
          <SectionHeader title="Counterparties" meta={`${counterparties.length} continuously screened`} />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {counterparties.map((counterparty) => (
              <Card key={counterparty.id} className="p-4 sm:p-5" tone={counterparty.risk_level === "high" ? "refused" : counterparty.risk_level === "medium" ? "held" : "default"}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-ink">{counterparty.name}</h2>
                    <p className="mt-0.5 text-sm capitalize text-ink-3">{counterparty.role}</p>
                  </div>
                  <Eyebrow>{counterparty.last_screened_at ? `Screened ${new Date(counterparty.last_screened_at).toLocaleString("en-US")}` : "Never screened"}</Eyebrow>
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
                  <Eyebrow>Screening evidence</Eyebrow>
                  <p className="mt-1 text-sm leading-relaxed text-ink-2">{counterparty.risk_notes ?? "No screening notes recorded."}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <SectionHeader title="Risk-level changes" meta="events where screening changed authority" action={<MoreLink href={orgHref(slug, "/audit?domain=compliance")}>Compliance audit</MoreLink>} />
          {riskChanges.length === 0 ? (
            <EmptyState compact title="No risk tier changed after initial screening" body="The sweep above still proves screening ran." />
          ) : (
            <Card asChild tone="held" className="overflow-hidden">
              <ol className="divide-y divide-line">
                {riskChanges.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-sm text-held">{entry.summary}</span>
                    <Link href={orgHref(slug, `/audit#seq-${entry.seq}`)} className="font-mono text-xs text-agent transition-colors duration-150 ease-standard hover:underline">
                      #{pad(entry.seq)}
                    </Link>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </section>
      </ProductShell>
    );
  });
}
