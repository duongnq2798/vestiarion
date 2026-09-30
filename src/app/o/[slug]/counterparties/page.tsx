import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money } from "@/components/vx/Primitives";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { listCounterparties, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("counterparties") };

const RISK_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  clear: "proof",
  medium: "held",
  high: "refused",
  unscreened: "neutral",
};

export default async function CounterpartiesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [counterparties, dashboardStats, entries, canWrite, canConfirm] = await Promise.all([
      listCounterparties(),
      stats(),
      listLedgerEntries(1),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "approval.decide"),
    ]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("counterparties")}
          sub="Add the people and businesses Vestiarion may invoice or pay. Each new record is screened immediately."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />

        <section className="mb-8">
          <SectionHeader title="Add counterparty" meta="human-entered · screened on submission" />
          {canWrite ? (
            <CounterpartyIntake orgSlug={slug} />
          ) : (
            <Callout>Only an owner or admin of this workspace can add counterparties.</Callout>
          )}
        </section>

        <section>
          <SectionHeader title="Counterparty book" meta={`${counterparties.length} records`} />
          {counterparties.length === 0 ? (
            <EmptyState
              compact
              title="No counterparties yet"
              body="Counterparties appear here once they are added. Each is screened as soon as it is saved."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {counterparties.map((counterparty) => (
                <Card asChild key={counterparty.id} className="min-w-0 p-4">
                  <article>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                          <span className="truncate">{counterparty.name}</span>
                          {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
                        </h3>
                        <p className="mt-0.5 text-xs capitalize text-ink-3">{counterparty.role} · {counterparty.chain || "chain not set"}</p>
                      </div>
                      <Badge size="sm" dot tone={RISK_TONE[counterparty.risk_level] ?? "neutral"} className="shrink-0 capitalize">
                        {counterparty.risk_level}
                      </Badge>
                    </div>
                    <PerformanceHistory
                      score={counterparty.performance_score}
                      inputs={counterparty.performance_inputs}
                      compact
                    />
                    <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs">
                      <div className="min-w-0">
                        <dt className="text-ink-3">Configured limit</dt>
                        <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-ink">
                          {counterparty.baseline_payment_limit == null ? "Not set" : <Money value={counterparty.baseline_payment_limit} />}
                          {canWrite && (
                            <CounterpartyLimitEdit
                              orgSlug={slug}
                              counterparty={{ id: counterparty.id, name: counterparty.name, role: counterparty.role, baselineLimit: counterparty.baseline_payment_limit }}
                            />
                          )}
                        </dd>
                      </div>
                      <div className="min-w-0"><dt className="text-ink-3">Current authority</dt><dd className="mt-0.5 text-ink">{counterparty.payment_limit == null ? "Not set" : <Money value={counterparty.payment_limit} />}</dd></div>
                      <div className="min-w-0"><dt className="text-ink-3">Jurisdiction</dt><dd className="mt-0.5 break-words text-ink">{counterparty.jurisdiction || "Not set"}</dd></div>
                      <div className="min-w-0"><dt className="text-ink-3">Last screened</dt><dd className="mt-0.5 break-words text-ink">{counterparty.last_screened_at ? new Date(counterparty.last_screened_at).toLocaleString() : "Not yet"}</dd></div>
                    </dl>
                    <CounterpartyAddress
                      orgSlug={slug}
                      counterparty={{ id: counterparty.id, name: counterparty.name, address: counterparty.address }}
                      unconfirmedSince={
                        addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at) ? counterparty.address_changed_at : null
                      }
                      canWrite={canWrite}
                      canConfirm={canConfirm}
                    />
                  </article>
                </Card>
              ))}
            </div>
          )}
        </section>
      </ProductShell>
    );
  });
}
