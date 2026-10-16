import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSpeiAccount: vi.fn(),
  createCustomer: vi.fn(),
  readPayoutPartner: vi.fn(),
  savePayoutPartner: vi.fn(),
  replaceBankAccount: vi.fn(),
  removeBankAccount: vi.fn(),
  bankPayoutsReady: vi.fn(),
  ledger: vi.fn(),
  counterparty: { id: "cp-1", name: "Taller Norte", role: "vendor" } as { id: string; name: string; role: string } | null,
}));

vi.mock("@/lib/blindpay/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/blindpay/api")>()),
  createSpeiAccount: mocks.createSpeiAccount,
  createCustomer: mocks.createCustomer,
}));
vi.mock("@/lib/bank-payouts/store", () => ({
  readPayoutPartner: mocks.readPayoutPartner,
  savePayoutPartner: mocks.savePayoutPartner,
  replaceBankAccount: mocks.replaceBankAccount,
  removeBankAccount: mocks.removeBankAccount,
  bankPayoutsReady: mocks.bankPayoutsReady,
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/context", () => ({ currentOrgId: () => "org-1" }));
vi.mock("@/lib/dal", () => ({
  db: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.counterparty, error: null }) }) }) }) }),
}));

import { BankPayoutsError, finishBankPayoutsSetUp, setBankAccount, stopBankAccount } from "@/lib/bank-payouts/commands";

/**
 * What a person does with bank payouts (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4): the CLABE is
 * checked before BlindPay sees it, only a vendor is paid to a bank, Vestiarion keeps the bank and last four only, and the
 * ledger records each change without the account number.
 */

const CLABE = "032180000118359719";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLINDPAY_API_KEY", "test-key-not-real");
  vi.stubEnv("BLINDPAY_INSTANCE_ID", "in_TestInstanceAB");
  mocks.counterparty = { id: "cp-1", name: "Taller Norte", role: "vendor" };
  mocks.readPayoutPartner.mockResolvedValue({ tosId: "to_abcd1234", customerId: "re_abcd1234", kybStatus: "approved", setUpAt: "2026-10-16T08:00:00Z" });
  mocks.createSpeiAccount.mockResolvedValue({ id: "ba_000000000001", status: "approved" });
  mocks.replaceBankAccount.mockImplementation(async (input: Record<string, unknown>) => ({ id: "row-1", ...input }));
});

describe("a vendor's bank account (B4)", () => {
  it("is sent to BlindPay once its CLABE checks, and kept as its bank code and last four", async () => {
    const account = await setBankAccount({ actorId: "user-1", counterpartyId: "cp-1", beneficiaryName: "  Ana   López ", clabe: "0321 8000 0118 3597 19" });
    expect(mocks.createSpeiAccount).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "in_TestInstanceAB" }),
      { customerId: "re_abcd1234", beneficiaryName: "Ana López", clabe: CLABE, label: "Taller Norte" },
      expect.stringMatching(/^cp:cp-1:bank:[0-9a-f]{16}$/)
    );
    expect(mocks.replaceBankAccount).toHaveBeenCalledWith(expect.objectContaining({ bankCode: "032", last4: "9719", externalId: "ba_000000000001", beneficiaryName: "Ana López" }));
    expect(JSON.stringify(mocks.replaceBankAccount.mock.calls)).not.toContain(CLABE);
    expect(account).toMatchObject({ last4: "9719" });
    const entry = mocks.ledger.mock.calls[0][1] as { action: string; detail: Record<string, unknown> };
    expect(entry.action).toBe("counterparty_bank_account_set");
    expect(entry.detail).toMatchObject({ bankCode: "032", last4: "9719", rail: "spei", bankAccountId: "ba_000000000001" });
    expect(JSON.stringify(mocks.ledger.mock.calls)).not.toContain(CLABE);
  });

  it("refuses a CLABE that does not check, or a counterparty that is not a vendor, before BlindPay sees it", async () => {
    await expect(setBankAccount({ actorId: "user-1", counterpartyId: "cp-1", beneficiaryName: "Ana López", clabe: "032180000118359718" })).rejects.toThrow(/That CLABE does not check/);
    mocks.counterparty = { id: "cp-1", name: "Acme Buyer", role: "customer" };
    await expect(setBankAccount({ actorId: "user-1", counterpartyId: "cp-1", beneficiaryName: "Ana López", clabe: CLABE })).rejects.toThrow("Only a vendor's bills are paid to a bank account.");
    mocks.readPayoutPartner.mockResolvedValue(null);
    await expect(setBankAccount({ actorId: "user-1", counterpartyId: "cp-1", beneficiaryName: "Ana López", clabe: CLABE })).rejects.toThrow(BankPayoutsError);
    expect(mocks.createSpeiAccount).not.toHaveBeenCalled();
  });

  it("is stopped, and the ledger says so, only when one was in use", async () => {
    mocks.removeBankAccount.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await stopBankAccount({ actorId: "user-1", counterpartyId: "cp-1", counterpartyName: "Taller Norte" })).toBe(true);
    expect(await stopBankAccount({ actorId: "user-1", counterpartyId: "cp-1", counterpartyName: "Taller Norte" })).toBe(false);
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
  });
});

describe("setting the workspace up (B3)", () => {
  it("leaves a workspace set up already as it is", async () => {
    const answer = await finishBankPayoutsSetUp({ actorId: "user-1", tosId: "to_abcd1234", workspaceName: "Pinecrest Studio", contactEmail: "owner@example.com" });
    expect(answer).toEqual({ customerId: "re_abcd1234", kybStatus: "approved" });
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it("makes BlindPay's test business with the accepted terms, and records it", async () => {
    mocks.readPayoutPartner.mockResolvedValue(null);
    mocks.createCustomer.mockResolvedValue({ id: "re_000000000009", kybStatus: "approved" });
    await finishBankPayoutsSetUp({ actorId: "user-1", tosId: "to_abcd1234", workspaceName: "Pinecrest Studio", contactEmail: "owner@example.com" });
    expect(mocks.createCustomer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tos_id: "to_abcd1234", legal_name: "Pinecrest Studio", external_id: "org-1" }), "org:org-1:blindpay-customer:to_abcd1234");
    expect(mocks.savePayoutPartner).toHaveBeenLastCalledWith("org-1", { customerId: "re_000000000009", kybStatus: "approved", setUpBy: "user-1" });
    expect(mocks.ledger.mock.calls[0][1]).toMatchObject({ action: "bank_payouts_set_up", domain: "treasury" });
    await expect(finishBankPayoutsSetUp({ actorId: "user-1", tosId: "nope", workspaceName: "x", contactEmail: "x@example.com" })).rejects.toThrow(BankPayoutsError);
  });
});
