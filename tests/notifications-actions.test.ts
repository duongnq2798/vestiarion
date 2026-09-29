import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { setNotifyEmailAction, type NotifyEmailActionResult } from "@/app/actions/notifications";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/app/actions/notifications.ts` against a real `inOrg`, the same shape as
 * `tests/members-actions.test.ts`: `server-only` and `authorize` are stand-ins,
 * while `inOrg` and the org lookup it makes are real, against a fake network
 * that also answers the `memberships` update the action makes directly (it
 * has no library function of its own to stand in for).
 */

const { ORG, USER, OTHER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f0f",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e6",
  OTHER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e7",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
// `revalidatePath` requires a request's static-generation store, which does
// not exist outside Next's own server; stubbed so a success path can be
// asserted on rather than swallowed as a caught, logged error.
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

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

/** Runs `fn` inside a real organization scope, over a fake network that answers the org row and the membership update. */
function run<T>(fn: () => Promise<T>): { result: Promise<T>; requests: RecordedRequest[] } {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return { result: runWith({ config, db: fake.client, fetch: fake.fetch }, fn), requests: fake.requests };
}

const INITIAL: NotifyEmailActionResult = { ok: false, message: "" };

function form(on: string, extra: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  formData.set("on", on);
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return formData;
}

describe("setNotifyEmailAction", () => {
  it("returns the refusal when authorize refuses, and never touches memberships", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await setNotifyEmailAction(INITIAL, form("true"));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
  });

  it("gates on workspace.read, not members.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await setNotifyEmailAction(INITIAL, form("true"));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "workspace.read");
  });

  it("rejects a value that is neither \"true\" nor \"false\", without writing", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("viewer") });

    const { result, requests } = run(() => setNotifyEmailAction(INITIAL, form("maybe")));

    expect(await result).toEqual({ ok: false, message: "Choose a value." });
    expect(requests.some((request) => request.path === "/rest/v1/memberships")).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("updates only the viewer's own row, filtered on the session's user id and the org", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const { result, requests } = run(() => setNotifyEmailAction(INITIAL, form("false")));

    expect(await result).toEqual({ ok: true, message: "Emails off." });
    const update = requests.find((request) => request.path === "/rest/v1/memberships");
    expect(update?.method).toBe("PATCH");
    expect(update?.body).toEqual({ notify_email: false });
    expect(update?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(update?.params.get("user_id")).toBe(`eq.${USER}`);
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("ignores a userId field in the form: the filter still names the session's own id", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const { result, requests } = run(() => setNotifyEmailAction(INITIAL, form("true", { userId: OTHER })));

    expect(await result).toEqual({ ok: true, message: "Emails on." });
    const update = requests.find((request) => request.path === "/rest/v1/memberships");
    expect(update?.params.get("user_id")).toBe(`eq.${USER}`);
    expect(update?.params.get("user_id")).not.toBe(`eq.${OTHER}`);
    expect(update?.body).toEqual({ notify_email: true });
  });
});
