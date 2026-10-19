import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayeeLinkAction, revokePayeeLinkAction } from "@/app/actions/payee-links";
import { keepPayeeAddressAction, submitPayeeAddressAction, submitPayeeInvoiceAction } from "@/app/payee/[token]/actions";
import PayeePage, { metadata } from "@/app/payee/[token]/page";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import { requiresSession } from "@/lib/auth/routes";
import { CounterpartyAddressError } from "@/lib/counterparty-address";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { publicOrigin } from "@/lib/public-origin";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Payee links, where people meet them (spec 2026-09-30-payee-links-design.md
 * §2): the owner's create and revoke actions, the payee's page and its
 * session-less submit. The library is faked; tests/payee-links.test.ts covers it.
 */

const { authorizeMock, lib, invoiceMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  lib: {
    createPayeeLink: vi.fn(),
    revokePayeeLink: vi.fn(),
    payeeLinkStatus: vi.fn(),
    submitPayeeAddress: vi.fn(),
    keepPayeeAddress: vi.fn(),
    payeeLinkSimulates: vi.fn(async () => false),
  },
  invoiceMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn),
}));
vi.mock("@/lib/platform/payee-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/payee-links")>()),
  ...lib,
}));
vi.mock("@/lib/platform/payee-invoices", () => ({ submitPayeeInvoice: invoiceMock }));
// Where the page refreshes itself, it says so in the markup.
vi.mock("@/components/AutoRefresh", () => ({ AutoRefresh: () => <span data-auto-refresh="" /> }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const TOKEN = `vxp_${"A".repeat(43)}`;
const ACCESS = { ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "owner" } };

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
/** The workspace's counterparty, as the create action looks it up in the workspace's scope. */
let role: string | null = "vendor";
let fake = fakeSupabase(() => ({ body: role ? [{ id: PAYEE, role }] : [] }));

/** The first element of `type` in a rendered tree, as React will serialize its props for the browser. */
function findElement(node: unknown, type: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as { props: Record<string, unknown> };
  return findElement((node.props as { children?: unknown }).children, type);
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const empty = { ok: false, message: "" };

const FULL_ADDRESS = "0x2222222222222222222222222222222222222222";
/** The link's status as the read returns it, with a payment held for a reason the payee never reads (R3). */
const linkNow = (over: Record<string, unknown> = {}) => ({
  orgName: "Acme", payeeName: "Northwind", chain: "ARC-TESTNET", linkState: "used", expiresAt: "2026-10-07T12:00:00+00:00",
  usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: FULL_ADDRESS, addressConfirmed: false,
  payments: [{ kind: "invoice", title: "Logo", amount: 5, currency: "USDC", status: "flagged", txRef: null, settledAt: null, scheduledFor: null }],
  asksInvoice: true, invoiceSent: false, chainOpen: false,
  ...over,
});
/** What a payee's browser may receive of it (S6): the address masked, no hold's reason, nothing else of the read. */
function expectPayeeView(answer: unknown) {
  const sent = JSON.stringify(answer);
  expect(sent).toContain("0x2222…2222");
  expect(sent).not.toContain(FULL_ADDRESS);
  expect(sent).not.toMatch(/flag|chainOpen/i);
}

beforeEach(() => {
  role = "vendor";
  fake = fakeSupabase(() => ({ body: role ? [{ id: PAYEE, role }] : [] }));
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
  for (const mock of Object.values(lib)) mock.mockReset();
  invoiceMock.mockReset();
});

describe("createPayeeLinkAction", () => {
  it("needs records.write, and returns the link's address once", async () => {
    lib.createPayeeLink.mockResolvedValue({ link: { id: LINK, counterpartyId: PAYEE, expiresAt: "2026-10-07T12:00:00+00:00" }, token: TOKEN });
    const result = await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: PAYEE }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "records.write");
    expect(lib.createPayeeLink).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, counterpartyId: PAYEE });
    expect(result).toEqual({
      ok: true,
      message: "Link created. Copy it now: it is shown only once.",
      url: `${publicOrigin()}/payee/${TOKEN}`,
      expiresAt: "2026-10-07T12:00:00+00:00",
    });
  });

  it("makes no link for a client, whom the agent never pays, or for a counterparty the workspace does not hold", async () => {
    role = "client";
    expect(await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: PAYEE }))).toEqual({
      ok: false,
      message: "A payee link is for a vendor or a contractor the agent pays.",
    });
    role = null;
    expect(await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: PAYEE }))).toEqual({ ok: false, message: "Counterparty not found." });
    expect(lib.createPayeeLink).not.toHaveBeenCalled();
  });

  it("makes nothing when refused, or for a malformed counterparty id", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You do not have permission to do that." });
    expect(await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: PAYEE }))).toEqual({
      ok: false,
      message: "You do not have permission to do that.",
    });
    expect(await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: "nope" }))).toEqual({ ok: false, message: "Counterparty not found." });
    expect(lib.createPayeeLink).not.toHaveBeenCalled();
  });
});

