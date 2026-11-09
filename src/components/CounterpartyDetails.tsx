import type { ReactNode } from "react";
import { AddressCheckNote, type AddressCheckShown } from "@/components/address-change/AddressCheckNote";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyBankAccount, { type BankAccountShown } from "@/components/intake/CounterpartyBankAccount";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";
import CounterpartyNoticeEmailEdit from "@/components/intake/CounterpartyNoticeEmailEdit";
import CounterpartyPurchaseOrdersEdit from "@/components/intake/CounterpartyPurchaseOrdersEdit";
import PayeeLinkControl from "@/components/intake/PayeeLinkControl";
import ScreeningMatch from "@/components/intake/ScreeningMatch";
import MirrorAddressControl from "@/components/MirrorAddressControl";
import { VendorStatementCheck } from "@/components/VendorStatementCheck";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { Money } from "@/components/vx/Primitives";
import type { PageGrants } from "@/lib/counterparties/page-grants";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import type { CounterpartySection } from "@/lib/counterparty-paths";
import { purchaseOrdersLabel } from "@/lib/counterparty-purchase-orders";
import type { Network } from "@/lib/network";
import { chainById, homeChain } from "@/lib/payee-chains";
import type { Lookalike } from "@/lib/payee-lock-rules";
import type { CounterpartyRow } from "@/lib/queries";

/**
 * What Vestiarion holds about one counterparty and what a member may change there
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md): its profile, its payment address, how a vendor is paid
 * out, and, on the Counterparties list, its payee link. The list's opened row and the counterparty's own page draw the same
 * parts, from what each page read in its scope: these take tenant data as props and read none.
 */

/** What a member may do here: the list's `viewerCan`s, or the page's `pageGrants` (CL3). */
export type DetailGrants = Pick<PageGrants, "write" | "decide" | "confirmAddress" | "reconcile" | "manageBank">;

/**
 * How the counterparty's page shows the address (CL5): in full, with its explorer link, and Copy address or the line that
 * says why it is off. The list shows it on one line without these.
 */
export interface AddressView {
  explorerHref: string | null;
  /** Why there is no explorer link, for a chain the workspace does not pay on (`NO_EXPLORER`); null otherwise. */
  explorerNote: string | null;
  copyable: boolean;
  copyNote: ReactNode;
}

/** What the address's lookalike checks and its "Was this you?" found, as the page read them (payee lock PL6, AC5). */
export interface AddressFound {
  /** Whether the workspace's payee lock is on (PL2), for the confirm form. */
  payeeLockOn: boolean;
  lookalikes: readonly Lookalike[];
  earlierLookalike: string | null;
  check: AddressCheckShown | null;
}

/** A vendor's bank account, on a deployment that pays through BlindPay (bank payouts B4); null otherwise. */
export type BankShown = { account: BankAccountShown | null; setUp: boolean } | null;

/**
 * Screening, the performance history, and the six lines: the limits, where it is, when it was screened, its billing email
 * and its purchase orders. On the counterparty's page (`anchored`), screening and the limit, billing email and purchase
 * order lines carry the ids a "fix it" link opens at (CL1, CL15); the list holds many rows, so it gives none.
 */
