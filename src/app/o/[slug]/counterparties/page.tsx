import { ChevronRight, Plus } from "lucide-react";
import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { AutoRefresh } from "@/components/AutoRefresh";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";
import ScreeningMatch from "@/components/intake/ScreeningMatch";
import PayeeLinkControl from "@/components/intake/PayeeLinkControl";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money, shortHash } from "@/components/vx/Primitives";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { listActivePayeeLinks } from "@/lib/platform/payee-links";
import { listCounterparties, stats, type CounterpartyRow } from "@/lib/queries";
import { payeeChain } from "@/lib/payee-chains";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("counterparties") };

const RISK_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  clear: "proof",
  medium: "held",
  high: "refused",
  unscreened: "neutral",
};

/** What a counterparty needs before the agent can pay it, worst first (Counterparties layout). */
type Readiness = { label: string; tone: NonNullable<BadgeProps["tone"]>; rank: number };

function readiness(counterparty: CounterpartyRow): Readiness {
  if ((counterparty.risk_level === "medium" || counterparty.risk_level === "high") && counterparty.risk_notes) return { label: "Review match", tone: "held", rank: 0 };
  if (addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at)) return { label: "Confirm address", tone: "held", rank: 1 };
  if (counterparty.role !== "client" && !counterparty.address) return { label: "Address needed", tone: "held", rank: 2 };
  if (counterparty.role === "client") return { label: "Client", tone: "neutral", rank: 4 };
  return { label: "Ready to pay", tone: "proof", rank: 3 };
}

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
          <Disclosure
            className="mb-8"
            defaultOpen={counterparties.length === 0}
            summary={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <Plus aria-hidden className="size-4" />
                  Add counterparty
                </span>
                <span className="text-[0.8125rem] font-normal text-ink-3">human-entered · screened on submission</span>
              </span>
            }
          >
            <CounterpartyIntake orgSlug={slug} />
          </Disclosure>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add counterparties.</Callout>
        )}

        <section>
          <SectionHeader title="Counterparty book" meta={`${counterparties.length} records · what needs someone first · open one for the rest`} />
          {counterparties.length === 0 ? (
            <EmptyState
              compact
              title="No counterparties yet"
              body="Counterparties appear here once they are added. Each is screened as soon as it is saved."
            />
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {ordered.map((counterparty) => {
                  const ready = readiness(counterparty);
                  return (
                    <li key={counterparty.id}>
                      <Disclosure
                        variant="bare"
                        summaryClassName="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 md:grid-cols-[minmax(0,1fr)_6rem_7rem_9rem_8rem_1rem] sm:px-5"
                        summary={
                          <>
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                                <span className="truncate">{counterparty.name}</span>
                                {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
                              </span>
                              <span className="block truncate text-xs text-ink-3">
                                <span className="capitalize">{counterparty.role}</span> · {payeeChain(counterparty.chain).label}
                              </span>
                            </span>
                            <span className="hidden md:block">
                              <Badge size="sm" dot tone={RISK_TONE[counterparty.risk_level] ?? "neutral"} className="capitalize">
                                {counterparty.risk_level}
                              </Badge>
                            </span>
                            <span className="hidden text-right text-xs md:block">
                              <span className="block text-ink-3">Allowed now</span>
                              <span className="text-ink">{counterparty.payment_limit == null ? "Not set" : <Money value={counterparty.payment_limit} />}</span>
                            </span>
                            <span className="hidden font-mono text-xs text-ink-2 md:block" title={counterparty.address ?? undefined}>
                              {counterparty.address ? shortHash(counterparty.address) : "No address"}
                            </span>
                            <span className="justify-self-end">
                              <Badge size="sm" tone={ready.tone}>{ready.label}</Badge>
                            </span>
                            <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
                          </>
                        }
                      >
                        <article className="border-t border-line bg-ground/40 px-4 py-4 sm:px-5" aria-label={counterparty.name}>
                          {/* The row says all this on a wide screen; a narrow one shows only the name and what it needs. */}
                          <div className="flex items-start justify-between gap-3 md:hidden">
                            <div className="min-w-0">
                              <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                                <span className="truncate">{counterparty.name}</span>
                                {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
                              </h3>
                              <p className="mt-0.5 text-xs text-ink-3">
                                <span className="capitalize">{counterparty.role}</span> · {payeeChain(counterparty.chain).label}
                              </p>
                            </div>
                            <Badge size="sm" dot tone={RISK_TONE[counterparty.risk_level] ?? "neutral"} className="shrink-0 capitalize">
                              {counterparty.risk_level}
                            </Badge>
                          </div>
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
                        </article>
                      </Disclosure>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>
      </ProductShell>
    );
  });
}
