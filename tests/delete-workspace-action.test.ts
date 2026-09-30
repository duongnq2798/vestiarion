import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { deleteWorkspaceAction, type DeleteWorkspaceActionResult } from "@/app/actions/workspace";
import { DeleteWorkspaceError } from "@/lib/platform/delete-workspace";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/workspace.ts` against a real `inOrg`, the shape of
 * `tests/go-live-actions.test.ts`: `server-only`, `authorize`, `redirect` and
 * `deleteWorkspace` are stand-ins — the library is proven in
 * `tests/delete-workspace-lib.test.ts` — while `inOrg` and its org lookup are
 * real, against a fake network that only answers the organization row.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d1e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fe",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

/** `redirect` throws to navigate, as Next's does. */
const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${path};303;` });
  }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { deleteWorkspaceMock } = vi.hoisted(() => ({ deleteWorkspaceMock: vi.fn() }));
vi.mock("@/lib/platform/delete-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/delete-workspace")>();
  return { ...actual, deleteWorkspace: deleteWorkspaceMock };
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function orgRow() {
  return { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const owner = () => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "owner" as const },
});

const INITIAL: DeleteWorkspaceActionResult = { ok: false, message: "" };

function form(fields: Record<string, string> = { confirmSlug: "northstar" }): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteWorkspaceAction", () => {
  it("uses the owner-only permission literal org.administer", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });
    await deleteWorkspaceAction(INITIAL, form());
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "org.administer");
  });

  it("returns the refusal when authorize refuses, and never reaches the library", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (admin) cannot do that." });
    const result = await deleteWorkspaceAction(INITIAL, form());
    expect(result).toEqual({ ok: false, message: "Your role in this workspace (admin) cannot do that." });
    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("passes the org, the actor and the typed slug to the library, then redirects to /onboarding", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    deleteWorkspaceMock.mockResolvedValueOnce(undefined);

    await expect(run(() => deleteWorkspaceAction(INITIAL, form({ confirmSlug: "northstar" })))).rejects.toThrow("NEXT_REDIRECT");

    expect(deleteWorkspaceMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, confirmSlug: "northstar" });
    expect(redirectMock).toHaveBeenCalledWith("/onboarding");
    // The deleted workspace's pages are not revalidated: the owner is already on their way out.
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("passes a missing confirmation as an empty string, for the library to refuse", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    deleteWorkspaceMock.mockRejectedValueOnce(new DeleteWorkspaceError("slug_mismatch"));

    const result = await run(() => deleteWorkspaceAction(INITIAL, form({})));

    expect(deleteWorkspaceMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, confirmSlug: "" });
    expect(result).toEqual({ ok: false, message: "Type the workspace's slug exactly to confirm." });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it.each([
    ["founding_org", "The founding workspace cannot be deleted."],
    ["pause_first", "Pause the agent first, so no cycle runs while the workspace is deleted."],
    ["cycle_running", "A cycle started in the last 15 minutes has not finished; try again shortly."],
    ["slug_mismatch", "Type the workspace's slug exactly to confirm."],
    ["org_not_found", "This workspace no longer exists."],
    ["not_owner", "Only an owner can delete this workspace."],
    ["payment_in_progress", "A payment is being made; try again in a few minutes."],
  ] as const)("returns %s's fixed message and does not redirect", async (code, message) => {
    authorizeMock.mockResolvedValueOnce(owner());
    deleteWorkspaceMock.mockRejectedValueOnce(new DeleteWorkspaceError(code));

    const result = await run(() => deleteWorkspaceAction(INITIAL, form()));

    expect(result).toEqual({ ok: false, message });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("returns a generic message for anything else, logging the action's name only", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    deleteWorkspaceMock.mockRejectedValueOnce(new Error("connection to 10.0.0.1 refused for northstar"));

    const result = await run(() => deleteWorkspaceAction(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "Something went wrong; try again." });
    expect(logged).toEqual(["workspace: deleteWorkspaceAction failed"]);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
