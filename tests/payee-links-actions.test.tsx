import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayeeLinkAction, revokePayeeLinkAction } from "@/app/actions/payee-links";
import { submitPayeeAddressAction } from "@/app/payee/[token]/actions";
import PayeePage, { metadata } from "@/app/payee/[token]/page";
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

const { authorizeMock, lib } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  lib: { createPayeeLink: vi.fn(), revokePayeeLink: vi.fn(), payeeLinkStatus: vi.fn(), submitPayeeAddress: vi.fn() },
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

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const empty = { ok: false, message: "" };

beforeEach(() => {
  role = "vendor";
  fake = fakeSupabase(() => ({ body: role ? [{ id: PAYEE, role }] : [] }));
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
  for (const mock of Object.values(lib)) mock.mockReset();
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

describe("revokePayeeLinkAction", () => {
  it("needs records.write and revokes the workspace's link", async () => {
    lib.revokePayeeLink.mockResolvedValue(true);
    const result = await revokePayeeLinkAction(empty, form({ orgSlug: "acme", linkId: LINK }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "records.write");
    expect(lib.revokePayeeLink).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, linkId: LINK });
    expect(result).toEqual({ ok: true, message: "Link revoked. It no longer works." });
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
    expect(page).toContain("View on Arcscan");
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}"`);
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
