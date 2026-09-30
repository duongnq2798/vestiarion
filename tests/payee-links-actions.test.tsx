import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayeeLinkAction, revokePayeeLinkAction } from "@/app/actions/payee-links";
import { submitPayeeAddressAction } from "@/app/payee/[token]/actions";
import PayeePage, { metadata } from "@/app/payee/[token]/page";
import { requiresSession } from "@/lib/auth/routes";
import { CounterpartyAddressError } from "@/lib/counterparty-address";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Payee links, where people meet them (spec 2026-09-30-payee-links-design.md
 * §2): the owner's create and revoke actions, the payee's page and its
 * session-less submit. The library is faked; tests/payee-links.test.ts covers it.
 */

const { authorizeMock, lib } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  lib: { createPayeeLink: vi.fn(), revokePayeeLink: vi.fn(), previewPayeeLink: vi.fn(), submitPayeeAddress: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
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

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const empty = { ok: false, message: "" };

beforeEach(() => {
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

  it("asks for a real address, and says an unusable link is no longer valid", async () => {
    lib.submitPayeeAddress.mockResolvedValueOnce({ ok: false, reason: "invalid_address" }).mockResolvedValueOnce({ ok: false, reason: "invalid_link" });
    expect(await submitPayeeAddressAction(empty, form({ token: TOKEN, address: "0x1" }))).toEqual({
      ok: false,
      message: "Enter an Arc address: 0x followed by 40 hex characters.",
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

  it("names the business and the payee, and asks for one address", async () => {
    lib.previewPayeeLink.mockResolvedValue({ orgName: "Acme", counterpartyName: "Northwind", expiresAt: "2026-10-07T12:00:00+00:00" });
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Acme wants to pay Northwind in USDC on Arc testnet");
    expect(page).toContain("Acme confirms it before paying you");
    expect(markup).toMatch(/<input[^>]*name="address"/);
    expect(markup).toContain(`value="${TOKEN}"`);
  });

  it("says the same neutral thing for any unusable link, naming no one", async () => {
    lib.previewPayeeLink.mockResolvedValue(null);
    const page = text(await render());
    expect(page).toContain("This link is no longer valid. Ask the business that sent it for a new one.");
    expect(page).not.toContain("Acme");
  });

  it("says it could not load, rather than that the link is invalid, when the lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lib.previewPayeeLink.mockRejectedValue(new Error("network"));
    const page = text(await render());
    expect(page).toContain("This page could not load. Try again in a moment.");
  });
});
