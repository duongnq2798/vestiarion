import type { Metadata } from "next";
import { cosignsNow } from "@/lib/approval-policy";
import AgentControls from "@/components/AgentControls";
import { CounterpartyDetails } from "@/components/CounterpartyDetails";
import { CounterpartyRow, readiness } from "@/components/CounterpartyRow";
import { AutoRefresh } from "@/components/AutoRefresh";
import { bankAccountsOf, readPayoutPartner } from "@/lib/bank-payouts/store";
import { blindpaySettingsFromEnv } from "@/lib/blindpay/settings";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import { AskEveryPayee } from "@/components/intake/AskEveryPayee";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { orgHref } from "@/lib/auth/org-paths";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { counterpartyPath } from "@/lib/counterparty-paths";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { draftSupplierName } from "@/lib/invoice-drafts/store";
import { listLedgerEntries } from "@/lib/ledger";
import { listActivePayeeLinks, listWaitingInvoiceLinks } from "@/lib/platform/payee-links";
import { chainChoiceFits, choosablePayeeChains, payeesHeldToTheirChain } from "@/lib/payee-chain-choice";
import { homeChain } from "@/lib/payee-chains";
import { askablePayees } from "@/lib/address-requests";
import { simulatesPayments } from "@/lib/capability-read";
import { plural } from "@/lib/copy";
import { listCounterparties, stats } from "@/lib/queries";
import { readShadowMode } from "@/lib/shadow-mode";
import { earlierLookalike, lookalikes, PAYEE_LOCK_OFF, readPayeeLock } from "@/lib/payee-lock";
import { readAddressChecks, type AddressCheckView } from "@/lib/address-change-check";
import { loadNewPayeeFacts } from "@/lib/new-payee-facts";
import { workspaceNetwork } from "@/lib/workspace-network";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";
// Ask every payee for an address makes up to 25 links and sends their emails in one action (ask every payee A4).
export const maxDuration = 300;

export const metadata: Metadata = { title: sectionTitle("counterparties") };

