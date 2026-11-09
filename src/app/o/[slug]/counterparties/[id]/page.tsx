import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { rowDate } from "@/components/bills/build";
import { CounterpartyAddressBlock, CounterpartyPayoutBlock, CounterpartyProfile, type AddressView } from "@/components/CounterpartyDetails";
import { CounterpartyHistory } from "@/components/counterparty/CounterpartyHistory";
import { PayeeLinkHistory } from "@/components/counterparty/PayeeLinkHistory";
import { SentDrafts } from "@/components/counterparty/SentDrafts";
import { DocsLink } from "@/components/DocsLink";
import { DocumentRequestLine } from "@/components/document-requests/DocumentRequestLine";
import PayeeLinkControl from "@/components/intake/PayeeLinkControl";
import { ReceiptControl } from "@/components/ReceiptControl";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { DecisionRows, RowGroupHeading, type DecisionRowItem } from "@/components/vx/DecisionRows";
import { invoiceDecision, milestoneDecidedAt, milestoneDecision } from "@/components/vx/map";
import { fmt, Hash, Money, shortHash } from "@/components/vx/Primitives";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { StatTile } from "@/components/vx/StatTile";
import type { Decision } from "@/components/vx/types";
import { UntrustedText } from "@/components/vx/UntrustedText";
import { decisionEntryOf, heldReason } from "@/lib/agent/milestone-decisions";
import { cosignsNow } from "@/lib/approval-policy";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { invoiceHref } from "@/lib/bills-view";
import { blindpaySettingsFromEnv } from "@/lib/blindpay/settings";
import { shellModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { plural } from "@/lib/copy";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
import { pageGrants } from "@/lib/counterparties/page-grants";
import { readCounterpartyPage } from "@/lib/counterparties/page-read";
import {
  addressExplorer,
  addressFacts,
  CLOSED_SHOWN,
  copyOffWords,
  counterpartyTotals,
  invoiceGroups,
  isPayee,
  milestoneAt,
  milestoneGroups,
  NOT_READ,
  OPEN_SHOWN,
  PART_NOT_READ,
  payeeLinkStates,
  paymentRows,
  PAYMENTS_SHOWN,
  tiles,
  visibleRequest,
  type CopyOff,
  type CurrencyTotal,
  type Group,
  type TileValue,
} from "@/lib/counterparties/page-view";
import { counterpartyIdOf, counterpartyPath, counterpartyRowPath, milestoneRowPath, type CounterpartySection } from "@/lib/counterparty-paths";
import { inOrg } from "@/lib/dal/scope";
import { milestoneDate } from "@/lib/milestone-date";
import { milestoneWaiting } from "@/lib/milestone-waiting";
import type { Network } from "@/lib/network";
import { chainById, homeChain } from "@/lib/payee-chains";
import { readCounterparty, stats, type CounterpartyRow, type InvoiceRow, type MilestoneRow } from "@/lib/queries";
import { receiptShareable } from "@/lib/receipts/facts";
import { settlementsByBill } from "@/lib/settlement-facts";
import { shellStatus } from "@/lib/shell-status";
import { visibleText } from "@/lib/visible-text";
import { workspaceNetwork } from "@/lib/workspace-network";

export const dynamic = "force-dynamic";

// CL16: a static title, so a counterparty's name never reaches the browser tab or analytics; the header names them.
export const metadata: Metadata = { title: "Counterparty" };

type CounterpartyPageProps = {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ history?: string | string[] }>;
};

/** CL13: a record whose entries were read in a chunk that may have been cut, or not read at all. */
const HISTORY_CUT = "Some of this record's history was not read; the Audit log has all of it.";
/** CL5: Copy address is off while the checks it rests on are unread: nothing is copied on a guess. */
const ADDRESS_NOT_READ = "Copy is off until the checks on this address are read. Reload the page in a moment.";
const ZERO_USDC: CurrencyTotal[] = [{ currency: "USDC", amount: 0 }];

