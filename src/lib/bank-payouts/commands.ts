import crypto from "node:crypto";
import { createCustomer, createSpeiAccount, getCustomer, termsUrl, testBusiness } from "../blindpay/api";
import { clabeBank, clabeShown, readClabe } from "../blindpay/clabe";
import { BlindpayError } from "../blindpay/http";
import { blindpaySettingsFromEnv, blindpayTermsReturnUri, type BlindpaySettings } from "../blindpay/settings";
import { NotSetUpError } from "../connectors/connections";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { bankPayoutsReady, readPayoutPartner, removeBankAccount, replaceBankAccount, savePayoutPartner, type CounterpartyBankAccount } from "./store";

/**
 * What a person does with bank payouts (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4): an owner sets
 * the workspace up with BlindPay, and an owner or admin puts a vendor's Mexican bank account in use, or stops using it.
 * Each is recorded in the signed ledger, with only the bank's code and the last four digits of an account.
 */

export class BankPayoutsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankPayoutsError";
  }
}

const NOT_ON = "Bank payouts are not set up on this deployment.";

function settingsOrThrow(): BlindpaySettings {
  const settings = blindpaySettingsFromEnv();
  if (!settings) throw new BankPayoutsError(NOT_ON);
  return settings;
}

async function readyOrThrow(): Promise<void> {
  try {
    await bankPayoutsReady();
  } catch (error) {
    if (error instanceof NotSetUpError) throw new BankPayoutsError("Bank payouts are not set up on this deployment yet.");
    throw error;
  }
}

/** Step 1 (B3): a link to BlindPay's terms, which sends the owner back to finish setting up. */
export async function bankPayoutsTermsLink(input: { origin: string; orgSlug: string }): Promise<string> {
  const settings = settingsOrThrow();
  await readyOrThrow();
  return termsUrl(settings, { idempotencyKey: crypto.randomUUID(), redirectUrl: blindpayTermsReturnUri(input.origin, input.orgSlug) });
}

/**
 * Step 2 (B3): the workspace's BlindPay business customer, made with the accepted terms. In this version BlindPay's own
 * test values, on a development instance; never a real business's or person's details. A workspace set up already is
 * left as it is.
 */
export async function finishBankPayoutsSetUp(input: { actorId: string; tosId: string; workspaceName: string; contactEmail: string }): Promise<{ customerId: string; kybStatus: string }> {
  const settings = settingsOrThrow();
  await readyOrThrow();
  if (!/^to_[A-Za-z0-9_]{4,60}$/.test(input.tosId)) throw new BankPayoutsError("BlindPay did not send back the accepted terms. Start again from Settings, Bank payouts.");
  const orgId = currentOrgId();
  const before = await readPayoutPartner();
  if (before?.customerId) return { customerId: before.customerId, kybStatus: before.kybStatus ?? "verifying" };
  await savePayoutPartner(orgId, { tosId: input.tosId });
  let customer: { id: string; kybStatus: string };
  try {
    customer = await createCustomer(
      settings,
      testBusiness({ tosId: input.tosId, legalName: input.workspaceName, email: input.contactEmail, externalId: orgId }),
      `org:${orgId}:blindpay-customer:${input.tosId}`
    );
  } catch (error) {
    console.error("bank payouts: BlindPay did not make the customer", error instanceof BlindpayError ? `${error.status} ${error.code ?? ""}` : "unknown error");
    throw new BankPayoutsError("BlindPay did not finish setting the workspace up. Try again in a moment.");
  }
  await savePayoutPartner(orgId, { customerId: customer.id, kybStatus: customer.kybStatus as never, setUpBy: input.actorId });
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "treasury",
    action: "bank_payouts_set_up",
    summary: "Bank payouts set up with BlindPay",
    detail: { by: input.actorId, provider: "blindpay", customerId: customer.id, kybStatus: customer.kybStatus, tosId: input.tosId },
  });
  return { customerId: customer.id, kybStatus: customer.kybStatus };
}

