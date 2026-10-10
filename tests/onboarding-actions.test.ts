import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";

/**
 * Creating a workspace from the onboarding page (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M2): the
 * session is the gate, and Arc mainnet is offered and accepted only for a person on the allowlist while it is on, so a
 * form posted by hand with `network=arc-mainnet` is refused on the server.
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

const { authorizeMock, startShadowModeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), startShadowModeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/shadow-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shadow-mode")>()),
  startShadowMode: startShadowModeMock,
}));

import { createWorkspaceAction } from "@/app/onboarding/actions";
import { ShadowModeError } from "@/lib/shadow-mode";

const env = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };
const on = configFromEnv({ ...env, MAINNET_ENABLED: "1", MAINNET_ALLOWLIST: "owner@acme.test" });
const off = configFromEnv(env);
const INITIAL = { ok: false, message: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  getSessionUserMock.mockReset().mockResolvedValue({ id: "user-1", email: "owner@acme.test" });
  createWorkspaceMock.mockReset().mockResolvedValue({ orgId: "org-1", slug: "acme" });
  redirectMock.mockClear();
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "user-1", email: "owner@acme.test" }, membership: { orgId: "org-1", role: "owner" } });
  startShadowModeMock.mockReset().mockResolvedValue({ currency: "USDC", startedAt: "2026-10-10T00:00:00Z", startedBy: "user-1" });
});

/** Where the action sent the person: the path of its redirect. */
const redirectedTo = () => redirectMock.mock.calls.at(-1)?.[0];

describe("createWorkspaceAction (mainnet go-live M2)", () => {
  it("creates on Arc mainnet for a person on the allowlist while it is on", async () => {
    await expect(runWithConfig(on, () => createWorkspaceAction(INITIAL, form({ name: "Acme", network: "arc-mainnet" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: "user-1", name: "Acme", network: "arc-mainnet" });
  });

  it("refuses Arc mainnet to anyone else, or while it is off, and creates nothing", async () => {
    getSessionUserMock.mockResolvedValue({ id: "user-2", email: "someone@else.test" });
    expect(await runWithConfig(on, () => createWorkspaceAction(INITIAL, form({ name: "Acme", network: "arc-mainnet" })))).toEqual({
      ok: false,
      message: "Arc mainnet is not open to this account yet.",
    });
    getSessionUserMock.mockResolvedValue({ id: "user-1", email: "owner@acme.test" });
    expect(await runWithConfig(off, () => createWorkspaceAction(INITIAL, form({ name: "Acme", network: "arc-mainnet" })))).toEqual({
      ok: false,
      message: "Arc mainnet is not open to this account yet.",
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("creates on Arc testnet for any other value, or none", async () => {
    for (const network of [undefined, "arc-testnet", "mainnet", "ARC"]) {
      createWorkspaceMock.mockClear();
      const fields: Record<string, string> = network === undefined ? { name: "Acme" } : { name: "Acme", network };
      await expect(runWithConfig(on, () => createWorkspaceAction(INITIAL, form(fields)))).rejects.toThrow("NEXT_REDIRECT");
      expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: "user-1", name: "Acme", network: "arc-testnet" });
    }
  });
});

describe("createWorkspaceAction with shadow mode ticked (shadow mode S1)", () => {
  it("turns it on as Settings does: an owner's, in USDC, with the person who created the workspace as the actor", async () => {
    await expect(runWithConfig(off, () => createWorkspaceAction(INITIAL, form({ name: "Acme", shadow: "on" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: "user-1", name: "Acme", network: "arc-testnet" });
    expect(authorizeMock).toHaveBeenCalledWith("acme", "approval.policy");
    expect(startShadowModeMock).toHaveBeenCalledWith({ actorId: "user-1", currency: "USDC" });
    expect(redirectedTo()).toBe("/o/acme/console");
  });

  it("leaves it off when not ticked", async () => {
    await expect(runWithConfig(off, () => createWorkspaceAction(INITIAL, form({ name: "Acme" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(startShadowModeMock).not.toHaveBeenCalled();
    expect(redirectedTo()).toBe("/o/acme/console");
  });

  it("never turns it on for an Arc mainnet workspace, whatever the form sent", async () => {
    await expect(runWithConfig(on, () => createWorkspaceAction(INITIAL, form({ name: "Acme", network: "arc-mainnet", shadow: "on" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: "user-1", name: "Acme", network: "arc-mainnet" });
    expect(startShadowModeMock).not.toHaveBeenCalled();
    expect(redirectedTo()).toBe("/o/acme/console");
  });

  it("still opens the workspace when it cannot turn on, and the console says so", async () => {
    startShadowModeMock.mockRejectedValue(new ShadowModeError("cycle_running"));
    await expect(runWithConfig(off, () => createWorkspaceAction(INITIAL, form({ name: "Acme", shadow: "on" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(redirectedTo()).toBe("/o/acme/console?shadow=not-started");

    startShadowModeMock.mockReset();
    authorizeMock.mockResolvedValue({ ok: false, message: "You are not a member of this workspace." });
    await expect(runWithConfig(off, () => createWorkspaceAction(INITIAL, form({ name: "Acme", shadow: "on" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(startShadowModeMock).not.toHaveBeenCalled();
    expect(redirectedTo()).toBe("/o/acme/console?shadow=not-started");
  });
});

describe("the console, after shadow mode did not turn on at creation", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("says so, and links to Settings, until shadow mode is on", () => {
    expect(page).toContain("{query.shadow === SHADOW_NOT_STARTED && !shadow && (");
    expect(page).toContain("Your workspace is ready, but shadow mode did not turn on.");
    expect(page).toContain('orgHref(slug, "/settings#shadow-mode-title")');
  });
});