describe("createPayeeLinkAction's options (payee invoice link P1)", () => {
  it("passes the ticked boxes to the link, and says the link asks for an invoice", async () => {
    lib.createPayeeLink.mockResolvedValue({ link: { id: LINK, counterpartyId: PAYEE, expiresAt: "2026-10-07T12:00:00+00:00" }, token: TOKEN });
    const result = await createPayeeLinkAction(empty, form({ orgSlug: "acme", counterpartyId: PAYEE, asksInvoice: "on" }));
    expect(lib.createPayeeLink).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, counterpartyId: PAYEE, options: { asksInvoice: true } });
    expect(result).toMatchObject({ ok: true, asksInvoice: true });
  });
});

describe("revokePayeeLinkAction", () => {
  it("needs records.write and revokes the workspace's link", async () => {
    lib.revokePayeeLink.mockResolvedValue(true);
    const result = await revokePayeeLinkAction(empty, form({ orgSlug: "acme", linkId: LINK }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "records.write");
    expect(lib.revokePayeeLink).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, linkId: LINK });
    expect(result).toEqual({ ok: true, message: "Link revoked. It no longer works." });
  });

  it("says a used link no longer takes the payee's invoice when that is what Revoke stopped (payee invoice link P6)", async () => {
    lib.revokePayeeLink.mockResolvedValue("invoice_closed");
    expect(await revokePayeeLinkAction(empty, form({ orgSlug: "acme", linkId: LINK }))).toEqual({ ok: true, message: "Link revoked. It no longer takes their invoice." });
  });

  it("says when the link was already used or gone", async () => {
    lib.revokePayeeLink.mockResolvedValue(false);
    expect(await revokePayeeLinkAction(empty, form({ orgSlug: "acme", linkId: LINK }))).toEqual({
      ok: false,
      message: "That link was already used or revoked.",
    });
  });
});

