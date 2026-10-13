import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { bookAccountingPayments, bookingMessage, MAX_BOOKINGS } from "@/lib/commands/bookings";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { can } from "@/lib/auth/roles";
import { postingFingerprint } from "@/lib/connectors/posting";
import type { AccountingProvider, BookingProvider, ExternalPayment } from "@/lib/connectors/provider";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Booking payments made on Arc in Xero, as a command (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W6, W7, W8): `accounting.book` for owners and admins, the console only, at most 10 lines; refused before anything is
 * sent without the write scope, without an account, or without a ledger that signs; each line with its own checks.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a11",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a12",
  mocks: { ledger: vi.fn(), canSign: vi.fn(), token: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: mocks.ledger, assertLedgerCanSign: mocks.canSign }));
vi.mock("@/lib/connectors/token-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/connectors/token-store")>()), connectionTokenStore: () => ({}) }));
vi.mock("@/lib/connectors/tokens", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/connectors/tokens")>()), freshAccessToken: mocks.token }));

const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a13";
const POSTING = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a14";
const OTHER_POSTING = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a15";
const BILL = "0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0101";
const HASH = `0x${"3c".repeat(32)}`;
const ACCOUNT = { id: "6f7594f2-f059-4d56-9e67-47ac9733bfe9", code: "091", name: "Arc USDC wallet", currency: "USD" };
const SCOPES = ["offline_access", "accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read", "accounting.payments"];
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const connectionRow = (fields: Record<string, unknown> = {}) => ({
  id: CONNECTION, org_id: ORG, provider: "xero", external_org_id: "tenant-1", external_org_name: "Demo Company (Global)", status: "connected", scopes: SCOPES,
  connected_by: USER, connected_at: "2026-10-12T07:00:00Z", consent_version: "xero-2026-10-12.2", consented_at: "2026-10-12T07:00:00Z", revoked_at: null,
  window_from: "2026-07-14", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
  payment_account: ACCOUNT, payment_account_at: "2026-10-12T07:10:00Z", ...fields,
});

const postingRow = (id = POSTING) => ({
  id, connection_id: CONNECTION, provider: "xero", external_org_id: "tenant-1", invoice_id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a16", bill_external_id: BILL,
  amount: 31.39, currency: "USD", paid_on: "2026-10-12", reference: HASH, network: "arc-testnet", shadow: true, paid_amount: 31.39, paid_token: "USDC",
  network_fee: 0.0021, organisation_demo: true, state: "draft", reason: null, message: null, account: null, fingerprint: null, attempts: 0,
  external_payment_id: null, sending_until: null, approved_by: null, approved_at: null, sent_at: null, confirmed_at: null, created_at: "2026-10-12T09:20:00Z",
});

const SHOWN = postingFingerprint({ billExternalId: BILL, bill: { amountDue: "31.39", status: "open" }, amount: "31.39", currency: "USD", accountId: ACCOUNT.id, paidOn: "2026-10-12", reference: HASH });

const made: ExternalPayment = { externalId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379", billExternalId: BILL, accountExternalId: ACCOUNT.id, amount: "31.39", currency: "USD", date: "2026-10-12", reference: HASH, status: "active" };

function xero(demo = true) {
  const booking = {
    writeScopes: ["accounting.payments"],
    organisation: vi.fn(async () => ({ externalOrgId: "tenant-1", name: "Demo Company (Global)", demo, baseCurrency: "USD" })),
    bill: vi.fn(async () => ({ externalId: BILL, version: "v", updatedAt: "2026-10-12T08:00:00Z", contactExternalId: null, contactName: "Xero", number: "Inv-2026-10", reference: null, currency: "USD", total: "31.39", amountDue: "31.39", issuedOn: null, dueOn: null, status: "open" as const })),
    findPayment: vi.fn(async () => null),
    bookPayment: vi.fn(async () => ({ ok: true as const, payment: made })),
    payment: vi.fn(async () => made),
  } satisfies BookingProvider;
  const provider = { id: "xero", label: "Xero", scopes: [], refresh: vi.fn(), booking } as unknown as AccountingProvider;
  return { provider, booking };
}

function world(options: { connection?: FakeReply } = {}) {
  let row: Record<string, unknown> = postingRow();
  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/orgs") return { body: { id: ORG, slug: "acme", name: "Acme", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    if (sent.path === "/rest/v1/accounting_connections") return options.connection ?? { body: [connectionRow()] };
    if (sent.path === "/rest/v1/accounting_postings" && sent.method === "GET") {
      const id = sent.params.get("id")?.replace(/^eq\./, "");
      return { body: id === row.id ? [row] : [] };
    }
    if (sent.path === "/rest/v1/accounting_postings" && sent.method === "PATCH") {
      const states = (sent.params.get("state") ?? sent.params.get("or") ?? "").toString();
      if (!states.includes(String(row.state))) return { body: [] };
      row = { ...row, ...(sent.body as Record<string, unknown>) };
      return { body: [row] };
    }
    if (sent.path === "/rest/v1/accounting_bills") return { body: [{ external_id: BILL, amount_due: 31.39, source_status: "open", currency: "USD", number: "Inv-2026-10", contact_name: "Xero" }] };
    return { body: [] };
  };
  const fake = fakeSupabase(respond);
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run, row: () => row };
}