export default async function CounterpartiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ add?: string | string[]; draft?: string | string[] }>;
}) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  // `?add`, from an invoice with no counterparty to choose (Bills & receivables, From a document), opens Add counterparty;
  // `&draft=`, from a captured draft (invoice capture C5), fills in the supplier's name, read from that draft in this
  // workspace: a name, often a person's, never travels in the address.
  const { add, draft } = await searchParams;
  const adding = add !== undefined;
  return inOrg(access, async () => {
    const initialName = typeof draft === "string" ? ((await draftSupplierName(draft).catch(() => null)) ?? undefined) : undefined;
    const network = workspaceNetwork().id;
    // A live match names the entity it matched, which Not this person dismisses (dismiss screening match R6).
    const liveScreening = screeningMode() === "live";
    const [counterparties, dashboardStats, entries, canWrite, canConfirm, canReconcile, shadow] = await Promise.all([
      listCounterparties(),
      stats(),
      listLedgerEntries(1),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "approval.decide"),
      // Checking a vendor's statement (vendor statement VS1): owners, admins and accountants.
      viewerCan(slug, "payables.reconcile"),
      // In shadow mode a payee with no Arc address can be given a mirror address (shadow mode S7), and a new supplier is
      // asked whether it sends purchase orders. Best effort.
      readShadowMode(db()).catch((error: unknown) => {
        console.error("counterparties: shadow mode not read", error instanceof Error ? error.message : error);
        return null;
      }),
    ]);
    // A co-signing accountant confirms changed addresses too (accountant co-sign CS6); a screening match stays with whoever
    // decides payments.
    const canConfirmAddress = canConfirm || (await cosignsNow(access.membership.role));
    // The payee lock (payee lock PL2), for the confirm form, best effort; and the payees whose address is another's, or
    // made to look like it (PL6), compared on the chain each is paid on.
    const payeeLock = canConfirmAddress
      ? await readPayeeLock(db()).catch((error: unknown) => {
          console.error("counterparties: payee lock not read", error instanceof Error ? error.message : error);
          return PAYEE_LOCK_OFF;
        })
      : PAYEE_LOCK_OFF;
    const alike = lookalikes(
      counterparties.map((counterparty) => ({ id: counterparty.id, name: counterparty.name, address: counterparty.address, chain: counterparty.chain ?? homeChain(network).id }))
    );
    // For an address waiting for its confirmation, one this payee had or was paid at before that it is made to look like
    // (PL6), read only for those, for whoever may confirm them. Best effort: none when unread.
    const waitingIds = canConfirmAddress
      ? counterparties.filter((counterparty) => addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at)).map((counterparty) => counterparty.id)
      : [];
    const earlierAlike = new Map<string, string>();
    if (waitingIds.length > 0) {
      try {
        const facts = await loadNewPayeeFacts(db(), waitingIds);
        for (const counterparty of counterparties) {
          if (!waitingIds.includes(counterparty.id)) continue;
          const earlier = earlierLookalike(counterparty.address, facts.entries.get(counterparty.id) ?? [], facts.paidTo.get(counterparty.id) ?? []);
          if (earlier) earlierAlike.set(counterparty.id, earlier);
        }
      } catch (error) {
        console.error("counterparties: earlier addresses not read", error instanceof Error ? error.message : error);
      }
    }
    // Each payee's freeze and the latest "Was this you?" sent to its contact (address change check AC5). Best effort: none
    // when unread, and none before migration 0137.
    const addressChecks = await readAddressChecks(counterparties.map((counterparty) => counterparty.id)).catch((error: unknown) => {
      console.error("counterparties: address checks not read", error instanceof Error ? error.message : error);
      return new Map<string, AddressCheckView>();
    });
    // Only those who may send a payee link see which ones are out.
    const payeeLinks = canWrite ? await listActivePayeeLinks(access.membership.orgId) : new Map<string, { id: string; expiresAt: string }>();
    // The payees with no address of their own to ask at once (ask every payee A1, A2).
    const askable = canWrite ? askablePayees(counterparties, payeeLinks) : null;
    // The chains a vendor with no address may be let choose among on its link, when the workspace pays more than one
    // (payee invoice link P1). Best effort: none when it cannot be read.
    const choosableChains = canWrite
      ? (
          await choosablePayeeChains().catch((error: unknown) => {
            console.error("counterparties: payee chains not read", error instanceof Error ? error.message : error);
            return [];
          })
        ).map((chain) => chain.label)
      : [];
    // Vendors with no address that a milestone or a bill in another currency than USDC still holds to their chain: the
    // choice would strand it (P2). Read only when a choice could be offered; best effort, as if every one were held.
    const vendorsWithoutAddress = counterparties.filter((counterparty) => chainChoiceFits(counterparty, new Set())).map((counterparty) => counterparty.id);
    const heldToChain =
      choosableChains.length > 1 && vendorsWithoutAddress.length > 0
        ? await payeesHeldToTheirChain(vendorsWithoutAddress).catch((error: unknown) => {
            console.error("counterparties: payees held to their chain not read", error instanceof Error ? error.message : error);
            return new Set(vendorsWithoutAddress);
          })
        : new Set<string>();
    // A used link still waiting for its payee's invoice, which Revoke stops (P6).
    const waitingInvoices = canWrite ? await listWaitingInvoiceLinks(access.membership.orgId) : new Map<string, { id: string; until: string }>();
    // Vendors paid to a bank account through BlindPay (bank payouts B4), on a deployment with it; best effort, none
    // before migration 0124.
    const bankPayoutsOn = blindpaySettingsFromEnv() !== null;
    const [bankAccounts, bankPartner, canManageBank] = bankPayoutsOn
      ? await Promise.all([
          bankAccountsOf(counterparties.filter((counterparty) => counterparty.role === "vendor").map((counterparty) => counterparty.id)).catch((error: unknown) => {
            console.error("counterparties: bank accounts not read", error instanceof Error ? error.message : error);
            return new Map();
          }),
          readPayoutPartner().catch(() => null),
          viewerCan(slug, "integrations.manage"),
        ])
      : [new Map(), null, false];
    // What needs someone first, then by name (Counterparties layout).
    const ordered = [...counterparties].sort((a, b) => readiness(a).rank - readiness(b).rank || a.name.localeCompare(b.name));
    // What this member may do on each row, as on a counterparty's page (counterparty page CL3).
    const grants = { write: canWrite, decide: canConfirm, confirmAddress: canConfirmAddress, reconcile: canReconcile, manageBank: canManageBank };
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
            <CounterpartyIntake orgSlug={slug} framed={false} network={network} askPurchaseOrders={shadow !== null} initialName={initialName} />
          </IntakeFold>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add counterparties.</Callout>
        )}

        {/* Kept in place for a writer even with no payee left to ask, so the links it just made stay on screen this once. */}
        {askable && (
          <AskEveryPayee
            orgSlug={slug}
            payees={askable.payees}
            more={askable.more}
            linksOut={askable.linksOut}
            emails={!simulatesPayments(access.membership.mode)}
          />
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
                    <CounterpartyRow counterparty={counterparty} network={network} pageHref={orgHref(slug, counterpartyPath(counterparty.id))}>
                      <CounterpartyDetails
                        orgSlug={slug}
                        network={network}
                        counterparty={counterparty}
                        grants={grants}
                        liveScreening={liveScreening}
                        found={{
                          payeeLockOn: payeeLock.on,
                          lookalikes: alike.get(counterparty.id) ?? [],
                          earlierLookalike: earlierAlike.get(counterparty.id) ?? null,
                          check: addressChecks.get(counterparty.id) ?? null,
                        }}
                        shadow={shadow !== null}
                        bank={bankPayoutsOn && counterparty.role === "vendor" ? { account: bankAccounts.get(counterparty.id) ?? null, setUp: Boolean(bankPartner?.customerId) } : null}
                        payeeLink={
                          canWrite
                            ? {
                                active: payeeLinks.get(counterparty.id) ?? null,
                                waiting: waitingInvoices.get(counterparty.id) ?? null,
                                chains: chainChoiceFits(counterparty, heldToChain) ? choosableChains : [],
                              }
                            : null
                        }
                      />
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
