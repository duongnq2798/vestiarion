import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { CounterpartyRow, readiness } from "@/components/CounterpartyRow";
import { AutoRefresh } from "@/components/AutoRefresh";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";
import CounterpartyNoticeEmailEdit from "@/components/intake/CounterpartyNoticeEmailEdit";
import CounterpartyPurchaseOrdersEdit from "@/components/intake/CounterpartyPurchaseOrdersEdit";
import MirrorAddressControl from "@/components/MirrorAddressControl";
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
import { shellModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { purchaseOrdersLabel } from "@/lib/counterparty-purchase-orders";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { listActivePayeeLinks } from "@/lib/platform/payee-links";
import { plural } from "@/lib/copy";
import { listCounterparties, stats } from "@/lib/queries";
import { readShadowMode } from "@/lib/shadow-mode";
import { workspaceNetwork } from "@/lib/workspace-network";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("counterparties") };

export default async function CounterpartiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ add?: string | string[] }>;
}) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  // `?add`, from an invoice with no counterparty to choose (Bills & receivables, From a document), opens Add counterparty.
  const adding = (await searchParams).add !== undefined;
  return inOrg(access, async () => {
    const network = workspaceNetwork().id;
    // A live match names the entity it matched, which Not this person dismisses (dismiss screening match R6).
    const liveScreening = screeningMode() === "live";
    const [counterparties, dashboardStats, entries, canWrite, canConfirm, shadow] = await Promise.all([
      listCounterparties(),
      stats(),
      listLedgerEntries(1),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "approval.decide"),
      // In shadow mode a payee with no Arc address can be given a mirror address (shadow mode S7), and a new supplier is
      // asked whether it sends purchase orders. Best effort.
      readShadowMode(db()).catch((error: unknown) => {
        console.error("counterparties: shadow mode not read", error instanceof Error ? error.message : error);
        return null;
      }),
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
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("counterparties")}
          sub="Add the people and businesses Vestiarion may invoice or pay. Each new record is screened immediately."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* A payee answers a link from another browser: re-read often while one is out or an address waits. */}
        <AutoRefresh intervalMs={refreshMs} />

        {canWrite ? (
          // Folded until it is needed; open on a workspace with no counterparty yet, where adding one is the next step,
          // or when a link asks for it.
          <IntakeFold label="Add counterparty" meta="human-entered · screened on submission" defaultOpen={counterparties.length === 0 || adding}>
            <CounterpartyIntake orgSlug={slug} framed={false} network={network} askPurchaseOrders={shadow !== null} />
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
                    <CounterpartyRow counterparty={counterparty} network={network}>
                      <ScreeningMatch
                        orgSlug={slug}
                        counterparty={{
                          id: counterparty.id,
                          name: counterparty.name,
                          riskLevel: counterparty.risk_level,
                          riskNotes: counterparty.risk_notes,
                          riskEntityId: counterparty.risk_entity_id ?? null,
                          matches: counterparty.risk_matches ?? null,
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
                        {/* A payee is emailed when it is paid, a client the reminders turned on, at the address set here
                            (payment notices R1, collections R8). */}
                        <div className="col-span-2 min-w-0">
                          <dt className="text-ink-3">Billing email</dt>
                          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 break-words text-ink">
                            {counterparty.notice_email ?? "None"}
                            {canWrite && (
                              <CounterpartyNoticeEmailEdit
                                network={network}
                                orgSlug={slug}
                                counterparty={{ id: counterparty.id, name: counterparty.name, role: counterparty.role, noticeEmail: counterparty.notice_email ?? null }}
                              />
                            )}
                          </dd>
                        </div>
                        {/* Whether the agent needs a purchase order before it pays (three-way match design M2). A payable to a
                            client waits for a person whatever its match (client payables R1). */}
                        {counterparty.role !== "client" && (
                          <div className="col-span-2 min-w-0">
                            <dt className="text-ink-3">Purchase orders</dt>
                            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 break-words text-ink">
                              {purchaseOrdersLabel(counterparty.purchase_order_required !== false)}
                              {canWrite && (
                                <CounterpartyPurchaseOrdersEdit
                                  orgSlug={slug}
                                  counterparty={{ id: counterparty.id, name: counterparty.name, purchaseOrderRequired: counterparty.purchase_order_required !== false }}
                                />
                              )}
                            </dd>
                          </div>
                        )}
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
                      {counterparty.mirror_wallet_id && (
                        <p className="mt-1 text-xs text-ink-3">Mirror address: a wallet Vestiarion made for this payee on Arc testnet, in shadow mode.</p>
                      )}
                      {shadow && canWrite && counterparty.role !== "client" && !counterparty.address && (
                        <div className="mt-2">
                          <MirrorAddressControl orgSlug={slug} counterparty={{ id: counterparty.id, name: counterparty.name }} />
                        </div>
                      )}
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
