import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_SUMMARIES } from "@/lib/auth/roles";
import type { ClientLinkPreview } from "@/lib/platform/client-links";

/**
 * The client's page on an accountant's link, /join/[token] (docs/superpowers/specs/2026-10-23-accountant-client-links-
 * design.md AC2): sign-in first; an open link names the accountant, says what an accountant may do, and asks for a name
 * and an explicit consent; a link bound to another address, the accountant's own, and a dead one offer nothing and name
 * no one; before migration 0143 it says the feature is not available yet.
 */

const { verifySession, preview, order } = vi.hoisted(() => ({
  verifySession: vi.fn(),
  preview: vi.fn(),
  order: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/join/x" }));
vi.mock("@/lib/auth/session", () => ({ verifySession }));
vi.mock("@/lib/platform/client-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/client-links")>()),
  clientLinkPreview: preview,
}));
vi.mock("@/app/join/actions", () => ({ joinFromClientLinkAction: vi.fn() }));

import JoinPage, { metadata } from "@/app/join/[token]/page";

const TOKEN = `vxj_${"a".repeat(43)}`;
const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const OPEN: ClientLinkPreview = { state: "open", linkId: "link-1", accountantId: ACCOUNTANT, accountantEmail: "books@practice.example", boundEmail: null };

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = async () => renderToStaticMarkup(await JoinPage({ params: Promise.resolve({ token: TOKEN }) }));

beforeEach(() => {
  order.length = 0;
  verifySession.mockReset().mockImplementation(async () => {
    order.push("session");
    return { id: "client-1", email: "owner@client.example" };
  });
  preview.mockReset().mockImplementation(async () => {
    order.push("preview");
    return OPEN;
  });
});

describe("the client's page (AC2)", () => {
  it("checks the session first, coming back to this link after sign-in, and is never indexed", async () => {
    await render();
    expect(verifySession).toHaveBeenCalledWith(`/join/${TOKEN}`);
    expect(order).toEqual(["session", "preview"]);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("names the accountant, says what an accountant does, and asks for a name and consent", async () => {
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("books@practice.example invites you to keep your books in Vestiarion.");
    expect(page).toContain("They will be your workspace's accountant:");
    expect(page).toContain(ROLE_SUMMARIES.accountant);
    expect(page).toContain("Let books@practice.example into this workspace as its accountant. I can remove them from Members at any time.");
    expect(page).toContain("It opens on Arc testnet in shadow mode");
    expect(page).toContain("Signed in as owner@client.example.");
    expect(markup).toContain('name="name"');
    expect(markup).toContain('name="token"');
    expect(markup).toContain(`value="${TOKEN}"`);
  });

  it.each([
    [{ ...OPEN, boundEmail: "someone@else.example" }, "This link was made for a different email address. Sign in with that address to use it."],
    [{ state: "used" }, "This link has already been used."],
    [{ state: "expired" }, "This link has expired. Ask your accountant for a new one."],
    [{ state: "invalid" }, "This link is not valid."],
    [{ state: "not_ready" }, "Client invite links are not available yet."],
  ] as Array<[ClientLinkPreview, string]>)("offers nothing and names no one for %o", async (state, sentence) => {
    preview.mockResolvedValue(state);
    const markup = await render();
    expect(text(markup)).toContain(sentence);
    expect(markup).not.toContain('name="name"');
    expect(markup).not.toContain("books@practice.example");
    expect(markup).not.toContain("someone@else.example");
  });

  it("tells the accountant opening their own link to send it on", async () => {
    verifySession.mockResolvedValue({ id: ACCOUNTANT, email: "books@practice.example" });
    const markup = await render();
    expect(text(markup)).toContain("This is your own client link. Send it to your client.");
    expect(markup).not.toContain('name="name"');
  });

  it("says try again when the link cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    preview.mockRejectedValue(new Error("connection refused"));
    const markup = await render();
    expect(text(markup)).toContain("This page could not load. Try again in a moment.");
    expect(markup).not.toContain('name="name"');
  });
});
