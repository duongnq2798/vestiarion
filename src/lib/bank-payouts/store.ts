import { isNotSetUp, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";
import type { KybStatus } from "../blindpay/map";

/**
 * What Vestiarion keeps of bank payouts (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4, B11): the
 * workspace's BlindPay customer, and each vendor's bank account in use. Read in the workspace's scope. Before migration
 * 0124 nothing is there: reads answer none, and writes say bank payouts are not set up.
 */

export interface PayoutPartner {
  tosId: string | null;
  customerId: string | null;
  kybStatus: KybStatus | null;
  setUpAt: string | null;
}

export interface CounterpartyBankAccount {
  id: string;
  counterpartyId: string;
  externalId: string;
  bankCode: string;
  last4: string;
  beneficiaryName: string;
  status: "verifying" | "approved" | "rejected" | "deprecated";
  addedAt: string;
}

const BANK_COLUMNS = "id, counterparty_id, external_id, bank_code, last4, beneficiary_name, status, added_at";

type BankRow = { id: string; counterparty_id: string; external_id: string; bank_code: string; last4: string; beneficiary_name: string; status: CounterpartyBankAccount["status"]; added_at: string };

const bankOf = (row: BankRow): CounterpartyBankAccount => ({
  id: row.id,
  counterpartyId: row.counterparty_id,
  externalId: row.external_id,
  bankCode: row.bank_code,
  last4: row.last4,
  beneficiaryName: row.beneficiary_name,
  status: row.status,
  addedAt: row.added_at,
});

/** Throws `NotSetUpError` before migration 0124 has run. */
export async function bankPayoutsReady(): Promise<void> {
  const probe = await db().rpc("bank_payouts_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}

/** The bank accounts in use of these counterparties, by counterparty id; none before migration 0124. */
export async function bankAccountsOf(counterpartyIds: readonly string[], orgDb: Pick<ReturnType<typeof db>, "from"> = db()): Promise<Map<string, CounterpartyBankAccount>> {
  const ids = [...new Set(counterpartyIds)];
  if (ids.length === 0) return new Map();
  const read = await orgDb.from("counterparty_bank_accounts").select(BANK_COLUMNS).in("counterparty_id", ids).is("removed_at", null);
  if (read.error) {
    if (isNotSetUp(read.error)) return new Map();
    throw new Error(read.error.message);
  }
  return new Map(((read.data ?? []) as BankRow[]).map((row) => [row.counterparty_id, bankOf(row)]));
}

export async function readPayoutPartner(): Promise<PayoutPartner | null> {
  const read = await db().from("workspace_payout_partners").select("tos_id, customer_id, kyb_status, set_up_at").eq("provider", "blindpay").maybeSingle();
  if (read.error) {
    if (isNotSetUp(read.error)) return null;
    throw new Error(read.error.message);
  }
  const row = read.data as { tos_id: string | null; customer_id: string | null; kyb_status: KybStatus | null; set_up_at: string | null } | null;
  return row ? { tosId: row.tos_id, customerId: row.customer_id, kybStatus: row.kyb_status, setUpAt: row.set_up_at } : null;
}

/** Keeps what BlindPay answered for the workspace: the accepted terms, then the customer and its KYB status. */
export async function savePayoutPartner(orgId: string, patch: { tosId?: string; customerId?: string; kybStatus?: KybStatus; setUpBy?: string }): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    org_id: orgId,
    provider: "blindpay",
    updated_at: now,
    ...(patch.tosId ? { tos_id: patch.tosId } : {}),
    ...(patch.customerId ? { customer_id: patch.customerId, set_up_at: now, set_up_by: patch.setUpBy ?? null } : {}),
    ...(patch.kybStatus ? { kyb_status: patch.kybStatus } : {}),
  };
  const written = await db().from("workspace_payout_partners").upsert(row, { onConflict: "org_id,provider" });
  if (written.error) {
    if (isNotSetUp(written.error)) throw new NotSetUpError();
    throw new Error(written.error.message);
  }
}

/**
 * Puts a vendor's new bank account in use (B4): the one before, if any, removed in the same step, so one stays in use.
 * Only BlindPay's id, the CLABE's bank code and last four, and the beneficiary's name are written.
 */
export async function replaceBankAccount(input: {
  orgId: string;
  counterpartyId: string;
  externalId: string;
  bankCode: string;
  last4: string;
  beneficiaryName: string;
  status: CounterpartyBankAccount["status"];
  addedBy: string;
}): Promise<CounterpartyBankAccount> {
  const now = new Date().toISOString();
  const removed = await db().from("counterparty_bank_accounts").update({ removed_at: now }).eq("counterparty_id", input.counterpartyId).is("removed_at", null);
  if (removed.error) {
    if (isNotSetUp(removed.error)) throw new NotSetUpError();
    throw new Error(removed.error.message);
  }
  const inserted = await db()
    .from("counterparty_bank_accounts")
    .insert({
      org_id: input.orgId,
      counterparty_id: input.counterpartyId,
      external_id: input.externalId,
      bank_code: input.bankCode,
      last4: input.last4,
      beneficiary_name: input.beneficiaryName,
      status: input.status,
      added_by: input.addedBy,
    })
    .select(BANK_COLUMNS)
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return bankOf(inserted.data as BankRow);
}

/** Stops paying a vendor to its bank account: the account stays in the history, removed. */
export async function removeBankAccount(counterpartyId: string): Promise<boolean> {
  const removed = await db().from("counterparty_bank_accounts").update({ removed_at: new Date().toISOString() }).eq("counterparty_id", counterpartyId).is("removed_at", null).select("id");
  if (removed.error) {
    if (isNotSetUp(removed.error)) return false;
    throw new Error(removed.error.message);
  }
  return (removed.data ?? []).length > 0;
}

/** How many vendors are paid to a bank account now; none before migration 0124. */
export async function countBankAccountsInUse(): Promise<number> {
  const read = await db().from("counterparty_bank_accounts").select("id", { count: "exact", head: true }).is("removed_at", null);
  if (read.error) {
    if (isNotSetUp(read.error)) return 0;
    throw new Error(read.error.message);
  }
  return read.count ?? 0;
}