describe("submitPayeeAddressAction — no session needed", () => {
  it("thanks the payee, naming the business that will confirm the address", async () => {
    lib.submitPayeeAddress.mockResolvedValue({ ok: true, orgName: "Acme", unchanged: false });
    const result = await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x2222222222222222222222222222222222222222" }));
    expect(lib.submitPayeeAddress).toHaveBeenCalledWith(TOKEN, "0x2222222222222222222222222222222222222222");
    expect(result).toEqual({ ok: true, message: "Thanks. Acme will confirm your address before paying you." });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("says when the address was already on file", async () => {
    lib.submitPayeeAddress.mockResolvedValue({ ok: true, orgName: "Acme", unchanged: true });
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x2" }))).toEqual({
      ok: true,
      message: "That is already the address Acme has on file.",
    });
  });

  it("says a mistyped address is likely wrong, and asks the payee to copy it again (payment safety A3)", async () => {
    lib.submitPayeeAddress.mockResolvedValueOnce({ ok: false, reason: "checksum_address" });
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x1" }))).toEqual({
      ok: false,
      message: "This address's capital letters do not match its checksum, so a character is likely wrong. Copy it again from your wallet.",
    });
  });

  it("asks for a real address, and says an unusable link is no longer valid", async () => {
    lib.submitPayeeAddress.mockResolvedValueOnce({ ok: false, reason: "invalid_address" }).mockResolvedValueOnce({ ok: false, reason: "invalid_link" });
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x1" }))).toEqual({
      ok: false,
      message: "That doesn't look like a wallet address. It starts with 0x and has 42 characters in all.",
    });
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x1" }))).toEqual({
      ok: false,
      message: "This link is no longer valid. Ask the business that sent it for a new one.",
    });
  });

  it("sends the chain chosen on a link that offered it, and says when it can no longer be chosen (payee invoice link P2)", async () => {
    lib.submitPayeeAddress.mockResolvedValueOnce({ ok: true, orgName: "Acme", unchanged: false }).mockResolvedValueOnce({ ok: false, reason: "chain_closed" });
    const fields = { token: TOKEN, address: "0x2222222222222222222222222222222222222222", chain: "BASE" };
    expect(await submitPayeeAddressAction(empty, form(fields))).toMatchObject({ ok: true });
    expect(lib.submitPayeeAddress).toHaveBeenCalledWith(TOKEN, "0x2222222222222222222222222222222222222222", { chain: "BASE" });
    expect(await submitPayeeAddressAction(empty, form(fields))).toEqual({ ok: false, message: "Where you are paid can no longer be chosen on this link. Reload the page." });
  });

  it("answers with the link's status as it now stands, as the page is given it (payee step advance S1, S6)", async () => {
    lib.submitPayeeAddress.mockResolvedValueOnce({ ok: true, orgName: "Acme", unchanged: false }).mockResolvedValueOnce({ ok: true, orgName: "Acme", unchanged: true });
    lib.payeeLinkStatus.mockResolvedValue(linkNow());
    const fields = { token: TOKEN, address: FULL_ADDRESS };
    const sent = await submitPayeeAddressAction(empty, form(fields));
    expect(sent).toMatchObject({ ok: true, message: "Thanks. Acme will confirm your address before paying you.", status: { linkState: "used", address: "0x2222…2222" } });
    expect(sent.status?.payments[0].status).toBe("review");
    expectPayeeView(sent);
    expect(await submitPayeeAddressAction(empty, form(fields))).toMatchObject({ ok: true, message: "That is already the address Acme has on file.", status: { linkState: "used" } });
    expect(lib.payeeLinkStatus).toHaveBeenCalledWith(TOKEN);
  });

  it("still thanks the payee when the link's status cannot be read after the address is written (S2)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.submitPayeeAddress.mockResolvedValue({ ok: true, orgName: "Acme", unchanged: false });
    lib.payeeLinkStatus.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce(null);
    const fields = { token: TOKEN, address: "0x2222222222222222222222222222222222222222" };
    expect(await submitPayeeAddressAction(empty, form(fields))).toEqual({ ok: true, message: "Thanks. Acme will confirm your address before paying you." });
    expect(error).toHaveBeenCalledWith("payee link status after submission failed");
    expect(await submitPayeeAddressAction(empty, form(fields))).toEqual({ ok: true, message: "Thanks. Acme will confirm your address before paying you." });
  });

  it("reads no status for a refusal", async () => {
    lib.submitPayeeAddress.mockResolvedValue({ ok: false, reason: "invalid_address" });
    await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x1" }));
    expect(lib.payeeLinkStatus).not.toHaveBeenCalled();
  });

  it("keeps any other failure's details out of the answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.submitPayeeAddress.mockRejectedValue(new CounterpartyAddressError("conflict"));
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x2" }))).toEqual({
      ok: false,
      message: "That did not work. Try again in a moment.",
    });
    expect(error).toHaveBeenCalledWith("payee address submission failed");
  });
});

