import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening a workspace from an accountant's client link (docs/superpowers/specs/2026-10-23-accountant-client-links-
 * design.md AC3): the session is the gate; the link is checked before anything is made; the workspace is made by the
 * usual `createWorkspace`, always on Arc testnet and always in shadow mode, whatever the form sent; and a claim that fails
 * once the workspace exists leaves the client their workspace, with the console saying the accountant was not added.
 */

vi.mock("server-only", () => ({}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${path};303;` });
  }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { getSessionUserMock } = vi.hoisted(() => ({ getSessionUserMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: getSessionUserMock }));

const { createWorkspaceMock } = vi.hoisted(() => ({ createWorkspaceMock: vi.fn() }));
vi.mock("@/lib/platform/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/workspace")>()),
  createWorkspace: createWorkspaceMock,
}));

const { previewMock, claimMock } = vi.hoisted(() => ({ previewMock: vi.fn(), claimMock: vi.fn() }));
vi.mock("@/lib/platform/client-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/client-links")>()),
  clientLinkPreview: previewMock,
  claimClientLink: claimMock,
}));

const { shadowMock } = vi.hoisted(() => ({ shadowMock: vi.fn() }));
vi.mock("@/lib/shadow-mode-at-creation", () => ({ startShadowModeAtCreation: shadowMock }));

const { firstTouchMock } = vi.hoisted(() => ({ firstTouchMock: vi.fn() }));
vi.mock("@/lib/growth/record", () => ({ recordFirstTouch: firstTouchMock }));

import { joinFromClientLinkAction } from "@/app/join/actions";
import { ClientLinkError, clientLinkTokenHash, generateClientLinkToken } from "@/lib/platform/client-links";
import { WorkspaceLimitError } from "@/lib/platform/workspace";

const INITIAL = { ok: false, message: "" };
const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const { token } = generateClientLinkToken();
const OPEN = { state: "open", linkId: "link-1", accountantId: ACCOUNTANT, accountantEmail: "books@practice.example", boundEmail: null };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const filled = (extra: Record<string, string> = {}) => form({ token, name: "Client Books", consent: "on", ...extra });
const redirectedTo = () => redirectMock.mock.calls.at(-1)?.[0];

beforeEach(() => {
  getSessionUserMock.mockReset().mockResolvedValue({ id: CLIENT, email: "owner@client.example" });
  createWorkspaceMock.mockReset().mockResolvedValue({ orgId: "org-1", slug: "client-books" });
  previewMock.mockReset().mockResolvedValue(OPEN);
  claimMock.mockReset().mockResolvedValue({ linkId: "link-1", accountantId: ACCOUNTANT });
  shadowMock.mockReset().mockResolvedValue(true);
  firstTouchMock.mockReset().mockResolvedValue(undefined);
  redirectMock.mockClear();
});

describe("joinFromClientLinkAction: before anything is made", () => {
  it("stops a signed-out request", async () => {
    getSessionUserMock.mockResolvedValue(null);
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    expect(previewMock).not.toHaveBeenCalled();
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("refuses what is not a link, a missing name and a missing consent", async () => {
    expect(await joinFromClientLinkAction(INITIAL, filled({ token: "vxj_short" }))).toEqual({ ok: false, message: "This link is not valid." });
    expect(await joinFromClientLinkAction(INITIAL, filled({ name: "  " }))).toEqual({ ok: false, message: "Give the workspace a name." });
    expect(await joinFromClientLinkAction(INITIAL, form({ token, name: "Client Books" }))).toEqual({
      ok: false,
      message: "Tick the box to let your accountant into the workspace.",
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "invalid" }, "This link is not valid."],
    [{ state: "used" }, "This link has already been used."],
    [{ state: "expired" }, "This link has expired. Ask your accountant for a new one."],
    [{ state: "not_ready" }, "Client invite links are not available yet."],
    [{ ...OPEN, boundEmail: "someone@else.example" }, "This link was made for a different email address. Sign in with that address to use it."],
  ])("opens no workspace for a link that offers nothing (%o)", async (preview, message) => {
    previewMock.mockResolvedValue(preview);
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({ ok: false, message });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("opens none for the accountant's own link", async () => {
    getSessionUserMock.mockResolvedValue({ id: ACCOUNTANT, email: "books@practice.example" });
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({ ok: false, message: "This is your own client link. Send it to your client." });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("says try again when the link cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    previewMock.mockRejectedValue(new Error("connection refused"));
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe("joinFromClientLinkAction: the workspace", () => {
  it("is made on Arc testnet in shadow mode, whatever the form sent, with the accountant claimed into it", async () => {
    await expect(joinFromClientLinkAction(INITIAL, filled({ network: "arc-mainnet", shadow: "off" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: CLIENT, name: "Client Books", network: "arc-testnet", via: "accountant_link" });
    expect(claimMock).toHaveBeenCalledWith({ tokenHash: clientLinkTokenHash(token), userId: CLIENT, orgId: "org-1" });
    expect(shadowMock).toHaveBeenCalledWith("client-books");
    // The claim recorded the link as the first touch; the cookie's is not asked for.
    expect(firstTouchMock).not.toHaveBeenCalled();
    expect(redirectedTo()).toBe("/o/client-books/console");
  });

  it("says when the client already has 3 workspaces on Arc testnet, and claims nothing", async () => {
    createWorkspaceMock.mockRejectedValue(new WorkspaceLimitError("arc-testnet"));
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({
      ok: false,
      message: "You already have 3 workspaces on Arc testnet, the most one person can create there.",
    });
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("keeps any other creation failure in the server log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createWorkspaceMock.mockRejectedValue(new Error("relation does not exist"));
    expect(await joinFromClientLinkAction(INITIAL, filled())).toEqual({ ok: false, message: "The workspace could not be created. Try again in a moment." });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps the workspace when the claim fails after it exists, and the console says the accountant was not added", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    claimMock.mockRejectedValue(new ClientLinkError("client_link_used"));
    await expect(joinFromClientLinkAction(INITIAL, filled())).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledWith("client-books");
    expect(firstTouchMock).toHaveBeenCalledWith("org-1");
    expect(redirectedTo()).toBe("/o/client-books/console?accountant=not-added");
    expect(JSON.stringify(error.mock.calls)).not.toContain(token);
    error.mockRestore();
  });

  it("says so too when shadow mode did not turn on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shadowMock.mockResolvedValue(false);
    await expect(joinFromClientLinkAction(INITIAL, filled())).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectedTo()).toBe("/o/client-books/console?shadow=not-started");
    claimMock.mockRejectedValue(new Error("network"));
    await expect(joinFromClientLinkAction(INITIAL, filled())).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectedTo()).toBe("/o/client-books/console?accountant=not-added&shadow=not-started");
  });
});

describe("the console, after the accountant was not added", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("says so, and links to Members", () => {
    expect(page).toContain("{query.accountant === ACCOUNTANT_NOT_ADDED && (");
    expect(page).toContain("Your accountant was not added.");
    expect(page).toContain("Invite them on Members");
    expect(page).toContain('orgHref(slug, "/members")');
  });
});
