import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { LedgerEntry } from "@/lib/ledger";
import { checkVendorStatement, VendorStatementError } from "@/lib/vendor-statement/check";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * Checking a vendor's statement on the server (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS2-VS6):
 * the statement read again, the vendor's bills, numbers and confirmed payments read in scope, and the check signed with
 * its counts only, never the file or its lines.
 */

const { entriesMock, ledgerMock } = vi.hoisted(() => ({ entriesMock: vi.fn(), ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), listLedgerEntriesForTargets: entriesMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const VENDOR = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const BILL_A = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const BILL_B = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b2";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const STATEMENT = [
  "Date,Invoice No,Description,Debit,Credit,Balance",
  "2026-10-01,INV-1001,Design sprint,100.00,,100.00",
  "2026-10-03,INV-1002,Illustrations,60.00,,160.00",
  "2026-10-06,INV-1003,Revisions,25.00,,185.00",
  "2026-10-08,,Payment received - thank you,,100.00,85.00",
].join("\n");

const created = (seq: number, invoiceId: string, invoiceNumber: string): LedgerEntry => ({
  seq, id: `e${seq}`, ts: "2026-10-01T00:00:00Z", actor: "human", domain: "ap", action: "create_invoice", summary: "", detail: { invoiceId, invoiceNumber },
  bodyHash: "b", signature: "s", prevHash: "p", hash: "h", signingKeyId: "k",
});

const orgs = signedOrgs();

function world(vendorRole = "vendor") {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (request.path === "/rest/v1/counterparties") return { body: { id: VENDOR, name: "Northstar Studio", role: vendorRole } };
    if (request.path === "/rest/v1/invoices") {
      return {
        body: [
          { id: BILL_A, amount: "100.000000", currency: "USDC", status: "paid", memo: "Design sprint", created_at: "2026-10-01T09:00:00Z", original_amount: null, original_currency: null },
          { id: BILL_B, amount: "65.000000", currency: "USDC", status: "pending", memo: "Illustrations", created_at: "2026-10-04T09:00:00Z", original_amount: null, original_currency: null },
        ],
      };
    }
    if (request.path === "/rest/v1/payment_intents") {
      return {
        body: [
          { source_id: BILL_A, amount: "100.000000", token: "USDC", confirmed_at: "2026-10-07T10:00:00Z", tx_hash: `0x${"a".repeat(64)}`, mint_tx_hash: null, chain: "ARC-TESTNET", destination_chain: null, network: "arc-testnet" },
        ],
      };
    }
    return { body: [] };
  });
}

async function run<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) {
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
}

beforeEach(() => {
  entriesMock.mockReset().mockResolvedValue([created(1, BILL_A, "INV-1001"), created(2, BILL_B, "INV-1002")]);
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("checkVendorStatement", () => {
  it("matches the statement against the vendor's bills and payments, read in scope", async () => {
    const fake = world();
    const result = await run(fake, () => checkVendorStatement({ actorId: USER, counterpartyId: VENDOR, source: STATEMENT, choices: { currency: "USD" }, today: "2026-10-22" }));
    expect(result.vendorName).toBe("Northstar Studio");
    expect(result.counts).toEqual({ lines: 4, charges: 3, payments: 1, matchedCharges: 2, matchedPayments: 1 });
    expect(result.differs).toEqual([expect.objectContaining({ number: "INV-1002", theirs: 60, ours: 65 })]);
    expect(result.missing).toEqual([expect.objectContaining({ number: "INV-1003", amount: 25 })]);
    expect(result.balance).toEqual({ theirs: 85, ours: 65 });
    // Only this vendor's payables, and only confirmed payments for its bills.
    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("counterparty_id")).toBe(`eq.${VENDOR}`);
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    const intents = fake.requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(intents?.params.get("status")).toBe("eq.confirmed");
    expect(intents?.params.get("source_id")).toBe(`in.(${BILL_A},${BILL_B})`);
    expect(entriesMock).toHaveBeenCalledWith({ invoiceIds: [BILL_A, BILL_B] });
  });

  it("signs vendor_statement_checked with its counts only, never the file or its lines (VS5)", async () => {
    await run(world(), () => checkVendorStatement({ actorId: USER, counterpartyId: VENDOR, source: STATEMENT, choices: { currency: "USD" }, today: "2026-10-22" }));
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    const [orgId, entry] = ledgerMock.mock.calls[0] as [string, { action: string; actor: string; domain: string; detail: Record<string, unknown> }];
    expect(orgId).toBe(ORG);
    expect(entry).toMatchObject({ action: "vendor_statement_checked", actor: "human", domain: "ap" });
    expect(entry.detail).toEqual({
      by: USER, counterpartyId: VENDOR, period: { from: "2026-10-01", to: "2026-10-08" }, currency: "USD",
      lines: 4, charges: 3, payments: 1, matchedCharges: 2, matchedPayments: 1,
      missing: 1, twice: 0, differs: 1, paidNotListed: 0, unknownPayments: 0, notListed: 0, theirBalance: 85, ourBalance: 65,
    });
    expect(JSON.stringify(entry)).not.toMatch(/Illustrations|Revisions|INV-1003/);
  });

  it("refuses a counterparty that is not a vendor, a statement that is not ready, and one in two currencies", async () => {
    await expect(run(world("client"), () => checkVendorStatement({ actorId: USER, counterpartyId: VENDOR, source: STATEMENT, choices: { currency: "USD" }, today: "2026-10-22" }))).rejects.toThrow(
      new VendorStatementError("Only a vendor's statement is checked here.")
    );
    await expect(run(world(), () => checkVendorStatement({ actorId: USER, counterpartyId: VENDOR, source: STATEMENT, choices: {}, today: "2026-10-22" }))).rejects.toThrow(
      "Type the account's currency, such as SGD, EUR or USDC."
    );
    const mixed = ["Date,Invoice No,Type,Debit,Credit,Currency", "2026-10-01,A-1,Invoice,10.00,,USD", "2026-10-02,A-2,Invoice,10.00,,EUR"].join("\n");
    await expect(run(world(), () => checkVendorStatement({ actorId: USER, counterpartyId: VENDOR, source: mixed, choices: {}, today: "2026-10-22" }))).rejects.toThrow(/more than one currency/);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});