export function CounterpartyProfile({
  orgSlug,
  network,
  counterparty,
  grants,
  liveScreening,
  anchored = false,
}: {
  orgSlug: string;
  network: Network;
  counterparty: CounterpartyRow;
  grants: Pick<DetailGrants, "write" | "decide">;
  /** A live match names the entity it matched, which Not this person dismisses (dismiss screening match R6). */
  liveScreening: boolean;
  anchored?: boolean;
}) {
  const canWrite = grants.write;
  const anchor = (section: CounterpartySection) => (anchored ? section : undefined);
  const match = (
    <ScreeningMatch
      orgSlug={orgSlug}
      counterparty={{
        id: counterparty.id,
        name: counterparty.name,
        riskLevel: counterparty.risk_level,
        riskNotes: counterparty.risk_notes,
        riskEntityId: counterparty.risk_entity_id ?? null,
        matches: counterparty.risk_matches ?? null,
      }}
      canDismiss={grants.decide}
      liveScreening={liveScreening}
    />
  );
  return (
    <>
      {anchored ? <div id={anchor("screening")}>{match}</div> : match}
      <PerformanceHistory score={counterparty.performance_score} inputs={counterparty.performance_inputs} compact />
      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs sm:grid-cols-4">
        <div className="min-w-0" id={anchor("limit")}>
          <dt className="text-ink-3">Configured limit</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-ink">
            {counterparty.baseline_payment_limit == null ? "Not set" : <Money value={counterparty.baseline_payment_limit} />}
            {canWrite && (
              <CounterpartyLimitEdit
                orgSlug={orgSlug}
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
        <div className="col-span-2 min-w-0" id={anchor("billing-email")}>
          <dt className="text-ink-3">Billing email</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 break-words text-ink">
            {counterparty.notice_email ?? "None"}
            {canWrite && (
              <CounterpartyNoticeEmailEdit
                network={network}
                orgSlug={orgSlug}
                counterparty={{ id: counterparty.id, name: counterparty.name, role: counterparty.role, noticeEmail: counterparty.notice_email ?? null }}
              />
            )}
          </dd>
        </div>
        {/* Whether the agent needs a purchase order before it pays (three-way match design M2). A payable to a
            client waits for a person whatever its match (client payables R1). */}
        {counterparty.role !== "client" && (
          <div className="col-span-2 min-w-0" id={anchor("purchase-orders")}>
            <dt className="text-ink-3">Purchase orders</dt>
            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 break-words text-ink">
              {purchaseOrdersLabel(counterparty.purchase_order_required !== false)}
              {canWrite && (
                <CounterpartyPurchaseOrdersEdit
                  orgSlug={orgSlug}
                  counterparty={{ id: counterparty.id, name: counterparty.name, purchaseOrderRequired: counterparty.purchase_order_required !== false }}
                />
              )}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

/**
 * The payment address, with Edit address and Confirm address for whoever may (spec 2026-09-30-counterparty-address-edit),
 * what its contact said of a change and Unfreeze (AC5), and, in shadow mode, the mirror address that stands in for one
 * (shadow mode S7). On the counterparty's page (`view`) the address is shown in full, with its explorer link and Copy
 * address (CL5).
 */
export function CounterpartyAddressBlock({
  orgSlug,
  network,
  counterparty,
  grants,
  found,
  shadow,
  view,
}: {
  orgSlug: string;
  network: Network;
  counterparty: CounterpartyRow;
  grants: Pick<DetailGrants, "write" | "confirmAddress">;
  found: AddressFound;
  /** Shadow mode is on, so a writer may give a payee with no address a mirror one. */
  shadow: boolean;
  view?: AddressView;
}) {
  const canWrite = grants.write;
  return (
    <>
      <CounterpartyAddress
        orgSlug={orgSlug}
        counterparty={{ id: counterparty.id, name: counterparty.name, address: counterparty.address, chain: counterparty.chain ?? homeChain(network).id }}
        unconfirmedSince={addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at) ? counterparty.address_changed_at : null}
        canWrite={canWrite}
        canConfirm={grants.confirmAddress}
        // The payee lock is the confirm form's, for whoever may confirm (payee lock PL2, CL5).
        payeeLockOn={grants.confirmAddress && found.payeeLockOn}
        lookalikes={found.lookalikes}
        earlierLookalike={found.earlierLookalike}
        {...(view ? { full: true, explorerHref: view.explorerHref, copyable: view.copyable, copyNote: view.copyNote } : {})}
      />
      {view?.explorerNote && <p className="mt-1 text-xs text-ink-3">{view.explorerNote}</p>}
      <AddressCheckNote
        orgSlug={orgSlug}
        counterparty={{ id: counterparty.id, name: counterparty.name, address: counterparty.address }}
        view={found.check}
        canUnfreeze={canWrite}
      />
      {counterparty.mirror_wallet_id && (
        <p className="mt-1 text-xs text-ink-3">Mirror address: a wallet Vestiarion made for this payee on Arc testnet, in shadow mode.</p>
      )}
      {shadow && canWrite && counterparty.role !== "client" && !counterparty.address && (
        <div className="mt-2">
          <MirrorAddressControl orgSlug={orgSlug} counterparty={{ id: counterparty.id, name: counterparty.name }} />
        </div>
      )}
    </>
  );
}

/**
 * How a vendor is paid out and checked: its statement against its bills, for whoever reconciles (vendor statement VS1),
 * and its bank account, on a deployment that pays through BlindPay (bank payouts B4).
 */
export function CounterpartyPayoutBlock({
  orgSlug,
  counterparty,
  grants,
  bank,
}: {
  orgSlug: string;
  counterparty: Pick<CounterpartyRow, "id" | "name" | "role">;
  grants: Pick<DetailGrants, "write" | "reconcile" | "manageBank">;
  bank: BankShown;
}) {
  const vendor = { id: counterparty.id, name: counterparty.name };
  return (
    <>
      {grants.reconcile && counterparty.role === "vendor" && (
        <div className="mt-2">
          <VendorStatementCheck orgSlug={orgSlug} vendor={vendor} canAddBills={grants.write} />
        </div>
      )}
      {bank && counterparty.role === "vendor" && (
        <CounterpartyBankAccount orgSlug={orgSlug} counterparty={vendor} account={bank.account} canManage={grants.manageBank} setUp={bank.setUp} />
      )}
    </>
  );
}

/**
 * An opened row of the Counterparties list: the profile, the address, the payout, and the payee link for a writer. The
 * mirror address sits beside the address it stands in for.
 */
export function CounterpartyDetails({
  orgSlug,
  network,
  counterparty,
  grants,
  liveScreening,
  found,
  shadow,
  bank,
  payeeLink,
}: {
  orgSlug: string;
  network: Network;
  counterparty: CounterpartyRow;
  grants: DetailGrants;
  liveScreening: boolean;
  found: AddressFound;
  shadow: boolean;
  bank: BankShown;
  /**
   * The payee's link out, or a used one waiting for its invoice, and the chains a vendor's link may let it choose among
   * (payee invoice link P1, P2); null for a member who may not send payee links, who is shown none.
   */
  payeeLink: { active: { id: string; expiresAt: string } | null; waiting: { id: string; until: string } | null; chains: readonly string[] } | null;
}) {
  return (
    <>
      <CounterpartyProfile orgSlug={orgSlug} network={network} counterparty={counterparty} grants={grants} liveScreening={liveScreening} />
      <CounterpartyAddressBlock orgSlug={orgSlug} network={network} counterparty={counterparty} grants={grants} found={found} shadow={shadow} />
      <CounterpartyPayoutBlock orgSlug={orgSlug} counterparty={counterparty} grants={grants} bank={bank} />
      {payeeLink && grants.write && counterparty.role !== "client" && (
        <div className="mt-2">
          <PayeeLinkControl
            orgSlug={orgSlug}
            counterparty={{ id: counterparty.id, name: counterparty.name }}
            chainLabel={chainById(counterparty.chain ?? homeChain(network).id).label}
            activeLink={payeeLink.active}
            offers={{ invoice: true, chains: payeeLink.chains }}
            waitingInvoice={payeeLink.waiting}
          />
        </div>
      )}
    </>
  );
}
