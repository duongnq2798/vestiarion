import { blindpayCall, type BlindpayHttp } from "./http";
import { mapBankAccount, mapCustomer, mapPayout, mapQuote, type BlindpayPayout, type BlindpayQuote, type KybStatus } from "./map";
import type { BlindpaySettings } from "./settings";

/**
 * BlindPay's calls Vestiarion makes (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4, B7, B8): the terms
 * link, the workspace's business customer, a vendor's SPEI bank account, a quote, an EVM payout, and reading a payout or
 * a customer back. Every POST that makes something carries an idempotency key from the caller, derived from what it is
 * for, so a retry makes nothing twice.
 */

type Settings = Pick<BlindpaySettings, "apiKey" | "instanceId">;

/** A link to BlindPay's terms, accepted on BlindPay's own page, which sends the owner back with `tos_id` (B3). */
export async function termsUrl(settings: Settings, input: { idempotencyKey: string; redirectUrl: string }, deps: BlindpayHttp = {}): Promise<string> {
  const body = await blindpayCall(
    settings,
    "POST",
    "/v1/e/instances/{instance}/tos",
    { body: { idempotency_key: input.idempotencyKey, redirect_url: input.redirectUrl }, label: "terms link" },
    deps
  );
  const url = typeof body === "object" && body !== null && typeof (body as { url?: unknown }).url === "string" ? (body as { url: string }).url : null;
  if (!url || !url.startsWith("https://")) throw new Error("BlindPay's terms link answer did not read");
  return url;
}

/**
 * BlindPay's test business, for a development instance only (B3): BlindPay approves a development customer whatever
 * its documents, so these are its test values, never a real business's or person's. A production instance needs real
 * KYB, which this version does not collect.
 */
export function testBusiness(input: { tosId: string; legalName: string; email: string; externalId: string }) {
  const placeholder = "https://www.vestiarion.xyz/blindpay-development-test-document.pdf";
  return {
    type: "business",
    kyc_type: "standard",
    tos_id: input.tosId,
    external_id: input.externalId,
    email: input.email,
    legal_name: input.legalName.slice(0, 120),
    tax_id: "000000000",
    formation_date: "2020-01-01T00:00:00.000Z",
    website: "https://www.vestiarion.xyz",
    address_line_1: "1 Test Street",
    city: "San Francisco",
    state_province_region: "CA",
    country: "US",
    postal_code: "94105",
    incorporation_doc_file: placeholder,
    proof_of_ownership_doc_file: placeholder,
    proof_of_address_doc_type: "UTILITY_BILL",
    proof_of_address_doc_file: placeholder,
    owners: [
      {
        role: "beneficial_controlling",
        first_name: "Test",
        last_name: "Owner",
        date_of_birth: "1990-01-01T00:00:00.000Z",
        tax_id: "000000000",
        tax_type: "SSN",
        address_line_1: "1 Test Street",
        city: "San Francisco",
        state_province_region: "CA",
        country: "US",
        postal_code: "94105",
        id_doc_country: "US",
        id_doc_type: "PASSPORT",
        id_doc_front_file: placeholder,
        proof_of_address_doc_type: "UTILITY_BILL",
        proof_of_address_doc_file: placeholder,
        ownership_percentage: 100,
      },
    ],
  };
}

export async function createCustomer(settings: Settings, body: unknown, idempotencyKey: string, deps: BlindpayHttp = {}): Promise<{ id: string; kybStatus: KybStatus }> {
  return mapCustomer(await blindpayCall(settings, "POST", "/customers", { body, idempotencyKey, label: "customer" }, deps));
}

export async function getCustomer(settings: Settings, customerId: string, deps: BlindpayHttp = {}): Promise<{ id: string; kybStatus: KybStatus }> {
  return mapCustomer(await blindpayCall(settings, "GET", `/customers/${encodeURIComponent(customerId)}`, { label: "customer" }, deps));
}

/** A vendor's Mexican bank account, as a third party's (B4): its CLABE goes to BlindPay and is not kept here. */
export async function createSpeiAccount(
  settings: Settings,
  input: { customerId: string; beneficiaryName: string; clabe: string; label: string },
  idempotencyKey: string,
  deps: BlindpayHttp = {}
) {
  return mapBankAccount(
    await blindpayCall(
      settings,
      "POST",
      `/customers/${encodeURIComponent(input.customerId)}/bank-accounts`,
      {
        body: {
          type: "spei_bitso",
          name: input.label.slice(0, 64),
          beneficiary_name: input.beneficiaryName.slice(0, 128),
          spei_protocol: "clabe",
          spei_clabe: input.clabe,
          recipient_relationship: "vendor_or_supplier",
        },
        idempotencyKey,
        label: "bank account",
      },
      deps
    )
  );
}

export async function getBankAccount(settings: Settings, input: { customerId: string; bankAccountId: string }, deps: BlindpayHttp = {}) {
  return mapBankAccount(
    await blindpayCall(settings, "GET", `/customers/${encodeURIComponent(input.customerId)}/bank-accounts/${encodeURIComponent(input.bankAccountId)}`, { label: "bank account" }, deps)
  );
}

/** BlindPay quotes at least 5.00 to a bank account. */
export const MIN_QUOTE = 5;

/**
 * A quote for paying `amount` of the token to the bank account (B5, B7): the business pays the amount exactly
 * (`currency_type: sender`), and BlindPay's fees come out of what the vendor receives (`cover_fees: false`).
 */
export async function createQuote(
  settings: Settings,
  input: { bankAccountId: string; amount: number; network: string; token: "USDC" | "USDB" },
  idempotencyKey: string | undefined,
  deps: BlindpayHttp = {}
): Promise<BlindpayQuote> {
  return mapQuote(
    await blindpayCall(
      settings,
      "POST",
      "/quotes",
      {
        body: {
          bank_account_id: input.bankAccountId,
          currency_type: "sender",
          cover_fees: false,
          request_amount: Math.round(input.amount * 100),
          network: input.network,
          token: input.token,
        },
        idempotencyKey,
        label: "quote",
      },
      deps
    )
  );
}

/** The payout of a quote from the sender's own wallet, which approved the BlindPay contract for its amount (B7). */
export async function createEvmPayout(settings: Settings, input: { quoteId: string; senderWalletAddress: string }, idempotencyKey: string, deps: BlindpayHttp = {}): Promise<BlindpayPayout> {
  return mapPayout(
    await blindpayCall(settings, "POST", "/payouts/evm", { body: { quote_id: input.quoteId, sender_wallet_address: input.senderWalletAddress }, idempotencyKey, label: "payout" }, deps)
  );
}

export async function getPayout(settings: Settings, payoutId: string, deps: BlindpayHttp = {}): Promise<BlindpayPayout> {
  return mapPayout(await blindpayCall(settings, "GET", `/payouts/${encodeURIComponent(payoutId)}`, { label: "payout" }, deps));
}