const actor = (role: Actor["role"] = "owner", surface: Actor["surface"] = { kind: "console" }): Actor => ({ orgId: ORG, userId: USER, role, mode: "live", surface });
const line = { postingId: POSTING, fingerprint: SHOWN };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.ledger.mockResolvedValue(undefined);
  mocks.canSign.mockReturnValue(undefined);
  mocks.token.mockResolvedValue({ ok: true, accessToken: "token" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the permission and the surface (W6)", () => {
  it("is accounting.book, an owner's, an admin's or an accountant's, from the console only", () => {
    expect(COMMAND_PERMISSIONS["accounting.book_payments"]).toBe("accounting.book");
    expect(["owner", "admin", "approver", "accountant", "viewer"].filter((role) => can(role as Actor["role"], "accounting.book"))).toEqual(["owner", "admin", "accountant"]);
    expect(Object.entries(SURFACE_COMMANDS).filter(([, commands]) => commands.includes("accounting.book_payments")).map(([surface]) => surface)).toEqual(["console"]);
  });

  it("is refused to an approver, and from the API, before anything is read", async () => {
    const { fake, run } = world();
    const { provider } = xero();
    expect(await run(() => bookAccountingPayments(actor("approver"), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => bookAccountingPayments(actor("owner", { kind: "api", apiKeyId: "k" }), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({ ok: false, code: "surface" });
    expect(fake.requests.filter((request) => request.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it(`takes at most ${MAX_BOOKINGS} bookings at once, and none without a fingerprint`, async () => {
    const { run } = world();
    const { provider } = xero();
    const many = Array.from({ length: MAX_BOOKINGS + 1 }, (_, index) => ({ postingId: `0b6c1c9e-4a4f-4a7e-9b1e-0000000001${String(index).padStart(2, "0")}`, fingerprint: SHOWN }));
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: many }, { provider }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [{ postingId: POSTING, fingerprint: "seen" }] }, { provider }))).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("before anything is sent (W7, W8)", () => {
  it("asks to allow booking when the connection was made without the write scope", async () => {
    const { run } = world({ connection: { body: [connectionRow({ scopes: SCOPES.slice(0, 4) })] } });
    const { provider, booking } = xero();
    const outcome = await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }));
    expect(outcome).toMatchObject({ ok: false, code: "scope", message: expect.stringContaining("Allow Vestiarion to book payments") });
    expect(booking.organisation).not.toHaveBeenCalled();
  });

  it("asks to choose where payments are booked when no account is chosen", async () => {
    const { run } = world({ connection: { body: [connectionRow({ payment_account: null })] } });
    const { provider, booking } = xero();
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({
      ok: false,
      code: "no_account",
      message: "Choose where payments are booked first, on the Xero card in Settings.",
    });
    expect(booking.bookPayment).not.toHaveBeenCalled();
  });

  it("sends nothing while the ledger cannot sign", async () => {
    mocks.canSign.mockImplementation(() => {
      throw new Error("no key");
    });
    const { run } = world();
    const { provider, booking } = xero();
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({ ok: false, code: "ledger" });
    expect(booking.organisation).not.toHaveBeenCalled();
  });

  it("asks to reconnect when the token is no longer taken", async () => {
    mocks.token.mockResolvedValue({ ok: false, reason: "reconnect" });
    const { run } = world();
    const { provider } = xero();
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({ ok: false, code: "reconnect" });
  });

  it("lets an accountant book on a connection agreed under the words that name the accountant (accountant console A1)", async () => {
    const { run } = world({ connection: { body: [connectionRow({ consent_version: "xero-2026-10-13" })] } });
    const { provider, booking } = xero();
    const outcome = await run(() => bookAccountingPayments(actor("accountant"), { connectionId: CONNECTION, lines: [line] }, { provider }));
    expect(outcome).toMatchObject({ ok: true, message: "Booked 1 payment in Xero." });
    expect(booking.bookPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses an accountant on a connection agreed when only an owner or admin approved, and says who can", async () => {
    const { run } = world();
    const { provider, booking } = xero();
    expect(await run(() => bookAccountingPayments(actor("accountant"), { connectionId: CONNECTION, lines: [line] }, { provider }))).toEqual({
      ok: false,
      code: "consent",
      message: "Xero was connected when only an owner or admin could approve bookings. Ask an owner or admin to approve these, or to reconnect Xero in Settings so an accountant can.",
    });
    expect(booking.organisation).not.toHaveBeenCalled();
    expect(booking.bookPayment).not.toHaveBeenCalled();
  });

  it("refuses a connection disconnected", async () => {
    const { run } = world({ connection: { body: [connectionRow({ status: "revoked", revoked_at: "2026-10-12T10:00:00Z" })] } });
    const { provider } = xero();
    expect(await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }))).toMatchObject({ ok: false, code: "not_connected" });
  });
});

describe("each line (W6, W7)", () => {
  it("books what the person saw, records it, and says so", async () => {
    const { run, row } = world();
    const { provider, booking } = xero();
    const outcome = await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }));
    expect(outcome).toMatchObject({ ok: true, message: "Booked 1 payment in Xero.", counts: { booked: 1, refused: 0, stale: 0, failed: 0 } });
    expect(booking.bookPayment).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ state: "confirmed", external_payment_id: made.externalId, approved_by: USER, account: ACCOUNT });
    expect(mocks.ledger.mock.calls.map(([entry]) => (entry as { action: string }).action)).toEqual([
      "accounting_payment_approved",
      "accounting_payment_sent",
      "accounting_payment_confirmed",
    ]);
  });

  it("calls a view that changed stale, and sends nothing", async () => {
    const { run, row } = world();
    const { provider, booking } = xero();
    const outcome = await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [{ postingId: POSTING, fingerprint: "a".repeat(64) }] }, { provider }));
    expect(outcome).toMatchObject({ ok: false, code: "stale", message: "Booked nothing in Xero. This booking changed since you saw it. Look at it again, then approve.", changed: true });
    expect(booking.bookPayment).not.toHaveBeenCalled();
    expect(row().state).toBe("draft");
  });

  it("keeps each line's own outcome: one not this connection's never stops the next", async () => {
    const { run } = world();
    const { provider, booking } = xero();
    const outcome = await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [{ postingId: OTHER_POSTING, fingerprint: SHOWN }, line] }, { provider }));
    expect(outcome).toMatchObject({ ok: true, counts: { booked: 1, stale: 1 } });
    expect(booking.bookPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses a shadow payment into a real organisation by the reality rule", async () => {
    const { run, row } = world();
    const { provider, booking } = xero(false);
    const outcome = await run(() => bookAccountingPayments(actor(), { connectionId: CONNECTION, lines: [line] }, { provider }));
    expect(outcome).toMatchObject({ ok: false, message: "Booked nothing in Xero. Not booked: payments in shadow mode and on Arc testnet are never booked into your real books." });
    expect(booking.bookPayment).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ state: "refused", reason: "reality" });
  });
});

describe("bookingMessage", () => {
  it("counts what was booked and says what stopped the rest, once each", () => {
    expect(
      bookingMessage("Xero", [
        { postingId: "a", outcome: "booked", message: "Booked in Xero." },
        { postingId: "b", outcome: "refused", message: "Already paid in Xero." },
        { postingId: "c", outcome: "refused", message: "Already paid in Xero." },
      ])
    ).toBe("Booked 1 payment in Xero. Already paid in Xero.");
  });

  it("says booked only of those read back: one Xero took and has not confirmed yet is sent", () => {
    expect(
      bookingMessage("Xero", [
        { postingId: "a", outcome: "booked", message: "Booked in Xero." },
        { postingId: "b", outcome: "sent", message: "Sent to Xero. Vestiarion reads it back at the next sync to confirm it." },
      ])
    ).toBe("Booked 1 payment in Xero. Sent 1 payment to Xero, not read back yet: Vestiarion confirms it at the next sync.");
    expect(bookingMessage("Xero", [{ postingId: "b", outcome: "sent", message: "Sent to Xero." }])).toBe(
      "Sent 1 payment to Xero, not read back yet: Vestiarion confirms it at the next sync."
    );
  });
});