/** The workspace's KYB status, read again from BlindPay and kept (B9's `customer.update`). */
export async function refreshPartnerStatus(): Promise<void> {
  const settings = blindpaySettingsFromEnv();
  const partner = settings ? await readPayoutPartner() : null;
  if (!settings || !partner?.customerId) return;
  const customer = await getCustomer(settings, partner.customerId);
  if (customer.kybStatus !== partner.kybStatus) await savePayoutPartner(currentOrgId(), { kybStatus: customer.kybStatus });
}

/**
 * A vendor's Mexican bank account put in use (B4): the CLABE checked, sent to BlindPay as a third party's account, and
 * only its bank code and last four kept. The account before it, if any, is removed in the same step.
 */
export async function setBankAccount(input: { actorId: string; counterpartyId: string; beneficiaryName: string; clabe: string }): Promise<CounterpartyBankAccount> {
  const settings = settingsOrThrow();
  await readyOrThrow();
  const digits = readClabe(input.clabe);
  if (!digits) throw new BankPayoutsError("That CLABE does not check: it is 18 digits, the last one a control digit. Check it with the vendor.");
  const beneficiaryName = input.beneficiaryName.trim().replace(/\s+/g, " ");
  if (beneficiaryName.length < 2 || beneficiaryName.length > 128) throw new BankPayoutsError("Enter the name the bank account is held in.");
  const partner = await readPayoutPartner();
  if (!partner?.customerId) throw new BankPayoutsError("Set up bank payouts under Settings, Bank payouts, first.");
  const read = await db().from("counterparties").select("id, name, role").eq("id", input.counterpartyId).maybeSingle();
  if (read.error) throw new Error(read.error.message);
  const counterparty = read.data as { id: string; name: string; role: string | null } | null;
  if (!counterparty) throw new BankPayoutsError("Counterparty not found.");
  if (counterparty.role !== "vendor") throw new BankPayoutsError("Only a vendor's bills are paid to a bank account.");

  const shown = clabeShown(digits);
  const fingerprint = crypto.createHash("sha256").update(digits).digest("hex").slice(0, 16);
  let made: { id: string; status: CounterpartyBankAccount["status"] };
  try {
    made = await createSpeiAccount(settings, { customerId: partner.customerId, beneficiaryName, clabe: digits, label: counterparty.name }, `cp:${counterparty.id}:bank:${fingerprint}`);
  } catch (error) {
    console.error("bank payouts: BlindPay did not take the bank account", error instanceof BlindpayError ? `${error.status} ${error.code ?? ""}` : "unknown error");
    throw new BankPayoutsError(
      error instanceof BlindpayError && error.status >= 400 && error.status < 500
        ? "BlindPay refused this bank account. Check the CLABE and the beneficiary's name with the vendor."
        : "BlindPay did not answer. Try again in a moment."
    );
  }
  const orgId = currentOrgId();
  const account = await replaceBankAccount({
    orgId,
    counterpartyId: counterparty.id,
    externalId: made.id,
    bankCode: shown.bankCode,
    last4: shown.last4,
    beneficiaryName,
    status: made.status,
    addedBy: input.actorId,
  });
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "compliance",
    action: "counterparty_bank_account_set",
    summary: `${counterparty.name} is paid to a bank account in Mexico: ${clabeBank(shown.bankCode)} ····${shown.last4}`,
    detail: {
      by: input.actorId,
      counterpartyId: counterparty.id,
      provider: "blindpay",
      bankAccountId: made.id,
      rail: "spei",
      bankCode: shown.bankCode,
      last4: shown.last4,
      status: made.status,
    },
  });
  return account;
}

/** Stops paying a vendor to its bank account: its address is paid again (B4). */
export async function stopBankAccount(input: { actorId: string; counterpartyId: string; counterpartyName: string }): Promise<boolean> {
  const removed = await removeBankAccount(input.counterpartyId);
  if (removed) {
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "compliance",
      action: "counterparty_bank_account_set",
      summary: `${input.counterpartyName} is no longer paid to a bank account`,
      detail: { by: input.actorId, counterpartyId: input.counterpartyId, provider: "blindpay", bankAccountId: null },
    });
  }
  return removed;
}
