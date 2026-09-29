import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  removeWebhookEndpoint,
  toWebhookEndpointViews,
  WebhookError,
  type WebhookEndpointRow,
} from "@/lib/platform/webhooks";
import { decryptSecret, encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/webhooks.ts` against a real supabase-js client whose
 * network is a recorder, the same shape as `tests/api-keys.test.ts`:
 * `webhook_endpoints`, `webhook_deliveries`, `create_webhook_endpoint` from
 * migration 0028 and `append_ledger_entry` are answered as PostgREST would.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000000b9";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b7";
const ENDPOINT_ID = "7c3e9f1a-2b4d-4e6f-8a0b-0000000000bf";
const OTHER_ENDPOINT_ID = "7c3e9f1a-2b4d-4e6f-8a0b-0000000000c0";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  vi.restoreAllMocks();
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const URL_TEXT = "https://hooks.receiver.example/vestiarion/in";

/** PostgREST as `webhooks.ts` meets it: `webhook_endpoints`, `webhook_deliveries`, `create_webhook_endpoint` and `append_ledger_entry`. */
function webhooksFake(options: {
  createWebhookEndpoint?: (request: RecordedRequest) => FakeReply | undefined;
  webhookEndpoints?: (request: RecordedRequest) => FakeReply;
  webhookDeliveries?: (request: RecordedRequest) => FakeReply;
  ledgerFails?: boolean;
} = {}) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/create_webhook_endpoint") {
      const failure = options.createWebhookEndpoint?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return {
        body: {
          id: body.p_id, org_id: body.p_org_id, url: body.p_url, secret_enc: body.p_secret_enc,
          created_by: body.p_by, created_at: "2026-09-29T00:00:00Z", disabled_at: null, removed_at: null,
          consecutive_failures: 0, last_success_at: null, last_failure_at: null,
        },
      };
    }
    if (request.path === "/rest/v1/webhook_endpoints") {
      return options.webhookEndpoints ? options.webhookEndpoints(request) : { body: [] };
    }
    if (request.path === "/rest/v1/webhook_deliveries") {
      return options.webhookDeliveries ? options.webhookDeliveries(request) : { body: [] };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (options.ledgerFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
}

/** Everything that left the process: every path, query string and body. */
function everythingSent(requests: RecordedRequest[]): string {
  return JSON.stringify(requests.map((request) => ({ path: request.path, params: request.params.toString(), body: request.body })));
}

describe("createWebhookEndpoint", () => {
  it("validates, creates and returns the secret once, recording ids only in the ledger", async () => {
    const { fake, run } = webhooksFake();

    const { endpoint, secret } = await run(() =>
      withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));

    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [call] = rpcBodies(fake.requests, "create_webhook_endpoint");
    expect(call.p_org_id).toBe(ORG);
    expect(call.p_url).toBe(URL_TEXT);
    expect(call.p_by).toBe(ACTOR);
    expect(typeof call.p_id).toBe("string");
    expect(call.p_id).toBe(endpoint.id);

    // The secret is encrypted under this endpoint's own id, and decrypts back to what was returned.
    const decrypted = decryptSecret(
      call.p_secret_enc as never,
      { orgId: ORG, column: `webhook_secret:${endpoint.id}` },
      parseMasterKeys(MASTER_KEYS)
    );
    expect(decrypted).toBe(secret);

    expect(endpoint).toEqual({
      id: endpoint.id, host: "hooks.receiver.example", url: URL_TEXT, createdAt: "2026-09-29T00:00:00Z",
      disabledAt: null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
    } satisfies WebhookEndpointRow);

    const sent = everythingSent(fake.requests);
    expect(sent).not.toContain(secret);

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "webhook_endpoint_created", p_domain: "system", p_actor: "human" });
    expect(appends[0].p_detail).toEqual({ by: ACTOR, endpointId: endpoint.id });
    const appendJson = JSON.stringify(appends);
    expect(appendJson).not.toContain(secret);
    expect(appendJson).not.toContain(URL_TEXT);
  });

  it("asks the create RPC for the list columns only, never the secret envelope", async () => {
    const { fake, run } = webhooksFake();

    await run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));

    const [call] = fake.requests.filter((request) => request.path === "/rest/v1/rpc/create_webhook_endpoint");
    expect(call.params.get("select")).toBe("id,url,created_at,disabled_at,consecutive_failures,last_success_at,last_failure_at");
    expect(call.params.get("select")).not.toContain("secret_enc");
  });

  it("picks a fresh id for every endpoint", async () => {
    const { run } = webhooksFake();

    const first = await run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));
    const second = await run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));

    expect(first.endpoint.id).not.toBe(second.endpoint.id);
  });

  it("enters the organization's scope for the ledger entry when called outside it", async () => {
    const { fake, run } = webhooksFake();

    await run(() => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT }));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "webhook_endpoint_created" });
  });

  it("still returns the secret when the ledger append fails, logging no secret", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = webhooksFake({ ledgerFails: true });

    const { secret } = await run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));

    expect(secret).toMatch(/^whsec_/);
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "webhook_endpoint_created", ORG);
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it.each([
    ["not a URL", "not a url", "not a valid URL"],
    ["http, not https", "http://hooks.example/in", "the URL must use https"],
    ["credentials in the URL", "https://user:pass@hooks.example/in", "the URL must not contain credentials"],
    ["a non-443 port", "https://hooks.example:8443/in", "the URL must use port 443"],
    ["a private IP literal", "https://10.0.0.5/in", "the URL's address is not public"],
    ["over 500 characters", `https://hooks.example/${"a".repeat(500)}`, "the URL must be at most 500 characters"],
  ])("refuses %s before calling the database, with the safe-url reason", async (_label, url, reason) => {
    const { fake, run } = webhooksFake();

    const attempt = run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url })));

    await expect(attempt).rejects.toBeInstanceOf(WebhookError);
    await expect(attempt).rejects.toMatchObject({ code: "invalid_url", message: reason });
    expect(rpcBodies(fake.requests, "create_webhook_endpoint")).toHaveLength(0);
  });

  it("maps webhook_limit_reached to its own error, with the fixed message, and records nothing", async () => {
    const { fake, run } = webhooksFake({
      createWebhookEndpoint: () => ({
        status: 400,
        body: { code: "P0001", message: "webhook_limit_reached: at most 5 active webhook endpoints per organization", details: null, hint: null },
      }),
    });

    const attempt = run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));
    await expect(attempt).rejects.toBeInstanceOf(WebhookError);
    await expect(attempt).rejects.toMatchObject({
      code: "webhook_limit_reached",
      message: "This workspace already has 5 webhook endpoints. Remove one first.",
    });
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("passes any other database error through as a plain error", async () => {
    const { run } = webhooksFake({
      createWebhookEndpoint: () => ({ status: 500, body: { code: "XX000", message: "connection lost", details: null, hint: null } }),
    });
    const attempt = run(() => withOrg(ORG, () => createWebhookEndpoint({ orgId: ORG, actorId: ACTOR, url: URL_TEXT })));
    await expect(attempt).rejects.toThrow("connection lost");
    await expect(attempt).rejects.not.toBeInstanceOf(WebhookError);
  });
});

