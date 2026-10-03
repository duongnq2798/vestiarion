import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { addressHash } from "@/lib/slack/state";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Deciding a payable from a chat (Slack design S8–S11): off until the workspace sets a limit; only on a card that is
 * still true of the payable; and Approve and pay only for USDC paid on Arc, within the limit, to the confirmed address
 * the card was posted with. Then the console's own checks run, through the same approvals library, which is a stand-in
 * here. The console's decisions read nothing more than they did.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { approveAndPay: vi.fn(), rejectInvoice: vi.fn(), returnInvoice: vi.fn(), runCycleSoon: vi.fn(), sendNoticesSoon: vi.fn() },
}));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPay: mocks.approveAndPay,
  rejectInvoice: mocks.rejectInvoice,
  returnInvoice: mocks.returnInvoice,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000e3";
const ADDRESS = "0x1111222233334444555566667777888899990000";
const DECIDED = "2026-10-03T11:58:00.123456+00:00";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function invoiceRow(fields: Record<string, unknown> = {}, counterparty: Record<string, unknown> = {}) {
  return {
    id: INVOICE, amount: "0.50", currency: "USDC", status: "held", direction: "payable", decided_at: DECIDED,
    counterparties: { address: ADDRESS, chain: null, address_changed_at: null, address_confirmed_at: null, ...counterparty },
    ...fields,
  };
}

let row: Record<string, unknown> | null;
let requests: RecordedRequest[];

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/invoices" ? { body: row } : { body: [] }));
  requests = fake.requests;
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

const slack = (limit: number | null = 1, fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "slack", linkId: "link-1", decisionsLimitUsdc: limit }, ...fields,
});
const card = (fields: Partial<{ decidedAt: string | null; addressHash: string | null }> = {}) => ({ decidedAt: DECIDED, addressHash: addressHash(ADDRESS), ...fields });

beforeEach(() => {
  row = invoiceRow();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("deciding from a chat", () => {
  it("is off until the workspace sets a limit, and reads nothing then", async () => {
    const outcome = await run(() => approvePayable(slack(null), { invoiceId: INVOICE, card: card() }));
    expect(outcome).toMatchObject({ ok: false, code: "decisions_off" });
    expect(requests).toEqual([]);
    expect(await run(() => rejectPayable(slack(null), { invoiceId: INVOICE, reason: "", card: card() }))).toMatchObject({ code: "decisions_off" });
  });

  it("needs the card the button carried", async () => {
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "card_required" });
    expect(mocks.approveAndPay).not.toHaveBeenCalled();
  });

  it("refuses a card the payable has moved on from: decided again, or no longer waiting", async () => {
    row = invoiceRow({ decided_at: "2026-10-03T12:30:00+00:00" });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "card_stale" });
    row = invoiceRow({ status: "paid" });
    expect(await run(() => rejectPayable(slack(), { invoiceId: INVOICE, reason: "", card: card() }))).toMatchObject({ ok: false, code: "card_stale" });
    row = null;
    expect(await run(() => returnPayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "card_stale" });
    expect(mocks.approveAndPay).not.toHaveBeenCalled();
    expect(mocks.rejectInvoice).not.toHaveBeenCalled();
    expect(mocks.returnInvoice).not.toHaveBeenCalled();
  });

  it("approves and pays only USDC, on Arc, within the limit, to the confirmed address the card showed", async () => {
    row = invoiceRow({ currency: "EURC" });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "open_in_console" });
    row = invoiceRow({}, { chain: "BASE-SEPOLIA" });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "open_in_console" });
    row = invoiceRow({ amount: "1.000001" });
    const over = await run(() => approvePayable(slack(1), { invoiceId: INVOICE, card: card() }));
    expect(over).toMatchObject({ ok: false, code: "over_chat_limit" });
    expect(over.message).toContain("1 USDC");
    row = invoiceRow({}, { address_changed_at: "2026-10-03T11:00:00Z", address_confirmed_at: null });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "address_unconfirmed" });
    row = invoiceRow({}, { address: null });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "no_address" });
    row = invoiceRow({}, { address: "0x9999888877776666555544443333222211110000" });
    expect(await run(() => approvePayable(slack(), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: false, code: "card_stale" });
    expect(mocks.approveAndPay).not.toHaveBeenCalled();
  });

  it("then approves through the console's own approval, to the address it checked, naming Slack and the link", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });
    row = invoiceRow({ amount: "1.00" });
    const outcome = await run(() => approvePayable(slack(1), { invoiceId: INVOICE, card: card() }));
    expect(outcome).toMatchObject({ ok: true, message: "Paid.", status: "paid" });
    expect(mocks.approveAndPay).toHaveBeenCalledWith({
      actorId: USER, invoiceId: INVOICE, shownAddress: ADDRESS, provenance: { via: "slack", linkId: "link-1" },
    });
    const read = requests.find((request) => request.path === "/rest/v1/invoices");
    expect(read?.params.get("id")).toBe(`eq.${INVOICE}`);
  });

  it("rejects and returns on a fresh card whatever the amount or currency, naming Slack and the link", async () => {
    row = invoiceRow({ amount: "500", currency: "EURC" });
    expect(await run(() => rejectPayable(slack(1), { invoiceId: INVOICE, reason: "", card: card() }))).toEqual({ ok: true, message: "Rejected." });
    expect(mocks.rejectInvoice).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, reason: "", provenance: { via: "slack", linkId: "link-1" } });
    expect(await run(() => returnPayable(slack(1), { invoiceId: INVOICE, card: card() }))).toMatchObject({ ok: true });
    expect(mocks.returnInvoice).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, provenance: { via: "slack", linkId: "link-1" } });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "payable_returned" });
  });

  it("still refuses a viewer before reading anything", async () => {
    expect(await run(() => approvePayable(slack(1, { role: "viewer" }), { invoiceId: INVOICE, card: card() }))).toMatchObject({ code: "forbidden" });
    expect(requests).toEqual([]);
  });

  it("leaves the console's decisions as they were: no card, nothing more read", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });
    const console_ = slack(null, { surface: { kind: "console" } });
    expect(await run(() => approvePayable(console_, { invoiceId: INVOICE, shownAddress: ADDRESS }))).toMatchObject({ ok: true });
    expect(requests).toEqual([]);
    expect(mocks.approveAndPay).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, shownAddress: ADDRESS });
  });
});
