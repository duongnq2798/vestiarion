import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { CounterpartyRow, readiness } from "@/components/CounterpartyRow";
import { AutoRefresh } from "@/components/AutoRefresh";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";
import ScreeningMatch from "@/components/intake/ScreeningMatch";
import PayeeLinkControl from "@/components/intake/PayeeLinkControl";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { Money } from "@/components/vx/Primitives";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { listActivePayeeLinks } from "@/lib/platform/payee-links";
import { plural } from "@/lib/copy";
import { listCounterparties, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("counterparties") };

export default async function CounterpartiesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    // A live match names the entity it matched, which Not this person dismisses (dismiss screening match R6).
    const liveScreening = screeningMode() === "live";
    const [counterparties, dashboardStats, entries, canWrite, canConfirm] = await Promise.all([
      listCounterparties(),
      stats(),
      listLedgerEntries(1),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "approval.decide"),
    ]);
    // Only those who may send a payee link see which ones are out.
    const payeeLinks = canWrite ? await listActivePayeeLinks(access.membership.orgId) : new Map<string, { id: string; expiresAt: string }>();
    // What needs someone first, then by name (Counterparties layout).
    const ordered = [...counterparties].sort((a, b) => readiness(a).rank - readiness(b).rank || a.name.localeCompare(b.name));
    const refreshMs = counterpartiesRefreshMs({
      linksOut: payeeLinks.size,
      unconfirmed: counterparties.filter((counterparty) => addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at)).length,
    });

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("counterparties")}
          sub="Add the people and businesses Vestiarion may invoice or pay. Each new record is screened immediately."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* A payee answers a link from another browser: re-read often while one is out or an address waits. */}
        <AutoRefresh intervalMs={refreshMs} />

        {canWrite ? (
          // Folded until it is needed; open on a workspace with no counterparty yet, where adding one is the next step.
          <IntakeFold label="Add counterparty" meta="human-entered · screened on submission" defaultOpen={counterparties.length === 0}>
            <CounterpartyIntake orgSlug={slug} framed={false} />
          </IntakeFold>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add counterparties.</Callout>
        )}

        <section>
          <SectionHeader title="Counterparty book" meta={`${counterparties.length} ${plural(counterparties.length, "record", "records")} · what needs someone first · open one for the rest`} />
          {counterparties.length === 0 ? (
            <EmptyState
              compact
              title="No counterparties yet"
              body="Counterparties appear here once they are added. Each is screened as soon as it is saved."
            />
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {ordered.map((counterparty) => (
                  <li key={counterparty.id}>
                    <CounterpartyRow counterparty={counterparty}>
                      <ScreeningMatch
                        orgSlug={slug}
                        counterparty={{
                          id: counterparty.id,
                          name: counterparty.name,
                          riskLevel: counterparty.risk_level,
                          riskNotes: counterparty.risk_notes,
                          riskEntityId: counterparty.risk_entity_id ?? null,
                        }}
                        canDismiss={canConfirm}
                        liveScreening={liveScreening}
                      />
                      <PerformanceHistory
                        score={counterparty.performance_score}
                        inputs={counterparty.performance_inputs}
                        compact
                      />
                      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs sm:grid-cols-4">
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
                        <div className="min-w-0"><dt className="text-ink-3" title="The configured limit as its screening allows it today">Allowed now</dt><dd className="mt-0.5 text-ink">{counterparty.payment_limit == null ? "Not set" : <Money value={counterparty.payment_limit} />}</dd></div>
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
                      {canWrite && counterparty.role !== "client" && (
                        <div className="mt-2">
                          <PayeeLinkControl
                            orgSlug={slug}
                            counterparty={{ id: counterparty.id, name: counterparty.name }}
                            activeLink={payeeLinks.get(counterparty.id) ?? null}
                          />
                        </div>
                      )}
                    </CounterpartyRow>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </ProductShell>
    );
  });
}
