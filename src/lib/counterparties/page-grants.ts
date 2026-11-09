import { can, type OrgRole } from "../auth/roles";

/**
 * What a member may do on a counterparty's page (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL3): the
 * Counterparties list's grants, put together in one place from the member's role and three facts the page reads once.
 * Pure: the page asks `viewerCan` nothing. What a grant does not allow is not read at all, not only hidden.
 */
export interface PageGrants {
  /** Edit the limit, billing email, purchase orders, address and mirror; unfreeze; revoke a document request. */
  write: boolean;
  /** Dismiss a screening match, as whoever decides payments does on the list. */
  decide: boolean;
  /** Confirm a changed address: whoever decides payments, or an accountant while co-signing is on (co-sign CS6). */
  confirmAddress: boolean;
  /** Check a vendor's statement (vendor statement VS1). */
  reconcile: boolean;
  /** Set a vendor's bank account, on a deployment that pays through BlindPay (bank payouts B4). */
  manageBank: boolean;
  /** See, make, renew and revoke payee links and their history: the page reads no payee link for anyone else. */
  seeLinks: boolean;
  /** Share, renew and revoke a payable's receipt: in a live workspace only. */
  shareReceipts: boolean;
}

/**
 * CL3: `cosigns` is `cosignsNow(role)`, the page's one read of the setting; `live` whether the workspace's mode is live;
 * `bankPayouts` whether BlindPay is set up on this deployment. A co-sign counts only for the role that co-signs.
 */
export function pageGrants(role: OrgRole, facts: { cosigns: boolean; live: boolean; bankPayouts: boolean }): PageGrants {
  const write = can(role, "records.write");
  const decide = can(role, "approval.decide");
  return {
    write,
    decide,
    confirmAddress: decide || (facts.cosigns && can(role, "approval.cosign")),
    reconcile: can(role, "payables.reconcile"),
    manageBank: facts.bankPayouts && can(role, "integrations.manage"),
    seeLinks: write,
    shareReceipts: write && facts.live,
  };
}
