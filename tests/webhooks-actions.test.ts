import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createWebhookEndpointAction, removeWebhookEndpointAction, sendTestWebhookAction, type WebhookActionResult } from "@/app/actions/webhooks";
import { WebhookError } from "@/lib/platform/webhooks";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/webhooks.ts` against a real `inOrg`, the same shape as
 * `tests/api-keys-actions.test.ts`: `server-only`, `authorize`,
 * `@/lib/platform/webhooks` and `sendTestEvent` are stand-ins — those are
 * proven elsewhere — while `inOrg` and the org lookup it makes are real,
 * against a fake network that only answers the organization row.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fa",
}));

const VALID_ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f2";

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { createWebhookEndpointMock, removeWebhookEndpointMock } = vi.hoisted(() => ({
  createWebhookEndpointMock: vi.fn(),
  removeWebhookEndpointMock: vi.fn(),
}));
vi.mock("@/lib/platform/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/webhooks")>();
  return {
    ...actual,
    createWebhookEndpoint: createWebhookEndpointMock,
    removeWebhookEndpoint: removeWebhookEndpointMock,
  };
});

const { sendTestEventMock } = vi.hoisted(() => ({ sendTestEventMock: vi.fn() }));
vi.mock("@/lib/webhooks/deliver", () => ({ sendTestEvent: sendTestEventMock }));

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

const INITIAL: WebhookActionResult = { ok: false, message: "" };

function createForm(url: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("url", url);
  return form;
}

function endpointForm(endpointId: string): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("endpointId", endpointId);
  return form;
}

const SECRET = "whsec_" + "a".repeat(43);

function endpointRow(overrides: Partial<{ id: string; url: string }> = {}) {
  return {
    id: VALID_ID,
    host: "hooks.example",
    url: "https://hooks.example/in",
    createdAt: "2026-09-29T00:00:00.000Z",
    disabledAt: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    ...overrides,
  };
}

describe("createWebhookEndpointAction", () => {
  it("returns the refusal when authorize refuses, and never calls createWebhookEndpoint", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in"));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(createWebhookEndpointMock).not.toHaveBeenCalled();
  });

  it("uses the permission literal webhooks.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in"));

    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "webhooks.manage");
  });

  it("passes the actor, org and url through to createWebhookEndpoint, and returns the secret", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createWebhookEndpointMock.mockResolvedValueOnce({ endpoint: endpointRow(), secret: SECRET });

    const result = await run(() => createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in")));

    expect(createWebhookEndpointMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, url: "https://hooks.example/in" });
    expect(result.ok).toBe(true);
    expect(result.secret).toBe(SECRET);
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("maps an invalid_url WebhookError to its message, and returns no secret", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createWebhookEndpointMock.mockRejectedValueOnce(new WebhookError("invalid_url", "the URL must use https"));

    const result = await run(() => createWebhookEndpointAction(INITIAL, createForm("http://hooks.example/in")));

    expect(result).toEqual({ ok: false, message: "the URL must use https" });
    expect(result.secret).toBeUndefined();
  });

  it("maps a webhook_limit_reached WebhookError to its message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("admin") });
    createWebhookEndpointMock.mockRejectedValueOnce(new WebhookError("webhook_limit_reached"));

    const result = await run(() => createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in")));

    expect(result).toEqual({ ok: false, message: "This workspace already has 5 webhook endpoints. Remove one first." });
  });

  it("logs and returns the generic message for anything else, and never logs the secret", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createWebhookEndpointMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await run(() => createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in")));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(errorSpy).toHaveBeenCalled();
    for (const spy of [errorSpy, warnSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("whsec_");
        }
      }
    }
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("never logs the secret on a successful create", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    createWebhookEndpointMock.mockResolvedValueOnce({ endpoint: endpointRow(), secret: SECRET });

    await run(() => createWebhookEndpointAction(INITIAL, createForm("https://hooks.example/in")));

    for (const spy of [errorSpy, warnSpy, logSpy, infoSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });
});

describe("removeWebhookEndpointAction", () => {
  it("returns the refusal when authorize refuses, and never calls removeWebhookEndpoint", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await removeWebhookEndpointAction(INITIAL, endpointForm(VALID_ID));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(removeWebhookEndpointMock).not.toHaveBeenCalled();
  });

  it("uses the permission literal webhooks.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await removeWebhookEndpointAction(INITIAL, endpointForm(VALID_ID));

    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "webhooks.manage");
  });

  it("rejects an endpointId that is not a uuid, without calling removeWebhookEndpoint", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => removeWebhookEndpointAction(INITIAL, endpointForm("not-a-uuid")));

    expect(result).toEqual({ ok: false, message: "No active webhook endpoint with that id in this workspace." });
    expect(removeWebhookEndpointMock).not.toHaveBeenCalled();
  });

  it("passes the actor, org and endpointId through to removeWebhookEndpoint, and revalidates", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("admin") });
    removeWebhookEndpointMock.mockResolvedValueOnce(undefined);

    const result = await run(() => removeWebhookEndpointAction(INITIAL, endpointForm(VALID_ID)));

    expect(removeWebhookEndpointMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, endpointId: VALID_ID });
    expect(result).toEqual({ ok: true, message: "Webhook endpoint removed." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("maps a not_found WebhookError to its message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    removeWebhookEndpointMock.mockRejectedValueOnce(new WebhookError("not_found"));

    const result = await run(() => removeWebhookEndpointAction(INITIAL, endpointForm(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "No active webhook endpoint with that id in this workspace." });
  });

  it("logs and returns the generic message for anything else", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    removeWebhookEndpointMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await run(() => removeWebhookEndpointAction(INITIAL, endpointForm(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("sendTestWebhookAction", () => {
  it("returns the refusal when authorize refuses, and never calls sendTestEvent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await sendTestWebhookAction(INITIAL, endpointForm(VALID_ID));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(sendTestEventMock).not.toHaveBeenCalled();
  });

  it("uses the permission literal webhooks.manage", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });

    await sendTestWebhookAction(INITIAL, endpointForm(VALID_ID));

    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "webhooks.manage");
  });

  it("rejects an endpointId that is not a uuid, without calling sendTestEvent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => sendTestWebhookAction(INITIAL, endpointForm("not-a-uuid")));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not delivered:");
    expect(sendTestEventMock).not.toHaveBeenCalled();
  });

  it("reports a delivered test with its status", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    sendTestEventMock.mockResolvedValueOnce({ ok: true, status: 200, error: null });

    const result = await run(() => sendTestWebhookAction(INITIAL, endpointForm(VALID_ID)));

    expect(sendTestEventMock).toHaveBeenCalledWith({ orgId: ORG, endpointId: VALID_ID });
    expect(result).toEqual({ ok: true, message: "Delivered (HTTP 200)." });
  });

  it("reports an undelivered test with its reason", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("admin") });
    sendTestEventMock.mockResolvedValueOnce({ ok: false, status: null, error: "destination is not public" });

    const result = await run(() => sendTestWebhookAction(INITIAL, endpointForm(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "Not delivered: destination is not public." });
  });
});
