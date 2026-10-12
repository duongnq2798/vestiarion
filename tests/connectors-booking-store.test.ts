import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { PostingRow } from "@/lib/connectors/booking-run";
import { bookingStore } from "@/lib/connectors/booking-store";
import { NotSetUpError, type Connection } from "@/lib/connectors/connections";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The bookings' database (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W2, W3, W6), as the requests
 * PostgREST would receive in the workspace's scope: the payables paid on Arc from a connection's bills, a simulated
 * payment left out; a second draft of the same payable a no-op; each transition a compare-and-set on the state, a claim
 * taking a send only once its lease ran out; and migration 0106 missing read as not set up.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c02";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c03";
const SIMULATED = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c04";
const BOOKED = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c05";
const HASH = `0x${"3c".repeat(32)}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const connection = { id: CONNECTION, orgId: ORG, provider: "xero", externalOrgId: "tenant-1" } as Connection;

const POSTING = {
  id: "posting-1", connection_id: CONNECTION, provider: "xero", external_org_id: "tenant-1", invoice_id: INVOICE, bill_external_id: "bill-1",
  amount: "31.390000", currency: "USD", paid_on: "2026-10-12", reference: HASH, network: "arc-testnet", shadow: true, paid_amount: 31.39, paid_token: "USDC",
  network_fee: null, organisation_demo: true, state: "draft", reason: null, message: null, account: null, fingerprint: null, attempts: 0,
  external_payment_id: null, sending_until: null, approved_by: null, approved_at: null, sent_at: null, confirmed_at: null, created_at: "2026-10-12T09:20:00Z",
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  return { fake, run };
}

describe("bookingStore.candidates (W3)", () => {
  it("reads the paid payables linked to the connection's bills, with their confirmed live payment, and leaves out one booked or simulated", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/external_links") {
        return { body: [{ external_id: "bill-1", local_id: INVOICE }, { external_id: "bill-2", local_id: SIMULATED }, { external_id: "bill-3", local_id: BOOKED }] };
      }
      if (sent.path === "/rest/v1/accounting_postings") return { body: [{ invoice_id: BOOKED }] };
      if (sent.path === "/rest/v1/invoices") {
        return {
          body: [
            { id: INVOICE, amount: "31.39", currency: "USDC", paid_amount: null, original_currency: "USD", original_amount: "31.39", tx_ref: HASH, settled_at: "2026-10-12T09:15:00Z" },
            { id: SIMULATED, amount: "5", currency: "USDC", paid_amount: null, original_currency: null, original_amount: null, tx_ref: "sim-1", settled_at: "2026-10-12T09:15:00Z" },
          ],
        };
      }
      if (sent.path === "/rest/v1/payment_intents") {
        return {
          body: [
            { source_id: INVOICE, provider: "circle", provider_mode: "live", tx_hash: HASH, confirmed_at: "2026-10-12T09:14:41Z", fee_usd: "0.0021", bridge_fee: null, network: "arc-testnet" },
            { source_id: SIMULATED, provider: "simulate", provider_mode: "simulate", tx_hash: null, confirmed_at: "2026-10-12T09:14:41Z", fee_usd: null, bridge_fee: null, network: "arc-testnet" },
          ],
        };
      }
      if (sent.path === "/rest/v1/accounting_bills") return { body: [{ external_id: "bill-1", currency: "USD", source_status: "open", amount_due: "31.39", number: "Inv-2026-10", contact_name: "Xero" }] };
      return undefined;
    });
    const candidates = await run(() => bookingStore.candidates(connection));
    expect(candidates).toEqual([
      {
        invoiceId: INVOICE,
        billExternalId: "bill-1",
        network: "arc-testnet",
        invoice: { amount: 31.39, currency: "USDC", paidAmount: null, originalCurrency: "USD", originalAmount: 31.39, txRef: HASH, settledAt: "2026-10-12T09:15:00Z" },
        intent: { txHash: HASH, confirmedAt: "2026-10-12T09:14:41Z", feeUsd: 0.0021, bridgeFee: null },
        bill: { currency: "USD", sourceStatus: "open", amountDue: "31.39", number: "Inv-2026-10", contactName: "Xero" },
      },
    ]);
    const invoices = fake.requests.find((sent) => sent.path === "/rest/v1/invoices");
    expect(invoices?.params.get("status")).toBe("eq.paid");
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    expect(invoices?.params.get("id")).not.toContain(BOOKED);
    const intents = fake.requests.find((sent) => sent.path === "/rest/v1/payment_intents");
    expect(intents?.params.get("status")).toBe("eq.confirmed");
    // Every read names the workspace.
    expect(fake.requests.filter((sent) => sent.path.startsWith("/rest/v1/") && !sent.path.includes("orgs") && !sent.path.includes("rpc")).every((sent) => sent.params.get("org_id") === `eq.${ORG}`)).toBe(true);
  });
});

describe("bookingStore.insert and move (W2, W6)", () => {
  it("treats a second draft of the same payable as already drafted", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/accounting_postings" && sent.method === "POST" ? { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } : undefined));
    const row = await run(() =>
      bookingStore.insert(connection, {
        invoiceId: INVOICE,
        billExternalId: "bill-1",
        facts: { amount: "31.39", currency: "USD", paidOn: "2026-10-12", reference: HASH, paidAmount: "31.39", paidToken: "USDC", networkFee: null },
        network: "arc-testnet",
        shadow: true,
        organisationDemo: true,
        state: "draft",
        reason: null,
        message: null,
      })
    );
    expect(row).toBeNull();
  });

  it("claims a draft or a failed booking, or a send past its lease, over the attempts it read", async () => {
    const { fake, run } = world((sent) => (sent.method === "PATCH" ? { body: [{ ...POSTING, state: "sending", attempts: 1 }] } : undefined));
    const posting = { id: "posting-1", attempts: 0 } as PostingRow;
    const moved = await run(() =>
      bookingStore.move(posting, ["draft", "failed", "sending"], "sending", { attempts: 1, fingerprint: "f".repeat(64), sendingUntil: "2026-10-12T09:32:00.000Z" }, { leaseOverAt: "2026-10-12T09:30:00.000Z" })
    );
    expect(moved).toMatchObject({ state: "sending", attempts: 1, amount: "31.39", paidOn: "2026-10-12" });
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.params.get("id")).toBe("eq.posting-1");
    expect(patch?.params.get("attempts")).toBe("eq.0");
    expect(patch?.params.get("or")).toBe("(state.in.(draft,failed),and(state.eq.sending,or(sending_until.is.null,sending_until.lte.2026-10-12T09:30:00.000Z)))");
    expect(patch?.body).toEqual({ state: "sending", attempts: 1, fingerprint: "f".repeat(64), sending_until: "2026-10-12T09:32:00.000Z" });
  });

  it("moves only from the states named, and says so when the row was in none of them", async () => {
    const { fake, run } = world((sent) => (sent.method === "PATCH" ? { body: [] } : undefined));
    expect(await run(() => bookingStore.move({ id: "posting-1", attempts: 1 } as PostingRow, ["sending"], "sent", { externalPaymentId: "pay-1", sentAt: "2026-10-12T09:31:00.000Z" }))).toBeNull();
    expect(fake.requests.find((sent) => sent.method === "PATCH")?.params.get("state")).toBe("in.(sending)");
  });

  it("reads a missing table as not set up (before migration 0106)", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/accounting_postings" ? { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.accounting_postings'" } } : undefined));
    await expect(run(() => bookingStore.inFlight(CONNECTION, "2026-10-12T09:30:00.000Z"))).rejects.toBeInstanceOf(NotSetUpError);
  });
});