describe("listWebhookEndpoints", () => {
  it("asks for the organization's non-removed endpoints, and maps them, host included", async () => {
    const { fake, run } = webhooksFake({
      webhookEndpoints: () => ({
        body: [{
          id: ENDPOINT_ID, url: URL_TEXT, created_at: "2026-09-29T00:00:00Z", disabled_at: null,
          consecutive_failures: 3, last_success_at: "2026-09-29T01:00:00Z", last_failure_at: "2026-09-29T02:00:00Z",
        }],
      }),
    });

    const rows = await run(() => listWebhookEndpoints(ORG));

    expect(rows).toEqual([{
      id: ENDPOINT_ID, host: "hooks.receiver.example", url: URL_TEXT, createdAt: "2026-09-29T00:00:00Z",
      disabledAt: null, consecutiveFailures: 3, lastSuccessAt: "2026-09-29T01:00:00Z", lastFailureAt: "2026-09-29T02:00:00Z",
    }]);
    const listing = fake.requests.find((request) => request.path === "/rest/v1/webhook_endpoints");
    expect(listing?.method).toBe("GET");
    expect(listing?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(listing?.params.get("removed_at")).toBe("is.null");
    expect(listing?.params.get("select")).not.toContain("secret_enc");
  });

  it("gives a fixed placeholder host for a stored URL that fails to parse, never the raw value", async () => {
    const malformed = "not a url, and definitely not one to leak";
    const { run } = webhooksFake({
      webhookEndpoints: () => ({
        body: [{
          id: ENDPOINT_ID, url: malformed, created_at: "2026-09-29T00:00:00Z", disabled_at: null,
          consecutive_failures: 0, last_success_at: null, last_failure_at: null,
        }],
      }),
    });

    const rows = await run(() => listWebhookEndpoints(ORG));

    expect(rows[0].host).toBe("invalid URL");
    expect(rows[0].host).not.toContain(malformed);
  });
});

describe("toWebhookEndpointViews", () => {
  const row: WebhookEndpointRow = {
    id: ENDPOINT_ID, host: "hooks.receiver.example", url: URL_TEXT, createdAt: "2026-09-29T00:00:00Z",
    disabledAt: null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
  };

  it("keeps the url for a manager", () => {
    const [view] = toWebhookEndpointViews([row], true);

    expect(view).toEqual(row);
    expect(view.url).toBe(URL_TEXT);
    expect(JSON.stringify([view])).toContain(URL_TEXT);
  });

  it("omits the url key entirely for a non-manager — not an empty string, not undefined-but-present", () => {
    const [view] = toWebhookEndpointViews([row], false);

    expect("url" in view).toBe(false);
    expect(Object.keys(view)).not.toContain("url");
    expect(view).toEqual({
      id: row.id, host: row.host, createdAt: row.createdAt, disabledAt: row.disabledAt,
      consecutiveFailures: row.consecutiveFailures, lastSuccessAt: row.lastSuccessAt, lastFailureAt: row.lastFailureAt,
    });
    // Serialized the way an RSC payload or a JSON response would carry it: the
    // full URL string never appears — the host alone (part of the URL's own
    // hostname) is exactly what a non-manager is meant to see.
    expect(JSON.stringify([view])).not.toContain(URL_TEXT);
    expect(JSON.stringify([view])).not.toContain("/vestiarion/in");
  });

  it("maps every row in the list the same way", () => {
    const other: WebhookEndpointRow = { ...row, id: OTHER_ENDPOINT_ID, url: "https://second.example/private-path", host: "second.example" };

    const views = toWebhookEndpointViews([row, other], false);

    expect(views).toHaveLength(2);
    for (const view of views) expect("url" in view).toBe(false);
    expect(JSON.stringify(views)).not.toContain("/private-path");
  });
});

describe("removeWebhookEndpoint", () => {
  it("sets removed_at, fails the endpoint's pending deliveries, and records ids only", async () => {
    const { fake, run } = webhooksFake({
      webhookEndpoints: (request) => (request.method === "PATCH" ? { body: [{ id: ENDPOINT_ID }] } : { body: [] }),
      webhookDeliveries: (request) => (request.method === "PATCH" ? { body: [{ id: "d1" }, { id: "d2" }] } : { body: [] }),
    });

    await run(() => withOrg(ORG, () => removeWebhookEndpoint({ orgId: ORG, actorId: ACTOR, endpointId: ENDPOINT_ID })));

    const endpointUpdate = fake.requests.find((request) => request.path === "/rest/v1/webhook_endpoints" && request.method === "PATCH");
    expect(endpointUpdate?.params.get("id")).toBe(`eq.${ENDPOINT_ID}`);
    expect(endpointUpdate?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(endpointUpdate?.params.get("removed_at")).toBe("is.null");
    expect(Object.keys(endpointUpdate?.body as object)).toEqual(["removed_at"]);

    const deliveryUpdate = fake.requests.find((request) => request.path === "/rest/v1/webhook_deliveries" && request.method === "PATCH");
    expect(deliveryUpdate?.params.get("endpoint_id")).toBe(`eq.${ENDPOINT_ID}`);
    expect(deliveryUpdate?.params.get("status")).toBe("eq.pending");
    expect(deliveryUpdate?.body).toEqual({ status: "failed", last_error: "endpoint removed" });

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "webhook_endpoint_removed" });
    expect(appends[0].p_detail).toEqual({ by: ACTOR, endpointId: ENDPOINT_ID });
    expect(JSON.stringify(appends)).not.toContain(URL_TEXT);
  });

  it("raises not_found when no endpoint row changes, and fails no deliveries or ledger entry", async () => {
    const { fake, run } = webhooksFake({ webhookEndpoints: () => ({ body: [] }) });

    const attempt = run(() => withOrg(ORG, () => removeWebhookEndpoint({ orgId: ORG, actorId: ACTOR, endpointId: ENDPOINT_ID })));
    await expect(attempt).rejects.toBeInstanceOf(WebhookError);
    await expect(attempt).rejects.toMatchObject({ code: "not_found" });
    expect(fake.requests.filter((request) => request.path === "/rest/v1/webhook_deliveries")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("raises not_found for an id that is not a uuid, without asking the database", async () => {
    const { fake, run } = webhooksFake();
    await expect(run(() => withOrg(ORG, () => removeWebhookEndpoint({ orgId: ORG, actorId: ACTOR, endpointId: "nope" }))))
      .rejects.toMatchObject({ code: "not_found" });
    expect(fake.requests.filter((request) => request.path === "/rest/v1/webhook_endpoints")).toHaveLength(0);
  });

  it("does not remove another organization's endpoint", async () => {
    const { fake, run } = webhooksFake({ webhookEndpoints: () => ({ body: [] }) });

    const attempt = run(() => withOrg(ORG, () => removeWebhookEndpoint({ orgId: ORG, actorId: ACTOR, endpointId: OTHER_ENDPOINT_ID })));
    await expect(attempt).rejects.toMatchObject({ code: "not_found" });
    const endpointUpdate = fake.requests.find((request) => request.path === "/rest/v1/webhook_endpoints" && request.method === "PATCH");
    expect(endpointUpdate?.params.get("org_id")).toBe(`eq.${ORG}`);
  });
});
