import { beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectGitHubAction } from "@/app/actions/github";

/**
 * Disconnecting GitHub from Settings (docs/superpowers/specs/2026-10-04-github-app-design.md G3): an owner or admin
 * removes one connected installation from the workspace; GitHub keeps the app installed until they uninstall it there.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { authorize: vi.fn(), remove: vi.fn(), revalidate: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/github/installs", () => ({ removeInstallation: mocks.remove }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e02";
const ACCESS = { ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "admin" } };
const empty = { ok: false, message: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockResolvedValue(ACCESS);
  mocks.remove.mockResolvedValue(true);
});

describe("disconnectGitHubAction", () => {
  it("needs integrations.manage, removes the workspace's link as the person, and says how to take the app's access away", async () => {
    const result = await disconnectGitHubAction(empty, form({ installationId: "42" }));
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.remove).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, installationId: 42 });
    expect(result).toEqual({ ok: true, message: "GitHub is disconnected from this workspace. To take the app's access away, uninstall it on GitHub." });
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("does nothing for someone who may not manage integrations, or for an id that is not one", async () => {
    mocks.authorize.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await disconnectGitHubAction(empty, form({ installationId: "42" }))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(await disconnectGitHubAction(empty, form({ installationId: "42abc" }))).toEqual({ ok: false, message: "That GitHub account is not connected to this workspace." });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("says so when the account was not connected, and asks to try again when removing fails", async () => {
    mocks.remove.mockResolvedValueOnce(false);
    expect(await disconnectGitHubAction(empty, form({ installationId: "42" }))).toEqual({ ok: false, message: "That GitHub account is not connected to this workspace." });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.remove.mockRejectedValueOnce(new Error("connection reset"));
    expect(await disconnectGitHubAction(empty, form({ installationId: "42" }))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    log.mockRestore();
  });
});
