import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { closeCustomerRequestCommand, replyToCustomerRequest, shareCustomerStatement, stopCustomerStatement } from "@/lib/commands/customer-portal";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { PortalLinkError } from "@/lib/customer-portal/links";
import { CustomerRequestError } from "@/lib/customer-portal/requests";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A customer's statement link and what customers say through it, as commands
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P9): owners and admins (`records.write`) make and stop links,
 * and accountants answer too (`receivables.reconcile`), from the console only; the gate runs before anything is read, and a refusal reads in its own words.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { create: vi.fn(), stop: vi.fn(), reply: vi.fn(), close: vi.fn() } }));
vi.mock("@/lib/customer-portal/links", async (original) => ({
  ...(await original<typeof import("@/lib/customer-portal/links")>()),
  createPortalLink: mocks.create,
  stopPortalLink: mocks.stop,
}));
vi.mock("@/lib/customer-portal/requests", async (original) => ({
  ...(await original<typeof import("@/lib/customer-portal/requests")>()),
  replyToCustomer: mocks.reply,
  closeCustomerRequest: mocks.close,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c81";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c8";
const CUSTOMER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000cc";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("who may share a statement and answer a customer", () => {
  it("shares a link with the permission that adds invoices, and answers with the receivables bookkeeping, from the console only", () => {
    for (const name of ["customer_portal.share", "customer_portal.unshare"] as const) expect(COMMAND_PERMISSIONS[name]).toBe("records.write");
    // An accountant answers customers, and makes no link (accountant console A1).
    for (const name of ["customer_request.reply", "customer_request.close"] as const) expect(COMMAND_PERMISSIONS[name]).toBe("receivables.reconcile");
    for (const name of ["customer_portal.share", "customer_portal.unshare", "customer_request.reply", "customer_request.close"] as const) {
      for (const surface of ["api", "slack", "telegram", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(name);
    }
  });

  it.each(["approver", "viewer"] as const)("refuses an %s before anything is read", async (role) => {
    expect(await run(() => shareCustomerStatement(actor({ role }), { counterpartyId: CUSTOMER, days: 30 }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => stopCustomerStatement(actor({ role }), { linkId: "l" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => replyToCustomerRequest(actor({ role }), { requestId: "r", body: "Hi" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => closeCustomerRequestCommand(actor({ role }), { requestId: "r", outcome: "resolved" }))).toMatchObject({ ok: false, code: "forbidden" });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("lets an accountant answer a customer, and make or stop no link (accountant console A1)", async () => {
    const accountant = actor({ role: "accountant" });
    expect(await run(() => shareCustomerStatement(accountant, { counterpartyId: CUSTOMER, days: 30 }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => stopCustomerStatement(accountant, { linkId: "l" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.reply.mockResolvedValueOnce({ customerName: "Acme Corp" });
    expect(await run(() => replyToCustomerRequest(accountant, { requestId: "r", body: "We found it, thank you." }))).toMatchObject({ ok: true });
  });

  it("refuses from another surface", async () => {
    const api = actor({ surface: { kind: "api", apiKeyId: "k-1" } });
    expect(await run(() => shareCustomerStatement(api, { counterpartyId: CUSTOMER, days: 30 }))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("shareCustomerStatement", () => {
  it("makes the link, says it is shown once, and that the customer's old one stopped", async () => {
    mocks.create.mockResolvedValueOnce({ token: "vxc_x", linkId: "l-1", expiresAt: "2026-11-12T00:00:00Z", customerName: "Acme Corp", replaced: 1 });
    expect(await run(() => shareCustomerStatement(actor({ role: "admin" }), { counterpartyId: CUSTOMER, days: 30 }))).toEqual({
      ok: true,
      message: "Statement link ready for Acme Corp. Copy it now: it is shown only once. The link Acme Corp had before no longer works.",
      token: "vxc_x",
      linkId: "l-1",
      expiresAt: "2026-11-12T00:00:00Z",
    });
    expect(mocks.create).toHaveBeenCalledWith({ actorId: USER, counterpartyId: CUSTOMER, days: 30 });
  });

  it("says a refusal in its own words, and that the list changed when a link was stopped for want of its entry", async () => {
    mocks.create.mockRejectedValueOnce(new PortalLinkError("not_client"));
    expect(await run(() => shareCustomerStatement(actor(), { counterpartyId: CUSTOMER, days: 30 }))).toEqual({
      ok: false,
      code: "not_client",
      message: "Statement links are for customers. This counterparty is not a client.",
    });
    mocks.create.mockRejectedValueOnce(new PortalLinkError("not_recorded"));
    expect(await run(() => shareCustomerStatement(actor(), { counterpartyId: CUSTOMER, days: 30 }))).toMatchObject({ ok: false, code: "not_recorded", changed: true });
    mocks.create.mockRejectedValueOnce(new Error("boom"));
    expect(await run(() => shareCustomerStatement(actor(), { counterpartyId: CUSTOMER, days: 30 }))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
  });
});

describe("answering a customer", () => {
  it("replies and says where the customer reads it", async () => {
    mocks.reply.mockResolvedValueOnce({ customerName: "Acme Corp" });
    expect(await run(() => replyToCustomerRequest(actor(), { requestId: "r-1", body: "We found it." }))).toEqual({ ok: true, message: "Sent. Acme Corp sees your reply on its statement." });
  });

  it("closes a dispute and says the reminders go on", async () => {
    mocks.close.mockResolvedValueOnce({ customerName: "Acme Corp", kind: "dispute" });
    expect(await run(() => closeCustomerRequestCommand(actor(), { requestId: "r-1", outcome: "resolved" }))).toEqual({
      ok: true,
      message: "Closed. Acme Corp sees it on its statement. The agent's reminders about the invoice go on as before.",
    });
  });

  it("says a request closed already, and that the page changed", async () => {
    mocks.close.mockRejectedValueOnce(new CustomerRequestError("closed"));
    expect(await run(() => closeCustomerRequestCommand(actor(), { requestId: "r-1", outcome: "resolved" }))).toMatchObject({ ok: false, code: "closed", changed: true });
  });
});