describe("keepPayeeAddressAction (payee invoice link P4)", () => {
  it("keeps the address on file, naming the business, with no session", async () => {
    lib.keepPayeeAddress.mockResolvedValue({ ok: true, orgName: "Acme" });
    expect(await keepPayeeAddressAction(empty, form({ token: TOKEN }))).toEqual({ ok: true, message: "Kept the address Acme has on file." });
    expect(lib.keepPayeeAddress).toHaveBeenCalledWith(TOKEN);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("answers with the link's status as it now stands, as the page is given it (S1, S6)", async () => {
    lib.keepPayeeAddress.mockResolvedValue({ ok: true, orgName: "Acme" });
    lib.payeeLinkStatus.mockResolvedValue(linkNow({ addressConfirmed: true }));
    const kept = await keepPayeeAddressAction(empty, form({ token: TOKEN }));
    expect(kept).toMatchObject({ ok: true, message: "Kept the address Acme has on file.", status: { linkState: "used", addressConfirmed: true } });
    expectPayeeView(kept);
  });

  it("says when there is nothing to keep, when the link is no longer valid, and nothing else of a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lib.keepPayeeAddress
      .mockResolvedValueOnce({ ok: false, reason: "no_address" })
      .mockResolvedValueOnce({ ok: false, reason: "invalid_link" })
      .mockRejectedValueOnce(new Error("connection reset"));
    expect((await keepPayeeAddressAction(empty, form({ token: TOKEN }))).message).toBe("There is no address on file to keep. Enter your address instead.");
    expect((await keepPayeeAddressAction(empty, form({ token: TOKEN }))).message).toBe("This link is no longer valid. Ask the business that sent it for a new one.");
    expect((await keepPayeeAddressAction(empty, form({ token: TOKEN }))).message).toBe("That did not work. Try again in a moment.");
  });
});

describe("submitPayeeInvoiceAction (payee invoice link P4)", () => {
  const invoiceForm = (file?: File) => {
    const data = form({ token: TOKEN, invoiceNumber: "INV-7", amount: "1250.50", dueDate: "2026-11-02", note: "October" });
    if (file) data.set("file", file);
    return data;
  };

  it("sends the fields and the file, with no session, and thanks the payee", async () => {
    invoiceMock.mockResolvedValue({ ok: true, orgName: "Acme" });
    const file = new File(["Invoice INV-7"], "invoice.txt", { type: "text/plain" });
    expect(await submitPayeeInvoiceAction(empty, invoiceForm(file))).toEqual({ ok: true, message: "Sent. Acme reviews your invoice before adding it." });
    const [token, input] = invoiceMock.mock.calls[0];
    expect(token).toBe(TOKEN);
    expect(input).toMatchObject({ invoiceNumber: "INV-7", amount: "1250.50", dueDate: "2026-11-02", note: "October" });
    expect(input.file).toBeInstanceOf(File);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("answers with the link's status as it now stands (S1, S6), and reads none for a refusal", async () => {
    invoiceMock.mockResolvedValueOnce({ ok: true, orgName: "Acme" }).mockResolvedValueOnce({ ok: false, reason: "busy" });
    lib.payeeLinkStatus.mockResolvedValue(linkNow({ invoiceSent: true }));
    const sent = await submitPayeeInvoiceAction(empty, invoiceForm());
    expect(sent).toMatchObject({ ok: true, message: "Sent. Acme reviews your invoice before adding it.", status: { invoiceSent: true } });
    expectPayeeView(sent);
    expect(lib.payeeLinkStatus).toHaveBeenCalledTimes(1);
    expect(await submitPayeeInvoiceAction(empty, invoiceForm())).toEqual({ ok: false, message: "Wait a few seconds, then send it again." });
    expect(lib.payeeLinkStatus).toHaveBeenCalledTimes(1);
  });

  it("sends no file for an empty file field", async () => {
    invoiceMock.mockResolvedValue({ ok: true, orgName: "Acme" });
    await submitPayeeInvoiceAction(empty, invoiceForm(new File([], "", { type: "application/octet-stream" })));
    expect(invoiceMock.mock.calls[0][1].file).toBeNull();
  });

  it.each([
    [{ ok: false, reason: "invalid", field: "amount" }, { ok: false, message: "Enter the amount in USDC, more than 0 with at most 6 decimals, such as 1250.00.", field: "amount" }],
    [{ ok: false, reason: "file", code: "scan" }, { ok: false, message: "This PDF has no text to read; it may be a scan. Send your invoice without the file, or choose a PDF with text.", field: "file" }],
    [{ ok: false, reason: "busy" }, { ok: false, message: "Wait a few seconds, then send it again." }],
    [{ ok: false, reason: "already_sent" }, { ok: false, message: "This link already sent an invoice. To send another, ask the business for a new link." }],
    [{ ok: false, reason: "invalid_link" }, { ok: false, message: "This link is no longer valid. Ask the business that sent it for a new one." }],
  ])("%# answers a refusal with a fixed sentence", async (refusal, answer) => {
    invoiceMock.mockResolvedValue(refusal);
    expect(await submitPayeeInvoiceAction(empty, invoiceForm())).toEqual(answer);
  });

  it("keeps any other failure's details out of the answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    invoiceMock.mockRejectedValue(new Error("relation does not exist"));
    expect(await submitPayeeInvoiceAction(empty, invoiceForm())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(error).toHaveBeenCalledWith("payee invoice submission failed");
  });
});

describe("the payee's page", () => {
  const render = async () => renderToStaticMarkup(await PayeePage({ params: Promise.resolve({ token: TOKEN }) }));

  it("is public and kept out of search engines", () => {
    expect(requiresSession(`/payee/${TOKEN}`)).toBe(false);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  const ADDRESS = "0x2222222222222222222222222222222222222222";
  const status = (over: Record<string, unknown> = {}) => ({
    orgName: "Acme", payeeName: "Northwind", chain: "ARC-TESTNET", linkState: "open", expiresAt: "2026-10-07T12:00:00+00:00", usedAt: null,
    statusUntil: "2026-10-07T12:00:00+00:00", address: null, addressConfirmed: false,
    payments: [{ kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "verified", txRef: null, settledAt: null, scheduledFor: null }],
    ...over,
  });

  it("step 1: says who pays how much for what, how it works, and asks for one address", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status());
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Step 1 of 3");
    expect(page).toContain("Acme wants to pay you 25.00 USDC");
    expect(page).toContain("10 social posts");
    expect(page).toContain("Acme confirms it. A person checks every new address before money is sent to it.");
    expect(page).toContain("Your wallet address on Arc testnet");
    expect(page).toContain("It never asks for your recovery phrase or private key.");
    expect(page).toContain("This link expires on Oct 7, 2026.");
    expect(markup).toMatch(/<input[^>]*name="address"/);
    expect(lib.payeeLinkStatus).toHaveBeenCalledWith(TOKEN);
  });

  it("asks a payee paid on another chain for their address there (review I3)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ chain: "BASE-SEPOLIA" }));
    const page = text(await render());
    expect(page).toContain("For Northwind, on Base Sepolia.");
    expect(page).toContain("Your wallet address on Base Sepolia");
    expect(page).not.toContain("address on Arc testnet");
  });

  it("step 2: once the address is sent, says the business confirms it next, with the address masked (R1, R4)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS }));
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Step 2 of 3");
    expect(page).toContain("Address sent. Acme confirms it next.");
    expect(page).toContain("Waiting for Acme to confirm");
    expect(page).toContain("0x2222…2222");
    expect(page).not.toContain(ADDRESS);
    expect(page).toContain("It shows your payment's status until Nov 1, 2026");
    expect(markup).not.toMatch(/<input[^>]*name="address"/);
  });

  it("gives its client part the address masked and no hold's reason, as they end up in the page's HTML (S6)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(
      status({
        linkState: "used", address: ADDRESS, addressConfirmed: true, chainOpen: true,
        payments: [{ kind: "invoice", title: "Logo", amount: 5, currency: "USDC", status: "flagged", txRef: "0xdead", settledAt: null, scheduledFor: null }],
      })
    );
    const journey = findElement(await PayeePage({ params: Promise.resolve({ token: TOKEN }) }), PayeeJourney);
    const props = JSON.stringify(journey?.props);
    expect(props).toContain("0x2222…2222");
    expect(props).not.toContain(ADDRESS);
    expect(props).not.toMatch(/flag|chainOpen|0xdead/i);
  });

  it("step 3: once confirmed, each payment in plain words, never why one is held (R3)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(
      status({
        linkState: "used", address: ADDRESS, addressConfirmed: true,
        payments: [
          { kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "verified", txRef: null, settledAt: null, scheduledFor: null },
          { kind: "invoice", title: "Logo", amount: 5, currency: "USDC", status: "flagged", txRef: null, settledAt: null, scheduledFor: null },
        ],
      })
    );
    const page = text(await render());
    expect(page).toContain("Step 3 of 3");
    expect(page).toContain("Your address is confirmed");
    expect(page).toContain("Being prepared");
    expect(page).toContain("With Acme for review");
    expect(page).toContain("Acme is reviewing a payment before it is sent.");
    expect(page).not.toMatch(/flag|screen|sanction/i);
  });

  it("paid: the confirmation, with who paid what, to where, when, and the transaction", async () => {
    lib.payeeLinkStatus.mockResolvedValue(
      status({
        linkState: "used", address: ADDRESS, addressConfirmed: true,
        payments: [{ kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "paid", txRef: `0x${"ab".repeat(32)}`, settledAt: "2026-10-02T09:05:00Z", scheduledFor: null }],
      })
    );
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("All done");
    expect(page).toContain("You've been paid 25.00 USDC");
    expect(page).toContain("From Acme");
    expect(page).toContain("For 10 social posts");
    expect(page).toContain("Paid on Oct 2, 2026, 09:05 UTC");
    expect(page).toContain("View the transaction");
    expect(page).not.toContain("Arcscan");
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}"`);
  });

  it("paid on Arc mainnet: names it, footer included, and links its explorer (mainnet copy C1, C6)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(
      status({
        chain: "ARC", linkState: "used", address: ADDRESS, addressConfirmed: true,
        payments: [{ kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "paid", txRef: `0x${"ab".repeat(32)}`, settledAt: "2026-10-02T09:05:00Z", scheduledFor: null }],
      })
    );
    const markup = await render();
    expect(text(markup)).toContain("A payment on Arc mainnet is final within seconds");
    expect(text(markup)).toContain("Signed decisions on Arc mainnet");
    expect(text(markup)).not.toContain("Arc testnet");
    expect(markup).toContain(`href="https://explorer.arc.io/tx/0x${"ab".repeat(32)}"`);
  });

  it("asks for the invoice as a step of its own after the address, on a link that asks for it (payee invoice link P4)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ asksInvoice: true, invoiceSent: false }));
    const open = text(await render());
    expect(open).toContain("Step 1 of 4");
    expect(open).toContain("Your invoice");
    expect(open).toContain("Send your invoice. It waits for a person to check it.");

    lib.payeeLinkStatus.mockResolvedValue(status({ asksInvoice: true, invoiceSent: false, linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS }));
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Step 2 of 4");
    expect(page).toContain("Send Acme your invoice");
    expect(page).toContain("Address sent: 0x2222…2222. Acme confirms it before paying you.");
    expect(page).toContain("Send my invoice");
    expect(page).toContain("Only its text is kept, never the file.");
    expect(page).toContain("This link takes your invoice until Nov 1, 2026.");
    for (const name of ["invoiceNumber", "amount", "dueDate", "note", "file"]) expect(markup).toMatch(new RegExp(`name="${name}"`));
    expect(markup).toMatch(/<input[^>]*type="date"[^>]*min="\d{4}-\d{2}-\d{2}"/);
    expect(markup).not.toMatch(/<input[^>]*name="address"/);
  });

  it("says the invoice was sent on the steps after it", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ asksInvoice: true, invoiceSent: true, linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS }));
    const page = text(await render());
    expect(page).toContain("Step 3 of 4");
    expect(page).toContain("Address sent. Acme confirms it next.");
    expect(page).toContain("Invoice sent. Acme checks it before adding it.");
  });

  it("lets a payee with an address on file keep it and go on to the invoice", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ asksInvoice: true, address: ADDRESS, addressConfirmed: true }));
    const page = text(await render());
    expect(page).toContain("Acme already has an address for you: 0x2222…2222");
    expect(page).toContain("Still yours?");
    expect(page).not.toContain(ADDRESS);
    expect(page).toContain("Keep this address");
    // Not offered on a link that asks for the address alone, nor for a mirror Vestiarion made, which is not theirs.
    lib.payeeLinkStatus.mockResolvedValue(status({ address: ADDRESS, addressConfirmed: true }));
    expect(text(await render())).not.toContain("Keep this address");
    lib.payeeLinkStatus.mockResolvedValue(status({ asksInvoice: true, address: ADDRESS, addressConfirmed: true, addressMirror: true }));
    expect(text(await render())).not.toContain("Keep this address");
  });

  it("refreshes itself on the invoice step, as on the steps that wait on the business", async () => {
    const used = { linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS };
    lib.payeeLinkStatus.mockResolvedValue(status({ ...used, asksInvoice: true, invoiceSent: false }));
    expect(await render()).toContain("data-auto-refresh");
    lib.payeeLinkStatus.mockResolvedValue(status());
    expect(await render()).not.toContain("data-auto-refresh");
  });

  it("puts a payment on its way first, and the invoice it can still take second (payee invoice link P4)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(
      status({
        linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS, addressConfirmed: true, asksInvoice: true, invoiceSent: false,
        payments: [{ kind: "invoice", title: "Logo", amount: 5, currency: "USDC", status: "matched", txRef: null, settledAt: null, scheduledFor: null }],
      })
    );
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Step 4 of 4");
    expect(page).toContain("Your address is confirmed");
    expect(page).toContain("On its way");
    expect(page).toContain("You can still send your invoice");
    expect(page.indexOf("Your address is confirmed")).toBeLessThan(page.indexOf("You can still send your invoice"));
    expect(markup).toMatch(/name="invoiceNumber"/);
    expect(page).not.toContain("Send Acme your invoice");
  });

  it("asks where the wallet receives USDC first, on a link that lets the payee choose (payee invoice link P2)", async () => {
    lib.payeeLinkStatus.mockResolvedValue(status({ chain: "ARC", offersChain: true, chainChoices: ["ARC", "BASE"] }));
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("For Northwind.");
    expect(page).not.toContain("For Northwind, on");
    expect(page).toContain("Where does your wallet receive USDC?");
    expect(page).toContain("Arc mainnet");
    expect(page).toContain("Base");
    expect(page).toContain("Choose where your wallet receives USDC, then add its address.");
    expect(page).toContain("You're paid on the network you chose");
    // The address comes after the chain, on the next screen.
    expect(markup).not.toMatch(/<input[^>]*name="address"/);
  });

  it("says the same neutral thing for any unusable link, naming no one", async () => {
    lib.payeeLinkStatus.mockResolvedValue(null);
    const page = text(await render());
    expect(page).toContain("This link is no longer valid. Ask the business that sent it for a new one.");
    expect(page).not.toContain("Acme");
  });

  it("says it could not load, rather than that the link is invalid, when the lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lib.payeeLinkStatus.mockRejectedValue(new Error("network"));
    const page = text(await render());
    expect(page).toContain("This page could not load. Try again in a moment.");
  });
});
