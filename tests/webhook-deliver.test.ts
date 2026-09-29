import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { encryptSecret, type MasterKey, type SecretEnvelope } from "@/lib/secrets";
import {
  deliverPendingWebhooks, sendTestEvent, WEBHOOK_BACKOFF_MS, WEBHOOK_DISABLE_AFTER, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS,
} from "@/lib/webhooks/deliver";
import { WebhookSendError, type WebhookRequest, type WebhookSender } from "@/lib/webhooks/http";
import type { LookupFn } from "@/lib/webhooks/safe-url";
import { verifyWebhookSignature } from "@/lib/webhooks/sign";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The dispatcher (webhooks design W3–W7, §5, §6; rulings R4–R6) against a
 * real supabase-js client whose network is a small in-memory PostgREST: the
 * claim and failure RPCs, the fenced updates and the embedded read behave as
 * the database would, so each test asserts on the rows a run leaves behind.
 * The sender and the DNS lookup are fakes; the real sender has its own test
 * (tests/webhook-http.test.ts).
 */

const ORG = "0b8f6c1e-2d3a-4e5f-8a9b-00000000a001";
const ENDPOINT = "0b8f6c1e-2d3a-4e5f-8a9b-00000000e001";
const ENTRY = "0b8f6c1e-2d3a-4e5f-8a9b-00000000f001";
const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64url");
const URL_TEXT = "https://hooks.receiver.example/vestiarion/in";
const START = Date.parse("2026-09-29T10:00:00.000Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER: MasterKey = { id: "k1", key: Buffer.alloc(32, 3) };
const previousKeys = process.env.VESTIARION_MASTER_KEYS;

interface EndpointRow {
  id: string; org_id: string; url: string; secret_enc: SecretEnvelope;
  removed_at: string | null; disabled_at: string | null;
  consecutive_failures: number; last_success_at: string | null; last_failure_at: string | null;
}

interface DeliveryRow {
  id: string; org_id: string; endpoint_id: string; ledger_entry_id: string | null;
  event_type: "ledger.appended" | "webhook.test"; status: "pending" | "sending" | "delivered" | "failed";
  attempts: number; next_attempt_at: string; claimed_at: string | null;
  last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null;
}

const LEDGER_ROW = {
  id: ENTRY, seq: 257, ts: "2026-09-29T09:59:58.123456+00:00", actor: "agent", domain: "ap", action: "ap_hold",
  summary: "Held invoice INV-7 for review", detail: { invoiceId: "inv-7", amount: "1200.00" },
  body_hash: "ab".repeat(32), prev_hash: "cd".repeat(32), hash: "ef".repeat(32), signature: "12".repeat(64),
  signing_key_id: "key-2026",
};

/** The clock both the dispatcher and the fake database read. */
const clock = { t: START };
const iso = (ms: number) => new Date(ms).toISOString();

let endpoints: Map<string, EndpointRow>;
let deliveries: Map<string, DeliveryRow>;
let claimCounter: number;
/** Makes the named request fail once, the way PostgREST reports an error. */
let breakNext: ((request: RecordedRequest) => boolean) | null;

function endpoint(overrides: Partial<EndpointRow> = {}): EndpointRow {
  const id = overrides.id ?? ENDPOINT;
  const row: EndpointRow = {
    id, org_id: ORG, url: URL_TEXT,
    secret_enc: encryptSecret(SECRET, { orgId: ORG, column: `webhook_secret:${id}` }, [MASTER]),
    removed_at: null, disabled_at: null, consecutive_failures: 0, last_success_at: null, last_failure_at: null,
    ...overrides,
  };
  endpoints.set(row.id, row);
  return row;
}

function delivery(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  const row: DeliveryRow = {
    id: crypto.randomUUID(), org_id: ORG, endpoint_id: ENDPOINT, ledger_entry_id: ENTRY, event_type: "ledger.appended",
    status: "pending", attempts: 0, next_attempt_at: iso(clock.t - 60_000 + deliveries.size), claimed_at: null,
    last_status: null, last_error: null, created_at: iso(clock.t - 120_000 + deliveries.size), delivered_at: null,
    ...overrides,
  };
  deliveries.set(row.id, row);
  return row;
}

function eqFilter(request: RecordedRequest, column: string): string | null {
  const value = request.params.get(column);
  return value?.startsWith("eq.") ? value.slice(3) : null;
}

/** An answer shaped for `.single()`/`.maybeSingle()` (object) or a plain list, as PostgREST would. */
function rows(request: RecordedRequest, list: unknown[]): FakeReply {
  if (request.headers.get("accept") === "application/vnd.pgrst.object+json") {
    return list.length === 1 ? { body: list[0] } : { status: 406, body: { code: "PGRST116", message: "no rows" } };
  }
  return { body: list };
}

function database(request: RecordedRequest): FakeReply {
  if (breakNext?.(request)) {
    breakNext = null;
    return { status: 500, body: { message: "database unavailable" } };
  }
  const body = request.body as Record<string, unknown> | undefined;

  if (request.path === "/rest/v1/rpc/claim_webhook_deliveries") {
    const limit = Number(body?.p_limit ?? 0);
    const only = (body?.p_only as string | undefined) ?? null;
    const due = [...deliveries.values()]
      .filter((d) => only === null || d.id === only)
      .filter((d) =>
        (d.status === "pending" && Date.parse(d.next_attempt_at) <= clock.t)
        || (d.status === "sending" && (d.claimed_at === null || Date.parse(d.claimed_at) < clock.t - 300_000)))
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || a.created_at.localeCompare(b.created_at))
      .slice(0, Math.max(limit, 0));
    for (const d of due) {
      if (d.status === "sending") d.attempts += 1;
      d.status = "sending";
      claimCounter += 1;
      // Microseconds, as Postgres returns them, and a "+" the fence must carry intact.
      d.claimed_at = iso(clock.t).replace("Z", `${String(claimCounter).padStart(3, "0")}+00:00`);
    }
    return { body: due.map((d) => ({ ...d })) };
  }

  if (request.path === "/rest/v1/rpc/record_webhook_failure") {
    const e = endpoints.get(String(body?.p_endpoint_id));
    if (!e) return { body: null };
    e.consecutive_failures += 1;
    e.last_failure_at = iso(clock.t);
    if (e.consecutive_failures >= Number(body?.p_disable_after)) {
      e.disabled_at ??= iso(clock.t);
      for (const d of deliveries.values()) {
        if (d.endpoint_id === e.id && d.status === "pending") {
          d.status = "failed";
          d.last_error = "endpoint disabled";
        }
      }
    }
    return { body: e.consecutive_failures };
  }

  if (request.path === "/rest/v1/webhook_deliveries") {
    if (request.method === "GET") {
      const d = deliveries.get(eqFilter(request, "id") ?? "");
      if (!d) return rows(request, []);
      const e = endpoints.get(d.endpoint_id);
      return rows(request, [{
        id: d.id,
        endpoint: e ? { id: e.id, org_id: e.org_id, url: e.url, secret_enc: e.secret_enc, removed_at: e.removed_at, disabled_at: e.disabled_at } : null,
        org: { slug: "acme" },
        entry: d.ledger_entry_id === ENTRY ? { ...LEDGER_ROW } : null,
      }]);
    }
    if (request.method === "POST") {
      const input = body as Partial<DeliveryRow>;
      const row = delivery({ ...input, ledger_entry_id: input.ledger_entry_id ?? null, next_attempt_at: iso(clock.t), created_at: iso(clock.t) });
      return rows(request, [{ id: row.id }]);
    }
    if (request.method === "PATCH") {
      const matched = [...deliveries.values()].filter((d) =>
        d.id === eqFilter(request, "id")
        && d.status === eqFilter(request, "status")
        && d.claimed_at === eqFilter(request, "claimed_at"));
      for (const d of matched) Object.assign(d, body);
      return rows(request, matched.map((d) => ({ id: d.id })));
    }
  }

  if (request.path === "/rest/v1/webhook_endpoints") {
    if (request.method === "GET") {
      const e = endpoints.get(eqFilter(request, "id") ?? "");
      const list = e && e.org_id === eqFilter(request, "org_id") ? [{ id: e.id, removed_at: e.removed_at, disabled_at: e.disabled_at }] : [];
      return rows(request, list);
    }
    if (request.method === "PATCH") {
      const e = endpoints.get(eqFilter(request, "id") ?? "");
      if (e && (request.params.get("disabled_at") !== "is.null" || e.disabled_at === null)) Object.assign(e, body);
      return { body: [] };
    }
  }

  return { status: 404, body: { message: `unexpected ${request.method} ${request.path}` } };
}

