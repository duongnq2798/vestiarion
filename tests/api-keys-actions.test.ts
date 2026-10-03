import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyActionResult } from "@/app/actions/api-keys";
import { ApiKeyError } from "@/lib/platform/api-keys";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/api-keys.ts` against a real `inOrg`, the same shape as
 * `tests/members-actions.test.ts`: `server-only`, `authorize` and
 * `@/lib/platform/api-keys`'s mutating functions are stand-ins — that library
 * is proven elsewhere — while `inOrg` and the org lookup it makes are real,
 * against a fake network that only answers the organization row.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f9",
}));

const VALID_ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { createApiKeyMock, revokeApiKeyMock } = vi.hoisted(() => ({
  createApiKeyMock: vi.fn(),
  revokeApiKeyMock: vi.fn(),
}));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return {
    ...actual,
    createApiKey: createApiKeyMock,
    revokeApiKey: revokeApiKeyMock,
  };
});

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

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: ApiKeyActionResult = { ok: false, message: "" };

function createForm(name: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("name", name);
  return form;
}

function revokeForm(keyId: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("keyId", keyId);
  return form;
}

const SECRET_TOKEN = "vxk_abcdefgh_" + "a".repeat(43);

function keyRow(overrides: Partial<{ id: string; name: string; prefix: string }> = {}) {
  return {
    id: VALID_ID,
    name: "Reporting",
    prefix: "abcdefgh",
    scopes: ["read"] as const,
    createdAt: "2026-09-29T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("createApiKeyAction", () => {
  it("returns the refusal when authorize refuses, and never calls createApiKey", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await createApiKeyAction(INITIAL, createForm("Reporting"));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("uses the permission literal api_keys.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await createApiKeyAction(INITIAL, createForm("Reporting"));

    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "api_keys.manage");
  });

  it("passes the actor, org and name through to createApiKey, and returns the token", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockResolvedValueOnce({ key: keyRow(), token: SECRET_TOKEN });

    const result = await run(() => createApiKeyAction(INITIAL, createForm("Reporting")));

    expect(createApiKeyMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, name: "Reporting", write: false });
    expect(result.ok).toBe(true);
    expect(result.token).toBe(SECRET_TOKEN);
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("creates a read-and-write key only when the box is ticked (write API R1)", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockResolvedValueOnce({ key: keyRow(), token: SECRET_TOKEN });
    const form = createForm("Billing sync");
    form.set("write", "on");

    await run(() => createApiKeyAction(INITIAL, form));

    expect(createApiKeyMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, name: "Billing sync", write: true });
  });

  it("maps an invalid_name ApiKeyError to its message, and returns no token", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockRejectedValueOnce(new ApiKeyError("invalid_name"));

    const result = await run(() => createApiKeyAction(INITIAL, createForm("")));

    expect(result).toEqual({ ok: false, message: "A key's name must be 1 to 60 characters." });
    expect(result.token).toBeUndefined();
  });

  it("maps an api_key_limit_reached ApiKeyError to its message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockRejectedValueOnce(new ApiKeyError("api_key_limit_reached"));

    const result = await run(() => createApiKeyAction(INITIAL, createForm("Reporting")));

    expect(result).toEqual({ ok: false, message: "This workspace already has 20 API keys. Revoke one first." });
  });

  it("logs and returns the generic message for anything else, and never logs the token", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await run(() => createApiKeyAction(INITIAL, createForm("Reporting")));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(errorSpy).toHaveBeenCalled();
    for (const spy of [errorSpy, warnSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("vxk_");
        }
      }
    }
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("never logs the token on a successful create", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createApiKeyMock.mockResolvedValueOnce({ key: keyRow(), token: SECRET_TOKEN });

    await run(() => createApiKeyAction(INITIAL, createForm("Reporting")));

    for (const spy of [errorSpy, warnSpy, logSpy, infoSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });
});

describe("revokeApiKeyAction", () => {
  it("returns the refusal when authorize refuses, and never calls revokeApiKey", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await revokeApiKeyAction(INITIAL, revokeForm(VALID_ID));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(revokeApiKeyMock).not.toHaveBeenCalled();
  });

  it("uses the permission literal api_keys.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await revokeApiKeyAction(INITIAL, revokeForm(VALID_ID));

    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "api_keys.manage");
  });

  it("rejects a keyId that is not a uuid, without calling revokeApiKey", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => revokeApiKeyAction(INITIAL, revokeForm("not-a-uuid")));

    expect(result).toEqual({ ok: false, message: "No active API key with that id in this workspace." });
    expect(revokeApiKeyMock).not.toHaveBeenCalled();
  });

  it("passes the actor, org and keyId through to revokeApiKey, and revalidates", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("admin") });
    revokeApiKeyMock.mockResolvedValueOnce(undefined);

    const result = await run(() => revokeApiKeyAction(INITIAL, revokeForm(VALID_ID)));

    expect(revokeApiKeyMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, keyId: VALID_ID });
    expect(result).toEqual({ ok: true, message: "API key revoked." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("maps a not_found ApiKeyError to its message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    revokeApiKeyMock.mockRejectedValueOnce(new ApiKeyError("not_found"));

    const result = await run(() => revokeApiKeyAction(INITIAL, revokeForm(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "No active API key with that id in this workspace." });
  });

  it("logs and returns the generic message for anything else", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    revokeApiKeyMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await run(() => revokeApiKeyAction(INITIAL, revokeForm(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
