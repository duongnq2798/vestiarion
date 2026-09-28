import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  type MemberActionResult,
} from "@/app/actions/members";
import { MemberError } from "@/lib/platform/members";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/members.ts` against a real `inOrg`, the same shape as
 * `tests/agent-action.test.ts`: `server-only`, `authorize` and
 * `@/lib/platform/members`'s mutating functions are stand-ins — the platform
 * module they invite/change/remove through was already proven against
 * PostgREST in `tests/members.test.ts` — while `inOrg` and the org lookup it
 * makes are real, against a fake network that answers the organization row.
 */

const { ORG, USER, OTHER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e3",
  OTHER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e4",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
// `revalidatePath` requires a request's static-generation store, which does
// not exist outside Next's own server; stubbed so a success path can be
// asserted on rather than swallowed as a caught, logged error, and hoisted so
// tests can assert on whether it was called.
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { inviteMemberMock, changeMemberRoleMock, removeMemberMock, revokeInvitationMock } = vi.hoisted(() => ({
  inviteMemberMock: vi.fn(),
  changeMemberRoleMock: vi.fn(),
  removeMemberMock: vi.fn(),
  revokeInvitationMock: vi.fn(),
}));
vi.mock("@/lib/platform/members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/members")>();
  return {
    ...actual,
    inviteMember: inviteMemberMock,
    changeMemberRole: changeMemberRoleMock,
    removeMember: removeMemberMock,
    revokeInvitation: revokeInvitationMock,
  };
});

// Every mock is shared across tests (module mocks are singletons); cleared
// between tests so a `not.toHaveBeenCalled()` assertion cannot pass only
// because an earlier test happened to run first.
beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function membership(role: "owner" | "admin" | "approver" | "viewer") {
  return { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role };
}

function orgRow() {
  return { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

/** Runs `fn` inside a real organization scope, over a fake network that only answers the org row. */
function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: MemberActionResult = { ok: false, message: "" };

function inviteForm(role: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("email", "new@example.com");
  form.set("role", role);
  return form;
}

function roleForm(userId: string, role: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("userId", userId);
  form.set("role", role);
  return form;
}

function removeForm(userId: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("userId", userId);
  return form;
}

describe("inviteMemberAction", () => {
  it("returns the refusal when authorize refuses, and never calls inviteMember", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await inviteMemberAction(INITIAL, inviteForm("viewer"));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(inviteMemberMock).not.toHaveBeenCalled();
  });

  it("rejects a role outside the four, before calling inviteMember", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => inviteMemberAction(INITIAL, inviteForm("superadmin")));

    expect(result).toEqual({ ok: false, message: "Choose a role." });
    expect(inviteMemberMock).not.toHaveBeenCalled();
  });

  it("returns the link and the not-configured message when inviteMember resolves emailed: false", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    inviteMemberMock.mockResolvedValueOnce({ invitationId: "inv-1", link: "https://tests.vestiarion.xyz/invite/tok", emailed: false });

    const result = await run(() => inviteMemberAction(INITIAL, inviteForm("viewer")));

    expect(result).toEqual({
      ok: true,
      link: "https://tests.vestiarion.xyz/invite/tok",
      message: "Email is not configured, so nothing was sent. Share this link with them; it is shown only once.",
    });
    expect(inviteMemberMock).toHaveBeenCalledWith({ actorId: USER, orgName: "Northstar", email: "new@example.com", role: "viewer" });
  });

  it("returns a MemberError's message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    inviteMemberMock.mockRejectedValueOnce(new MemberError("already_a_member"));

    const result = await run(() => inviteMemberAction(INITIAL, inviteForm("viewer")));

    expect(result).toEqual({ ok: false, message: "That person is already a member of this workspace." });
  });
});

describe("removeMemberAction", () => {
  it("refuses a viewer removing someone else, without calling removeMember", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("viewer") });

    const result = await run(() => removeMemberAction(INITIAL, removeForm(OTHER)));

    expect(result.ok).toBe(false);
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it("lets a viewer remove themselves, returns left: true, and does not revalidate", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("viewer") });
    removeMemberMock.mockResolvedValueOnce(undefined);

    const result = await run(() => removeMemberAction(INITIAL, removeForm(USER)));

    expect(removeMemberMock).toHaveBeenCalledWith({ actorId: USER, userId: USER });
    expect(result).toEqual({ ok: true, message: "You left the workspace.", left: true });
    // Revalidating here would refresh the current route in the same
    // transition that delivers `left: true` — the membership gate then calls
    // notFound() — which can unmount the component whose effect is meant to
    // redirect to /onboarding before it runs. So self-removal must not
    // revalidate; the client redirects on `left: true` instead.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("removing someone else revalidates, and returns left: false", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    removeMemberMock.mockResolvedValueOnce(undefined);

    const result = await run(() => removeMemberAction(INITIAL, removeForm(OTHER)));

    expect(removeMemberMock).toHaveBeenCalledWith({ actorId: USER, userId: OTHER });
    expect(result).toEqual({ ok: true, message: "Member removed.", left: false });
    expect(revalidatePathMock).toHaveBeenCalled();
  });
});

describe("changeMemberRoleAction", () => {
  it("passes { actorId, userId, role } through to changeMemberRole", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    changeMemberRoleMock.mockResolvedValueOnce(undefined);

    const result = await run(() => changeMemberRoleAction(INITIAL, roleForm(OTHER, "approver")));

    expect(changeMemberRoleMock).toHaveBeenCalledWith({ actorId: USER, userId: OTHER, role: "approver" });
    expect(result).toEqual({ ok: true, message: "Role updated." });
  });
});