let fake: ReturnType<typeof fakeSupabase>;
let sent: WebhookRequest[];

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const answering = (status: number): WebhookSender => async (request) => {
  sent.push(request);
  return { status };
};
const throwing = (error: Error): WebhookSender => async (request) => {
  sent.push(request);
  throw error;
};

function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const dispatch = (send: WebhookSender, options: { limit?: number; deadlineMs?: number; lookup?: LookupFn } = {}) =>
  run(() => deliverPendingWebhooks({ send, lookup: publicLookup, now: () => new Date(clock.t), ...options }));

beforeEach(() => {
  clock.t = START;
  endpoints = new Map();
  deliveries = new Map();
  claimCounter = 0;
  breakNext = null;
  sent = [];
  fake = fakeSupabase(database);
  process.env.VESTIARION_MASTER_KEYS = `${MASTER.id}:${MASTER.key.toString("base64")}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (previousKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = previousKeys;
  vi.restoreAllMocks();
});

describe("the request", () => {
  it("carries the W4 headers, the §5 payload, and a signature over exactly the bytes sent", async () => {
    endpoint();
    const d = delivery();

    expect(await dispatch(answering(200))).toEqual({ delivered: 1, failed: 0, retried: 0 });

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request.url.href).toBe(URL_TEXT);
    expect(request.timeoutMs).toBe(WEBHOOK_TIMEOUT_MS);
    expect(Object.keys(request.headers).sort()).toEqual([
      "Content-Type", "User-Agent", "Vestiarion-Event-Id", "Vestiarion-Event-Type", "Vestiarion-Signature",
    ]);
    const t = Math.floor(START / 1000);
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": "Vestiarion-Webhooks/1",
      "Vestiarion-Event-Id": d.id,
      "Vestiarion-Event-Type": "ledger.appended",
    });
    expect(request.headers["Vestiarion-Signature"]).toMatch(new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
    expect(verifyWebhookSignature(SECRET, request.body, request.headers["Vestiarion-Signature"], t)).toBe(true);
    expect(verifyWebhookSignature(SECRET, request.body + " ", request.headers["Vestiarion-Signature"], t)).toBe(false);

    expect(request.body).toBe(JSON.stringify({
      id: d.id,
      type: "ledger.appended",
      createdAt: LEDGER_ROW.ts,
      workspace: { slug: "acme" },
      entry: {
        seq: 257, ts: LEDGER_ROW.ts, actor: "agent", domain: "ap", action: "ap_hold",
        summary: LEDGER_ROW.summary, detail: LEDGER_ROW.detail,
        bodyHash: LEDGER_ROW.body_hash, prevHash: LEDGER_ROW.prev_hash, hash: LEDGER_ROW.hash,
        signature: LEDGER_ROW.signature, signingKeyId: "key-2026",
      },
    }));
  });

  it("sends a test event with no entry, created at the delivery's own time", async () => {
    endpoint();
    const d = delivery({ event_type: "webhook.test", ledger_entry_id: null });

    await dispatch(answering(204));

    expect(JSON.parse(sent[0].body)).toEqual({ id: d.id, type: "webhook.test", createdAt: d.created_at, workspace: { slug: "acme" } });
    expect(sent[0].headers["Vestiarion-Event-Type"]).toBe("webhook.test");
  });
});

describe("outcomes", () => {
  it("records a 2xx as delivered and resets the endpoint's failure count", async () => {
    endpoint({ consecutive_failures: 4 });
    const d = delivery({ attempts: 1 });

    await dispatch(answering(202));

    expect(deliveries.get(d.id)).toMatchObject({
      status: "delivered", attempts: 2, last_status: 202, last_error: null, delivered_at: iso(START),
    });
    expect(endpoints.get(ENDPOINT)).toMatchObject({ consecutive_failures: 0, last_success_at: iso(START) });
  });

  const failures: [string, WebhookSender, number | null, string][] = [
    ["a 500", answering(500), 500, "HTTP 500"],
    ["a 404", answering(404), 404, "HTTP 404"],
    ["a 302, which is not followed", answering(302), 302, "redirect not followed (HTTP 302)"],
    ["a timeout", throwing(new WebhookSendError("timed out")), null, "timed out"],
  ];

  describe.each(failures)("%s", (_label, send, status, reason) => {
    it.each(WEBHOOK_BACKOFF_MS.map((backoff, prior) => [prior, backoff]))(
      "after %i earlier attempts goes back to pending %i ms later, and counts against the endpoint",
      async (prior, backoff) => {
        endpoint({ consecutive_failures: 2 });
        const d = delivery({ attempts: prior });

        expect(await dispatch(send)).toEqual({ delivered: 0, failed: 0, retried: 1 });

        expect(deliveries.get(d.id)).toMatchObject({
          status: "pending", attempts: prior + 1, next_attempt_at: iso(START + backoff), claimed_at: null,
          last_status: status, last_error: reason, delivered_at: null,
        });
        expect(endpoints.get(ENDPOINT)).toMatchObject({ consecutive_failures: 3, last_failure_at: iso(START), disabled_at: null });
      }
    );
  });

  it(`fails a delivery for good on its ${WEBHOOK_MAX_ATTEMPTS}th attempt`, async () => {
    endpoint();
    const d = delivery({ attempts: WEBHOOK_MAX_ATTEMPTS - 1 });

    expect(await dispatch(answering(503))).toEqual({ delivered: 0, failed: 1, retried: 0 });

    expect(deliveries.get(d.id)).toMatchObject({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS, last_status: 503, last_error: "HTTP 503" });
  });

  it(`disables the endpoint on its ${WEBHOOK_DISABLE_AFTER}th consecutive failure and fails its pending deliveries`, async () => {
    endpoint({ consecutive_failures: WEBHOOK_DISABLE_AFTER - 1 });
    const d = delivery();
    const waiting = delivery({ next_attempt_at: iso(START + 3_600_000) });

    expect(await dispatch(answering(500))).toEqual({ delivered: 0, failed: 1, retried: 0 });

    expect(endpoints.get(ENDPOINT)).toMatchObject({ consecutive_failures: WEBHOOK_DISABLE_AFTER, disabled_at: iso(START) });
    expect(deliveries.get(d.id)?.status).toBe("failed");
    expect(deliveries.get(waiting.id)).toMatchObject({ status: "failed", last_error: "endpoint disabled" });
    expect(console.warn).toHaveBeenCalledWith("webhook endpoint disabled after repeated failures", ENDPOINT);
  });
});

describe("refusals before sending", () => {
  it("never sends to a destination that resolves to a private address, and counts the attempt", async () => {
    endpoint();
    const d = delivery();
    const send = vi.fn(answering(200));

    expect(await dispatch(send, { lookup: async () => [{ address: "10.0.0.8", family: 4 }] }))
      .toEqual({ delivered: 0, failed: 0, retried: 1 });

    expect(send).not.toHaveBeenCalled();
    expect(deliveries.get(d.id)).toMatchObject({ status: "pending", attempts: 1, last_status: null, last_error: "destination is not public" });
    expect(endpoints.get(ENDPOINT)?.consecutive_failures).toBe(1);
  });

  it("fails the attempt with \"secret unavailable\" when the secret cannot be decrypted, logging the endpoint id", async () => {
    endpoint({ secret_enc: encryptSecret(SECRET, { orgId: ORG, column: "webhook_secret:someone-else" }, [MASTER]) });
    const d = delivery();
    const send = vi.fn(answering(200));

    expect(await dispatch(send)).toEqual({ delivered: 0, failed: 0, retried: 1 });

    expect(send).not.toHaveBeenCalled();
    expect(deliveries.get(d.id)).toMatchObject({ status: "pending", attempts: 1, last_error: "secret unavailable" });
    expect(console.error).toHaveBeenCalledWith("webhook secret unavailable", ENDPOINT, d.id);
  });

  it("fails the attempt when no master key is configured", async () => {
    delete process.env.VESTIARION_MASTER_KEYS;
    endpoint();
    const d = delivery();

    await dispatch(answering(200));

    expect(sent).toEqual([]);
    expect(deliveries.get(d.id)).toMatchObject({ status: "pending", last_error: "secret unavailable" });
  });

  it.each([
    ["removed", { removed_at: iso(START - 1_000) }, "endpoint removed"],
    ["disabled", { disabled_at: iso(START - 1_000) }, "endpoint disabled"],
  ])("fails a delivery whose endpoint was %s after it was claimed, without sending or counting (R5)", async (_label, state, reason) => {
    endpoint({ ...state, consecutive_failures: 5 });
    const d = delivery({ attempts: 1 });

    expect(await dispatch(answering(200))).toEqual({ delivered: 0, failed: 1, retried: 0 });

    expect(sent).toEqual([]);
    expect(deliveries.get(d.id)).toMatchObject({ status: "failed", attempts: 1, last_error: reason });
    expect(endpoints.get(ENDPOINT)?.consecutive_failures).toBe(5);
  });

  it("fails a delivery that has already used every attempt, without sending (a run that kept dying on it)", async () => {
    endpoint();
    const d = delivery({ status: "sending", claimed_at: iso(START - 600_000), attempts: WEBHOOK_MAX_ATTEMPTS - 1 });

    expect(await dispatch(answering(200))).toEqual({ delivered: 0, failed: 1, retried: 0 });

    expect(sent).toEqual([]);
    expect(deliveries.get(d.id)).toMatchObject({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS, last_error: "too many attempts" });
  });
});

describe("claims and fences (R6)", () => {
  it("records nothing when its claim was taken over while it was sending", async () => {
    endpoint();
    const d = delivery();
    const send: WebhookSender = async (request) => {
      sent.push(request);
      // Another run found the claim stale and took the row over.
      const row = deliveries.get(d.id)!;
      row.claimed_at = "2026-09-29T10:06:00.000999+00:00";
      return { status: 500 };
    };

    expect(await dispatch(send)).toEqual({ delivered: 0, failed: 0, retried: 0 });

    expect(deliveries.get(d.id)).toMatchObject({ status: "sending", attempts: 0, last_error: null });
    expect(endpoints.get(ENDPOINT)?.consecutive_failures).toBe(0);
    const writes = fake.requests.filter((r) => r.path === "/rest/v1/webhook_deliveries" && r.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].params.get("status")).toBe("eq.sending");
    expect(writes[0].params.get("claimed_at")).toMatch(/^eq\.2026-09-29T10:00:00\.000\d{3}\+00:00$/);
  });

  it("claims in small batches and never more than the limit", async () => {
    endpoint();
    for (let i = 0; i < 25; i++) delivery();

    expect(await dispatch(answering(200), { limit: 23 })).toEqual({ delivered: 23, failed: 0, retried: 0 });

    const claims = fake.requests.filter((r) => r.path === "/rest/v1/rpc/claim_webhook_deliveries");
    expect(claims.map((r) => (r.body as { p_limit: number }).p_limit)).toEqual([10, 10, 3]);
    expect([...deliveries.values()].filter((d) => d.status === "pending")).toHaveLength(2);
  });

  it("sends at most 50 by default", async () => {
    endpoint();
    for (let i = 0; i < 55; i++) delivery();

    expect((await dispatch(answering(200))).delivered).toBe(50);
  });
});

describe("the deadline", () => {
  it("stops sending once the deadline passes and hands unsent claims back with their attempt count", async () => {
    endpoint();
    const first = delivery({ attempts: 1 });
    const second = delivery({ attempts: 2 });
    const third = delivery({ attempts: 3 });
    const slow: WebhookSender = async (request) => {
      sent.push(request);
      clock.t += 40_000;
      return { status: 200 };
    };

    expect(await dispatch(slow, { deadlineMs: 60_000 })).toEqual({ delivered: 2, failed: 0, retried: 0 });

    expect(sent.map((r) => r.headers["Vestiarion-Event-Id"])).toEqual([first.id, second.id]);
    expect(deliveries.get(third.id)).toMatchObject({ status: "pending", attempts: 3, claimed_at: null, last_error: null });
    expect(fake.requests.filter((r) => r.path === "/rest/v1/rpc/claim_webhook_deliveries")).toHaveLength(1);
  });

  it("claims nothing when the deadline has already passed", async () => {
    endpoint();
    delivery();

    expect(await dispatch(answering(200), { deadlineMs: 0 })).toEqual({ delivered: 0, failed: 0, retried: 0 });
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/claim_webhook_deliveries")).toBe(false);
  });
});

describe("never throws", () => {
  it("returns zero counts when the claim fails", async () => {
    endpoint();
    delivery();
    breakNext = (r) => r.path === "/rest/v1/rpc/claim_webhook_deliveries";

    expect(await dispatch(answering(200))).toEqual({ delivered: 0, failed: 0, retried: 0 });
    expect(console.error).toHaveBeenCalledWith("could not claim webhook deliveries", "database unavailable");
  });

  it("hands a delivery back when it cannot be read, and carries on with the next", async () => {
    endpoint();
    const unreadable = delivery();
    const fine = delivery();
    breakNext = (r) => r.path === "/rest/v1/webhook_deliveries" && r.method === "GET" && r.params.get("id") === `eq.${unreadable.id}`;

    expect(await dispatch(answering(200))).toEqual({ delivered: 1, failed: 0, retried: 0 });

    expect(deliveries.get(unreadable.id)).toMatchObject({ status: "pending", attempts: 0, claimed_at: null });
    expect(Date.parse(deliveries.get(unreadable.id)!.next_attempt_at)).toBeGreaterThan(START);
    expect(deliveries.get(fine.id)?.status).toBe("delivered");
  });

  it("survives a sender that throws something unexpected", async () => {
    endpoint();
    const d = delivery();

    expect(await dispatch(throwing(new TypeError(`boom ${SECRET}`)))).toEqual({ delivered: 0, failed: 0, retried: 1 });
    expect(deliveries.get(d.id)).toMatchObject({ status: "pending", last_error: "request failed" });
  });

  it("survives a result write that fails", async () => {
    endpoint();
    delivery();
    breakNext = (r) => r.path === "/rest/v1/webhook_deliveries" && r.method === "PATCH";

    await expect(dispatch(answering(200))).resolves.toEqual({ delivered: 0, failed: 0, retried: 0 });
  });

  it("survives a database client that throws", async () => {
    const broken = runWith({ config, db: {} as never }, () =>
      deliverPendingWebhooks({ send: answering(200), lookup: publicLookup, now: () => new Date(clock.t) }));

    await expect(broken).resolves.toEqual({ delivered: 0, failed: 0, retried: 0 });
    expect(console.error).toHaveBeenCalledWith("webhook dispatch failed");
  });
});

describe("logs", () => {
  it("carry ids only: never the secret, the URL or anything the receiver said", async () => {
    endpoint();
    const other = endpoint({ id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000e002", consecutive_failures: WEBHOOK_DISABLE_AFTER - 1 });
    delivery();
    delivery({ endpoint_id: other.id });
    const third = endpoint({ id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000e003", secret_enc: { k: "k1", iv: "AAAA", tag: "AAAA", ct: "AAAA" } });
    delivery({ endpoint_id: third.id });
    const send: WebhookSender = async (request) => {
      sent.push(request);
      return { status: sent.length === 1 ? 200 : 500 };
    };

    await dispatch(send);
    await run(() => sendTestEvent({ orgId: ORG, endpointId: ENDPOINT }));

    const logged = JSON.stringify([
      vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET.slice(6, 20));
    expect(logged).not.toContain("hooks.receiver.example");
    expect(logged).not.toContain("vestiarion/in");
    expect(logged).toContain(other.id);
  });
});

describe("sendTestEvent", () => {
  const test = (endpointId = ENDPOINT, send: WebhookSender = answering(200)) =>
    run(() => sendTestEvent({ orgId: ORG, endpointId }, { send, lookup: publicLookup, now: () => new Date(clock.t) }));

  it("inserts a pending webhook.test delivery, claims exactly that row, and sends it", async () => {
    endpoint();
    const queued = delivery({ next_attempt_at: iso(START - 3_600_000) });

    expect(await test()).toEqual({ ok: true, status: 200, error: null });

    const insert = fake.requests.find((r) => r.path === "/rest/v1/webhook_deliveries" && r.method === "POST");
    expect(insert?.body).toEqual({ org_id: ORG, endpoint_id: ENDPOINT, event_type: "webhook.test" });
    const claim = fake.requests.find((r) => r.path === "/rest/v1/rpc/claim_webhook_deliveries");
    const testRow = [...deliveries.values()].find((d) => d.event_type === "webhook.test")!;
    expect(claim?.body).toEqual({ p_limit: 1, p_only: testRow.id });
    expect(testRow).toMatchObject({ status: "delivered", attempts: 1, last_status: 200 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ id: testRow.id, type: "webhook.test" });
    // The older queued delivery was not swept up by the test.
    expect(deliveries.get(queued.id)?.status).toBe("pending");
  });

  it("reports a failed test with its status and reason, retried like any delivery", async () => {
    endpoint();

    expect(await test(ENDPOINT, answering(500))).toEqual({ ok: false, status: 500, error: "HTTP 500" });
    expect([...deliveries.values()][0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("reports a refused destination without a status", async () => {
    endpoint();

    expect(await run(() => sendTestEvent(
      { orgId: ORG, endpointId: ENDPOINT },
      { send: answering(200), lookup: async () => [{ address: "127.0.0.1", family: 4 }], now: () => new Date(clock.t) }
    ))).toEqual({ ok: false, status: null, error: "destination is not public" });
  });

  it("refuses an endpoint of another organization, a removed one and a disabled one, inserting nothing", async () => {
    endpoint();
    endpoint({ id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000e009", org_id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000a999" });
    endpoint({ id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000e00a", removed_at: iso(START) });
    endpoint({ id: "0b8f6c1e-2d3a-4e5f-8a9b-00000000e00b", disabled_at: iso(START) });

    expect(await test("0b8f6c1e-2d3a-4e5f-8a9b-00000000e009")).toEqual({ ok: false, status: null, error: "endpoint not found" });
    expect(await test("0b8f6c1e-2d3a-4e5f-8a9b-00000000e00a")).toEqual({ ok: false, status: null, error: "endpoint not found" });
    expect(await test("0b8f6c1e-2d3a-4e5f-8a9b-00000000e00b")).toEqual({ ok: false, status: null, error: "endpoint is disabled" });
    expect(deliveries.size).toBe(0);
  });

  it("says so when another run claimed the test first", async () => {
    endpoint();
    breakNext = null;
    const original = database;
    fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/claim_webhook_deliveries") return { body: [] };
      return original(request);
    });

    expect(await test()).toEqual({ ok: false, status: null, error: "queued for the next dispatch" });
  });

  it("never throws", async () => {
    endpoint();
    breakNext = (r) => r.path === "/rest/v1/webhook_deliveries" && r.method === "POST";

    expect(await test()).toEqual({ ok: false, status: null, error: "could not send the test event" });
  });
});
