import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientLink } from "@/lib/platform/client-links";

/**
 * Invite a client on the accountant console (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC1):
 * the form, the list with each link's state and Revoke on an open one, and the actions behind them, gated on the session
 * alone and naming only the signed-in person.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/accountant" }));

const { getSessionUserMock, revalidatePathMock, createMock, revokeMock } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  createMock: vi.fn(),
  revokeMock: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/platform/client-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/client-links")>()),
  createClientLink: createMock,
  revokeClientLink: revokeMock,
}));

import { createClientLinkAction, revokeClientLinkAction } from "@/app/accountant/actions";
import { ANYONE_WITH_THE_LINK, ClientLinks } from "@/components/accountant/ClientLinks";
import { ClientLinkError } from "@/lib/platform/client-links";

const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const LINK = "7c3e9f1a-2b4d-4e6f-8a0b-0000000000e1";
const INITIAL = { ok: false, message: "" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const link = (fields: Partial<ClientLink>): ClientLink => ({
  id: LINK,
  email: null,
  state: "open",
  createdAt: "2026-10-23T10:00:00Z",
  expiresAt: "2026-10-30T10:00:00Z",
  usedAt: null,
  workspace: null,
  ...fields,
});

beforeEach(() => {
  getSessionUserMock.mockReset().mockResolvedValue({ id: ACCOUNTANT, email: "books@practice.example" });
  revalidatePathMock.mockReset();
  createMock.mockReset().mockResolvedValue({ id: LINK, link: `https://www.vestiarion.xyz/join/vxj_${"a".repeat(43)}`, email: null, expiresAt: "2026-10-30T10:00:00Z" });
  revokeMock.mockReset().mockResolvedValue(undefined);
});

describe("the Invite a client card (AC1)", () => {
  it("offers the form with an optional email, and says the link is shown once", () => {
    const markup = renderToStaticMarkup(<ClientLinks available links={[]} />);
    const page = text(markup);
    expect(page).toContain("Invite a client");
    expect(page).toContain("the link is shown once, right after you make it");
    expect(page).toContain("opens on Arc testnet in shadow mode, with you in it as its accountant");
    expect(page).toContain("Client's email (optional)");
    expect(markup).toContain('name="email"');
    expect(markup).not.toMatch(/name="email"[^>]*required/);
    expect(page).toContain("Create link");
    expect(markup).toContain('id="invite-client-title"');
  });

  it("lists each link's state, the workspace a used one opened, and Revoke on an open one only", () => {
    const markup = renderToStaticMarkup(
      <ClientLinks
        available
        links={[
          link({ id: "a", email: "owner@client.example" }),
          link({ id: "b", state: "used", usedAt: "2026-10-22T11:00:00Z", workspace: "Client Books" }),
          link({ id: "c", state: "used", usedAt: "2026-10-21T11:00:00Z" }),
          link({ id: "d", state: "expired", expiresAt: "2026-10-17T10:00:00Z" }),
          link({ id: "e", state: "revoked" }),
        ]}
      />
    );
    const page = text(markup);
    expect(page).toContain("owner@client.example Open Expires Oct 30, 2026 Revoke");
    expect(page).toContain(`${ANYONE_WITH_THE_LINK} Used Opened Client Books`);
    expect(page).toContain(`${ANYONE_WITH_THE_LINK} Used Used Oct 21, 2026`);
    expect(page).toContain(`${ANYONE_WITH_THE_LINK} Expired Expired Oct 17, 2026`);
    expect(page).toContain(`${ANYONE_WITH_THE_LINK} Revoked Made Oct 23, 2026`);
    expect(markup.match(/>Revoke</g)).toHaveLength(1);
    expect(markup).toContain('name="linkId" value="a"');
  });

  it("says the links are not available yet before migration 0143, and offers no form", () => {
    const markup = renderToStaticMarkup(<ClientLinks available={false} links={[]} />);
    expect(text(markup)).toContain("Client invite links are not available yet.");
    expect(markup).not.toContain('name="email"');
  });
});

describe("createClientLinkAction (AC1)", () => {
  it("stops a signed-out request", async () => {
    getSessionUserMock.mockResolvedValue(null);
    expect(await createClientLinkAction(INITIAL, form({ email: "" }))).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("makes the link for the signed-in person and returns it once", async () => {
    const result = await createClientLinkAction(INITIAL, form({ email: "", actorId: "someone-else" }));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACCOUNTANT, email: "" }));
    expect(result).toMatchObject({ ok: true, link: expect.stringMatching(/\/join\/vxj_/) });
    expect(result.message).toBe("Copy this link now and send it to your client. It works once, for 7 days. It will not be shown again.");
    expect(revalidatePathMock).toHaveBeenCalledWith("/accountant");
  });

  it("says a bound link works only for that address", async () => {
    createMock.mockResolvedValue({ id: LINK, link: "https://x.test/join/vxj_x", email: "owner@client.example", expiresAt: "2026-10-30T10:00:00Z" });
    const result = await createClientLinkAction(INITIAL, form({ email: "Owner@Client.example" }));
    expect(result.message).toBe("Copy this link now and send it to owner@client.example. It works once, for 7 days, and only for that address. It will not be shown again.");
  });

  it("says a refusal in words, and keeps anything else in the server log", async () => {
    createMock.mockRejectedValue(new ClientLinkError("client_link_limit_reached"));
    expect(await createClientLinkAction(INITIAL, form({}))).toEqual({ ok: false, message: "You already have 10 open client links. Revoke one first." });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockRejectedValue(new Error("relation does not exist"));
    expect(await createClientLinkAction(INITIAL, form({}))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("revokeClientLinkAction (AC1)", () => {
  it("stops a signed-out request and a link id that is not one", async () => {
    getSessionUserMock.mockResolvedValue(null);
    expect(await revokeClientLinkAction(INITIAL, form({ linkId: LINK }))).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    getSessionUserMock.mockResolvedValue({ id: ACCOUNTANT, email: "books@practice.example" });
    expect(await revokeClientLinkAction(INITIAL, form({ linkId: "x" }))).toEqual({ ok: false, message: "This link is not valid." });
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("revokes as the signed-in person, and says when it is not theirs or not open", async () => {
    expect(await revokeClientLinkAction(INITIAL, form({ linkId: LINK }))).toEqual({ ok: true, message: "Link revoked. It no longer works." });
    expect(revokeMock).toHaveBeenCalledWith({ actorId: ACCOUNTANT, linkId: LINK });
    revokeMock.mockRejectedValue(new ClientLinkError("client_link_not_found"));
    expect(await revokeClientLinkAction(INITIAL, form({ linkId: LINK }))).toEqual({ ok: false, message: "This link is not valid." });
  });
});