/**
 * One counterparty, in one place (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL1–CL17): its profile,
 * its payment address, its payee link, its milestones, its bills or invoices, its payments with their receipts, the
 * documents asked of it and captured from it, and its history, each part read best effort. Nothing here pays or records
 * anything new: every control is the one Counterparties, Contractors or Bills & receivables already has, with its own
 * signed entries (CL14). An id that is not a UUID, and a counterparty this workspace does not hold, are the workspace's
 * not-found page alike (CL2).
 */
export default async function CounterpartyPage({ params, searchParams }: CounterpartyPageProps) {
  const { slug, id: param } = await params;
  const access = await requireMembership(slug);
  // CL2: an id that is not one is a 404 before anything is read.
  const id = counterpartyIdOf(param);
  if (!id) notFound();
  // CL9: every payment, up to 500, rather than the latest 10.
  const everyPayment = (await searchParams).history === "all";
  return inOrg(access, async () => {
    const [counterparty, dashboardStats] = await Promise.all([
      // CL2: read through the workspace's scope, so another workspace's counterparty comes back as none. A read that
      // fails is said as such, never as a 404; it is logged by the error's name only (CL4).
      readCounterparty(id).catch((error: unknown): undefined => {
        console.error("counterparty page: counterparty not read", error instanceof Error ? error.name : "unknown");
        return undefined;
      }),
      stats(),
    ]);
    const back = (
      <Button asChild variant="link">
        {/* CL16: back to their row on the list, which opens it. */}
        <Link href={orgHref(slug, counterpartyRowPath(id))}>
          <ArrowLeft aria-hidden />
          All counterparties
        </Link>
      </Button>
    );
    if (counterparty === undefined) {
      return (
        <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
          <PageHead title="Counterparty" right={back} />
          <Callout tone="held">This counterparty could not be read just now. Reload the page in a moment.</Callout>
        </ProductShell>
      );
    }
    if (counterparty === null) notFound();

    const role = access.membership.role;
    const live = access.membership.mode === "live";
    const network = workspaceNetwork().id;
    const bankPayouts = blindpaySettingsFromEnv() !== null;
    // CL3: every grant from the role and the page's one read of the co-sign setting, with no round trip per grant.
    const grants = pageGrants(role, { cosigns: await cosignsNow(role), live, bankPayouts });
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // CL2: every later read starts from the row read, never from the address the page was opened at.
    const read = await readCounterpartyPage(counterparty, { orgId: access.membership.orgId, grants, network, now, history: everyPayment, bankPayouts });

    const payee = isPayee(counterparty.role);
    // CL12: their name as the page shows it, only what is visible of it; the crumb is cut shorter.
    const name = visibleText(counterparty.name, 120);
    const chainLabel = chainLabelOf(counterparty, network);
    const entries = read.entries.read ? read.entries.value.entries : [];
    const cut = read.entries.read ? read.entries.value.cut : null;
    const payments = read.payments.read ? read.payments.value : null;
    const invoices = read.invoices.read ? read.invoices.value : null;
    const milestones = payee ? (read.milestones?.read ? read.milestones.value : null) : [];

    // CL5: the address's state from the row; Copy address only on every check read, and Confirm address only with the
    // lookalikes it warns of in hand.
    const checks = read.address;
    const frozen = Boolean(counterparty.frozen_at);
    const facts = addressFacts(counterparty, checks.read ? checks.value : { lookalikes: [], earlierLookalike: null, frozen });
    const explorer = addressExplorer(network, counterparty);
    const addressView: AddressView = {
      explorerHref: explorer.href,
      explorerNote: explorer.href === null ? explorer.note : null,
      copyable: checks.read && facts.copyable,
      copyNote: !checks.read ? ADDRESS_NOT_READ : facts.copyOff ? <CopyOffNote off={facts.copyOff} /> : null,
    };
    const found = {
      payeeLockOn: read.payeeLock.on,
      // CL12: a lookalike's name is someone else's text too.
      lookalikes: checks.read ? checks.value.lookalikes.map((lookalike) => ({ ...lookalike, name: visibleText(lookalike.name, 80) })) : [],
      earlierLookalike: checks.read ? checks.value.earlierLookalike : null,
      check: read.addressCheck,
    };
    const links = read.payeeLinks?.read ? read.payeeLinks.value : null;

    // CL12: the row as the page's own parts name it (the profile, the address and its "is frozen" callout, the payout,
    // the payee link), by what is visible of the name. CL7–CL9: each record's decision, with its name and title as text
    // from outside too.
    const shown: CounterpartyRow = { ...counterparty, name: name || "This counterparty" };
    const settlements =
      payments && invoices
        ? settlementsByBill({
            payments: payments.payments.values(),
            invoices: invoices.filter((invoice) => invoice.direction === "payable"),
            entries,
            entriesComplete: cut !== null && cut.size === 0,
            now,
          })
        : undefined;
    const billDecision = (invoice: InvoiceRow) =>
      invoiceDecision({ ...invoice, counterparty_name: name, memo: invoice.memo === null ? null : visibleText(invoice.memo, 200) || null }, shown, entries, { network, settlements, asOf: now });
    const waits = (milestone: MilestoneRow) => milestoneWaiting(milestone, counterparty, { live, lock: read.payeeLock, now });
    // CL9: when a milestone was paid or last decided, from its payment or its entries; null with neither read.
    const milestoneTime = (milestone: MilestoneRow) => milestoneAt(milestone, payments?.payments.get(milestone.id), milestoneDecidedAt(milestone.id, entries));
    const workDecision = (milestone: MilestoneRow) => {
      const wait = waits(milestone);
      return milestoneDecision({ ...milestone, contractor_name: name, title: visibleText(milestone.title, 200) }, entries, {
        network,
        riskLevel: counterparty.risk_level,
        waiting: wait.waiting,
        waitsUntil: wait.waitsUntil,
        links: read.evidence.links,
      });
    };
    // CL13: a record whose entries may be incomplete says so above its card.
    const cutNote = (recordId: string) => (cut === null || cut.has(recordId) ? <p className="text-xs text-ink-3">{HISTORY_CUT}</p> : null);

    // CL9: where a payment went, when it was not their address now.
    const destination = (sourceId: string): { words: string; link: ReactNode } | null => {
      const sent = payments?.destinations.get(sourceId);
      if (!sent) return null;
      if (sent.startsWith("blindpay:")) return { words: "Paid to their bank account through BlindPay", link: null };
      if (sent.startsWith("sim:")) return { words: "A simulated payment: nothing moved on chain.", link: null };
      if (!/^0x[0-9a-fA-F]{40}$/.test(sent) || sent.toLowerCase() === counterparty.address?.toLowerCase()) return null;
      const earlier = addressExplorer(network, { address: sent, chain: payments?.payments.get(sourceId)?.destination_chain ?? null });
      return {
        words: `Paid to an earlier address ${shortHash(sent)}`,
        link: earlier.href ? (
          <p className="text-xs text-ink-2">
            Paid to an earlier address <Hash value={sent} href={earlier.href} />
          </p>
        ) : null,
      };
    };
    // CL9: a payable's receipt, as every member may know it (the evidence page shows it too); never its link.
    const receiptWords = (invoice: InvoiceRow, decision: Decision) => {
      if (!receiptShareable(invoice, decision)) return "No receipt: not paid on chain";
      if (!read.receipts?.read) return `Receipt: ${NOT_READ.toLowerCase()}`;
      const state = read.receipts.value.get(invoice.id);
      return state === "shared" ? "Receipt shared" : state === "stopped" ? "Receipt link stopped" : "No receipt shared";
    };

    const milestoneItem = (milestone: MilestoneRow, inPayments: boolean): DecisionRowItem => {
      const decision = workDecision(milestone);
      const wait = waits(milestone);
      // CL7: a held milestone's reason, read from its payment as Contractors reads it; with that unread, the badge alone.
      const held =
        milestone.status === "held" && payments
          ? heldReason({
              amount: milestone.amount,
              agentReasoning: milestone.agent_reasoning,
              contractor: {
                name,
                riskLevel: counterparty.risk_level,
                riskNotes: counterparty.risk_notes,
                paymentLimit: counterparty.payment_limit,
                baselinePaymentLimit: counterparty.baseline_payment_limit,
                address: counterparty.address,
                addressChangedAt: counterparty.address_changed_at,
                addressConfirmedAt: counterparty.address_confirmed_at,
                chain: counterparty.chain,
              },
              intent: payments.payments.get(milestone.id) ?? null,
              lastEntry: (() => {
                const last = decisionEntryOf(entries.filter((entry) => entry.detail.milestoneId === milestone.id));
                return last ? { action: last.action, detail: last.detail } : null;
              })(),
              live,
            })
          : null;
      const hint = wait.waiting === "unconfirmed" ? "Address to confirm" : held?.hint;
      const sent = inPayments ? destination(milestone.id) : null;
      const before = nodes(
        cutNote(milestone.id),
        held && (
          <Callout tone="held" title="What it waits for">
            <p>{held.text}</p>
          </Callout>
        ),
        sent?.link
      );
      const note = inPayments ? ["A milestone has no receipt", sent?.words].filter(Boolean).join(" · ") : undefined;
      return {
        decision,
        // CL9: never `decision.at`, which is the time of this request when no entry about the milestone was read.
        date: milestoneDate(milestone, milestoneTime(milestone)),
        ...(hint ? { hint } : {}),
        ...(note ? { note } : {}),
        ...(before ? { before } : {}),
        after: (
          <RowLink href={orgHref(slug, milestoneRowPath(milestone.id, { paid: milestone.status === "paid" || milestone.status === "closed" }))}>Open in Contractors</RowLink>
        ),
      };
    };

    const invoiceItem = (invoice: InvoiceRow, inPayments: boolean): DecisionRowItem => {
      const decision = billDecision(invoice);
      // CL9: a payee's payment says its receipt and where it went; a client's has no receipt (receipts are for payables).
      const paidOut = inPayments && payee && invoice.direction === "payable";
      const sent = paidOut ? destination(invoice.id) : null;
      const note = paidOut ? [receiptWords(invoice, decision), sent?.words].filter(Boolean).join(" · ") : undefined;
      const before = nodes(cutNote(invoice.id), sent?.link);
      // CL4: mounted on write access in a live workspace and the payment alone, never on the receipt's own state. With
      // that state unread the control offers nothing (null): sharing a shared receipt again would stop its link.
      const footerAction =
        paidOut && grants.shareReceipts && receiptShareable(invoice, decision) ? (
          <ReceiptControl orgSlug={slug} invoiceId={invoice.id} shared={read.receipts?.read ? read.receipts.value.get(invoice.id) === "shared" : null} />
        ) : undefined;
      return {
        decision,
        date: rowDate(invoice, today),
        ...(note ? { note } : {}),
        ...(before ? { before } : {}),
        ...(footerAction ? { footerAction } : {}),
        after: <RowLink href={orgHref(slug, invoiceHref(invoice.id))}>Open in Bills &amp; receivables</RowLink>,
      };
    };

    const bills = invoices ? invoiceGroups(invoices, counterparty.role) : null;
    const work = milestones ? milestoneGroups(milestones) : null;
    const totals = invoices && milestones ? counterpartyTotals(counterparty.role, invoices, milestones) : null;
    const paidRows =
      bills && work
        ? paymentRows(
            {
              milestones: payee ? work.paid.map((milestone) => ({ milestone, paidAt: milestoneTime(milestone) })) : [],
              invoices: bills.paid,
            },
            everyPayment
          )
        : null;
    const headerTiles = tiles({
      role: counterparty.role,
      invoices: read.invoices,
      milestones: read.milestones ?? { read: true, value: [] },
      address: { read: true, value: facts.state },
      payeeLink: payee && grants.seeLinks ? (links ? { read: true, value: { active: links.active, waiting: links.waiting } } : { read: false }) : null,
    });
    const refreshMs = counterpartiesRefreshMs({ linksOut: links?.active ? 1 : 0, unconfirmed: facts.state === "unconfirmed" ? 1 : 0 });
    const ownInvoices = invoices?.filter((invoice) => invoice.direction === (payee ? "payable" : "receivable")).length ?? 0;
    const kind = counterparty.role === "contractor" ? "Contractor" : "Vendor";
    const sub = payee
      ? `${kind} · paid on ${chainLabel}. Everything Vestiarion holds about them, in one place. Nothing here makes a payment: the agent pays under its rules, and people decide in Approvals and on Contractors.`
      : "Client. Everything Vestiarion holds about them, in one place.";
    const paymentsHref = (all: boolean) => orgHref(slug, all ? `${counterpartyPath(counterparty.id)}?history=all#payments` : counterpartyPath(counterparty.id, "payments"));
    // CL10: the requests on the bills Bills from them shows; unread with the bills or the requests unread.
    const requestsRead = Boolean(bills && read.documents?.read);
    const requests =
      payee && bills && read.documents?.read
        ? [...bills.open.rows, ...bills.closed.rows].flatMap((invoice) => {
            const view = read.documents?.read ? read.documents.value.get(invoice.id) : undefined;
            // CL12: the note and purchase order number the vendor typed, only as far as they show.
            return view ? [{ invoice, view: visibleRequest(view) }] : [];
          })
        : [];
    const drafts = read.drafts?.read ? read.drafts.value : null;

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()} crumb={visibleText(counterparty.name, 80)}>
        <PageHead
          title={<UntrustedText text={counterparty.name} max={120} empty="Counterparty" />}
          sub={sub}
          right={
            <div className="flex shrink-0 items-center gap-3">
              <DocsLink href="/docs/guides/pay-a-contractor#one-page-for-each-contractor" topic="a counterparty's page" />
              {back}
            </div>
          }
        />
        {/* CL13: a payee answers a link from another browser: re-read often while one is out or an address waits. */}
        <AutoRefresh intervalMs={refreshMs} />

        <div className="space-y-10">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {headerTiles.map((tile) => (
              <StatTile key={tile.label} label={tile.label} tone={tile.held ? "held" : "default"}>
                <TileFigure value={tile.value} />
              </StatTile>
            ))}
          </div>

          <Section id="profile" title="Profile">
            <CounterpartyProfile orgSlug={slug} network={network} counterparty={shown} grants={grants} liveScreening={screeningMode() === "live"} anchored />
          </Section>

          <Section id="address" title="Payment address">
            <CounterpartyAddressBlock
              orgSlug={slug}
              network={network}
              counterparty={shown}
              // CL5: no confirming an address while the lookalikes the confirm form warns of are unread.
              grants={{ write: grants.write, confirmAddress: grants.confirmAddress && checks.read }}
              found={found}
              shadow={read.controls.shadow}
              view={addressView}
            />
            <CounterpartyPayoutBlock orgSlug={slug} counterparty={shown} grants={grants} bank={read.controls.bank} />
          </Section>

          {payee && (
            <Section id="payee-link" title="Payee link">
              {grants.seeLinks ? (
                <>
                  {/* CL4: mounted on write access alone, so a refresh after Create link never takes away the link it shows. */}
                  <PayeeLinkControl
                    orgSlug={slug}
                    counterparty={{ id: counterparty.id, name: shown.name }}
                    chainLabel={chainLabel}
                    activeLink={links?.active ?? null}
                    offers={{ invoice: true, chains: read.controls.chainChoices }}
                    waitingInvoice={links?.waiting ?? null}
                  />
                  {links ? <PayeeLinkHistory lines={payeeLinkStates(links.links, { now, members: links.members })} /> : <NotRead />}
                </>
              ) : (
                <Line>An owner or admin sends and stops payee links.</Line>
              )}
            </Section>
          )}

          {payee && (
            <Section id="milestones" title="Milestones">
              {!work || !milestones ? (
                <NotRead />
              ) : milestones.length === 0 ? (
                <Line>No milestones yet.</Line>
              ) : work.open.length + work.closed.length === 0 ? (
                <Line>Nothing open: every milestone of theirs is paid, under Payments.</Line>
              ) : (
                <>
                  {work.open.length > 0 && (
                    <>
                      <RowGroupHeading title="Open" count={work.open.length} />
                      <DecisionRows orgSlug={slug} items={work.open.map((milestone) => milestoneItem(milestone, false))} />
                    </>
                  )}
                  {work.closed.length > 0 && (
                    <>
                      <RowGroupHeading title="Closed without paying" count={work.closed.length} />
                      <DecisionRows orgSlug={slug} items={work.closed.map((milestone) => milestoneItem(milestone, false))} />
                    </>
                  )}
                </>
              )}
            </Section>
          )}

          <Section id="bills" title={payee ? "Bills from them" : "Invoices to them"}>
            {!bills ? (
              <NotRead />
            ) : ownInvoices === 0 ? (
              <Line>{payee ? "No bills from them yet." : "No invoices to them yet."}</Line>
            ) : bills.open.count + bills.closed.count === 0 ? (
              <Line>Nothing open: every bill from them is paid, under Payments.</Line>
            ) : (
              <>
                <InvoiceGroup title="Open" group={bills.open} shown={OPEN_SHOWN} slug={slug} item={(invoice) => invoiceItem(invoice, false)} />
                <InvoiceGroup title={payee ? "Rejected" : "Received"} group={bills.closed} shown={CLOSED_SHOWN} slug={slug} item={(invoice) => invoiceItem(invoice, false)} />
              </>
            )}
          </Section>

          <Section
            id="payments"
            title={payee ? "Payments" : "Payments from them"}
            meta={paidRows && totals ? `${paidRows.count} ${plural(paidRows.count, "payment", "payments")} · ${totalsWords(totals.paid)}` : undefined}
            action={
              paidRows && paidRows.count > PAYMENTS_SHOWN ? (
                <Button asChild variant="link" className="text-[0.8125rem]">
                  <Link href={paymentsHref(!everyPayment)}>{everyPayment ? `Show the latest ${PAYMENTS_SHOWN}` : "Show every payment"}</Link>
                </Button>
              ) : undefined
            }
          >
            {!paidRows ? (
              <NotRead />
            ) : paidRows.count === 0 ? (
              <Line>No payments yet.</Line>
            ) : (
              <DecisionRows orgSlug={slug} items={paidRows.shown.map((row) => (row.kind === "milestone" ? milestoneItem(row.milestone, true) : invoiceItem(row.invoice, true)))} />
            )}
          </Section>

          {payee && (
            <Section id="documents" title="Documents">
              {requestsRead && requests.length === 0 && drafts !== null && drafts.length === 0 ? (
                <Line>Nothing asked for or captured yet.</Line>
              ) : (
                <div className="space-y-6">
                  {/* A part with none in it, beside one with some, is left out; one unread says so. */}
                  {(!requestsRead || requests.length > 0) && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-ink">Document requests</h3>
                    {!requestsRead ? (
                      <NotRead />
                    ) : (
                      <ul className="space-y-3">
                        {requests.map(({ invoice, view }) => (
                          <li key={invoice.id} className="space-y-1.5">
                            <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
                              <UntrustedText text={invoice.memo} empty="A bill" className="text-ink-2" />
                              <span>
                                · <Money value={invoice.amount} token={invoice.currency ?? "USDC"} />
                              </span>
                              <Link href={orgHref(slug, invoiceHref(invoice.id))} className="font-medium text-agent underline-offset-4 hover:underline">
                                Open in Bills &amp; receivables
                              </Link>
                            </p>
                            <DocumentRequestLine orgSlug={slug} vendorName={name || "This vendor"} view={view} goodsReceived={invoice.goods_received} canRevoke={grants.write} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  )}
                  {(drafts === null || drafts.length > 0) && (
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-ink">Invoices sent for review</h3>
                      {drafts === null ? <NotRead /> : <SentDrafts orgSlug={slug} drafts={drafts} />}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* CL11: shown to every member, as the Audit log is; folded, with the page's one `history` id. */}
          <CounterpartyHistory orgSlug={slug} entries={read.history.read ? read.history.value : null} />
        </div>
      </ProductShell>
    );
  });
}

/** The chain a payee is paid on, by its label; a chain no network lists is named as stored. */
function chainLabelOf(counterparty: Pick<CounterpartyRow, "chain">, network: Network): string {
  try {
    return chainById(counterparty.chain ?? homeChain(network).id).label;
  } catch {
    return counterparty.chain ?? homeChain(network).label;
  }
}

/** The nodes given that are something, together; null for none. */
function nodes(...parts: ReactNode[]): ReactNode {
  const present = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return present.length === 0 ? null : <>{present.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</>;
}

/** CL9: totals per currency, never added together: "120.00 USDC · 40.00 EURC". */
function totalsWords(totals: readonly CurrencyTotal[]): string {
  return (totals.length > 0 ? totals : ZERO_USDC).map((total) => `${fmt(total.amount)} ${total.currency}`).join(" · ");
}

/** One anchored part of the page (CL1), headed by its title. */
function Section({ id, title, meta, action, children }: { id: CounterpartySection; title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <SectionHeader id={`${id}-title`} title={title} meta={meta} action={action} />
      {children}
    </section>
  );
}

/** A part with nothing in it, or nothing to show this member, in one line (CL1). */
function Line({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-3">{children}</p>;
}

/** CL13: a part that could not be read, never shown as none. */
function NotRead() {
  return <Line>{PART_NOT_READ}</Line>;
}

/** A row's way to where its record is acted on. */
function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p>
      <Button asChild variant="link" className="text-xs">
        <Link href={href}>{children}</Link>
      </Button>
    </p>
  );
}

/** A tile's figure: an amount per currency (CL9), or its words. */
function TileFigure({ value }: { value: TileValue }) {
  if (value.kind === "words") return <span className="text-base sm:text-lg">{value.words}</span>;
  const totals = value.totals.length > 0 ? value.totals : ZERO_USDC;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {totals.map((total, index) => (
        <Fragment key={total.currency}>
          {index > 0 && <span className="text-base text-ink-3">·</span>}
          <Money value={total.amount} token={total.currency} />
        </Fragment>
      ))}
    </span>
  );
}

/** CL5: why Copy address is off, a lookalike's name set apart as text from outside (CL12). */
function CopyOffNote({ off }: { off: CopyOff }) {
  const words = copyOffWords(off);
  return (
    <>
      {words.before}
      {words.name !== null && <UntrustedText text={words.name} max={80} />}
      {words.after}
    </>
  );
}

/** CL8: one group of bills or invoices, with how many it holds and, when it shows fewer, how many it shows. */
function InvoiceGroup({ title, group, shown, slug, item }: { title: string; group: Group<InvoiceRow>; shown: number; slug: string; item: (invoice: InvoiceRow) => DecisionRowItem }) {
  if (group.count === 0) return null;
  return (
    <>
      <RowGroupHeading title={title} count={group.count} action={group.count > shown ? <span className="text-[0.8125rem] text-ink-3">{title === "Open" ? `The first ${shown}` : `The latest ${shown}`}</span> : undefined} />
      <DecisionRows orgSlug={slug} items={group.rows.map(item)} />
    </>
  );
}
