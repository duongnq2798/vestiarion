import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAsanaWebhook, verifyAsanaSignature } from "@/lib/asana/webhook";
import type { StoredWebhook, WebhookStore } from "@/lib/asana/webhook-store";

/**
 * Asana's webhook (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11, A12): the X-Hook-Secret handshake
 * is taken once, for a row waiting for it, within two minutes, and echoed back; every delivery after it must carry the
 * hex HMAC-SHA256 of its raw body under that secret, compared in constant time; a signed delivery only nudges a read of
 * the task through Asana's API, after the answer; nothing in the body is believed; a deleted or unknown webhook answers
 * 410, which tells Asana to delete it.
 */

const ID = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a1";
const NOW = Date.parse("2026-10-14T09:00:00Z");
const SECRET = "2b9f0c7e5d4a3b2c1d0e9f8a7b6c5d4e";

function store(initial: Partial<StoredWebhook> | null) {
  let row: StoredWebhook | null = initial
    ? { id: ID, orgId: "org-1", connectionId: "conn-1", linkId: "link-1", resourceGid: "1219477646404728", webhookGid: null, state: "pending", secret: null, createdAt: new Date(NOW - 5_000).toISOString(), ...initial }
    : null;
  const touched: string[] = [];
  const impl: WebhookStore = {
    find: async (id) => (row && row.id === id ? { ...row } : null),
    saveSecret: async (webhook, secret) => {
      if (!row || row.id !== webhook.id || row.state !== "pending" || row.secret !== null) return false;
      row = { ...row, secret };
      return true;
    },
    touch: async (id) => {
      touched.push(id);
    },
  };
  return { impl, row: () => row, touched };
}

const sign = (body: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
const post = (body: string, headers: Record<string, string> = {}) => new Request(`https://www.vestiarion.xyz/api/integrations/asana/webhook/${ID}`, { method: "POST", body, headers });
const EVENT = JSON.stringify({ events: [{ action: "changed", resource: { gid: "1219477646404728", resource_type: "task" }, change: { field: "completed", new_value: true } }] });

function deps(webhooks: ReturnType<typeof store>) {
  const deferred: Array<() => Promise<void>> = [];
  const reread = vi.fn(async () => undefined);
  return { deps: { store: webhooks.impl, defer: (work: () => Promise<void>) => void deferred.push(work), reread, now: () => NOW }, deferred, reread };
}

describe("the handshake", () => {
  it("keeps the secret once, for a row waiting for it, and echoes it back", async () => {
    const webhooks = store({});
    const { deps: d } = deps(webhooks);
    const answer = await handleAsanaWebhook(post("", { "x-hook-secret": SECRET }), ID, d);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-hook-secret")).toBe(SECRET);
    expect(webhooks.row()?.secret).toBe(SECRET);
    // A second handshake for the same row is someone else's: refused, and the secret kept stays.
    const again = await handleAsanaWebhook(post("", { "x-hook-secret": "another-secret-value" }), ID, d);
    expect(again.status).toBe(403);
    expect(again.headers.get("x-hook-secret")).toBeNull();
    expect(webhooks.row()?.secret).toBe(SECRET);
  });

  it("is refused after two minutes, for a row already active, and for a secret that is not one", async () => {
    for (const fields of [{ createdAt: new Date(NOW - 3 * 60_000).toISOString() }, { state: "active" as const, secret: SECRET }]) {
      const webhooks = store(fields);
      const answer = await handleAsanaWebhook(post("", { "x-hook-secret": "fresh-secret-value" }), ID, deps(webhooks).deps);
      expect(answer.status).toBe(403);
    }
    const webhooks = store({});
    expect((await handleAsanaWebhook(post("", { "x-hook-secret": "short" }), ID, deps(webhooks).deps)).status).toBe(403);
    expect(webhooks.row()?.secret).toBeNull();
  });
});

describe("a delivery", () => {
  it("signed with the secret is answered at once, and only reads the task again after the answer", async () => {
    const webhooks = store({ state: "active", secret: SECRET, webhookGid: "8800001" });
    const { deps: d, deferred, reread } = deps(webhooks);
    const answer = await handleAsanaWebhook(post(EVENT, { "x-hook-signature": sign(EVENT) }), ID, d);
    expect(answer.status).toBe(200);
    expect(reread).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    // The read is told which webhook, never what the body claimed: the task is read through Asana's API.
    expect(reread).toHaveBeenCalledWith(expect.objectContaining({ id: ID, linkId: "link-1" }));
    expect(reread.mock.calls[0]).toHaveLength(1);
    expect(webhooks.touched).toEqual([ID]);
  });

  it("is refused without the signature, with another body, or signed with another secret", async () => {
    const webhooks = store({ state: "active", secret: SECRET });
    const { deps: d, deferred } = deps(webhooks);
    expect((await handleAsanaWebhook(post(EVENT), ID, d)).status).toBe(401);
    expect((await handleAsanaWebhook(post(EVENT.replace("true", "false"), { "x-hook-signature": sign(EVENT) }), ID, d)).status).toBe(401);
    expect((await handleAsanaWebhook(post(EVENT, { "x-hook-signature": sign(EVENT, "another-secret") }), ID, d)).status).toBe(401);
    expect((await handleAsanaWebhook(post(EVENT, { "x-hook-signature": "not-hex" }), ID, d)).status).toBe(401);
    expect(deferred).toHaveLength(0);
  });

  it("is refused before any handshake: there is no secret to check it with", async () => {
    const webhooks = store({});
    expect((await handleAsanaWebhook(post(EVENT, { "x-hook-signature": sign(EVENT) }), ID, deps(webhooks).deps)).status).toBe(401);
  });

  it("reads nothing for a heartbeat", async () => {
    const webhooks = store({ state: "active", secret: SECRET });
    const heartbeat = JSON.stringify({ events: [] });
    const { deps: d, deferred } = deps(webhooks);
    expect((await handleAsanaWebhook(post(heartbeat, { "x-hook-signature": sign(heartbeat) }), ID, d)).status).toBe(200);
    expect(deferred).toHaveLength(0);
  });

  it("answers 410 for a webhook deleted or unknown, so Asana deletes it, and 404 for an address that is not one", async () => {
    expect((await handleAsanaWebhook(post(EVENT, { "x-hook-signature": sign(EVENT) }), ID, deps(store({ state: "deleted", secret: SECRET })).deps)).status).toBe(410);
    expect((await handleAsanaWebhook(post(EVENT), ID, deps(store(null)).deps)).status).toBe(410);
    expect((await handleAsanaWebhook(post(EVENT), "../../etc", deps(store({})).deps)).status).toBe(404);
  });

  it("refuses a body larger than 1 MB before reading the store", async () => {
    const webhooks = store({ state: "active", secret: SECRET });
    const find = vi.spyOn(webhooks.impl, "find");
    const big = "x".repeat(1_000_001);
    expect((await handleAsanaWebhook(post(big, { "x-hook-signature": sign(big) }), ID, deps(webhooks).deps)).status).toBe(413);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("the signature", () => {
  it("is the hex HMAC-SHA256 of the raw body, compared in constant time", () => {
    const timing = vi.spyOn(crypto, "timingSafeEqual");
    expect(verifyAsanaSignature(SECRET, EVENT, sign(EVENT))).toBe(true);
    expect(verifyAsanaSignature(SECRET, EVENT, sign(EVENT).toUpperCase())).toBe(true);
    expect(verifyAsanaSignature(SECRET, `${EVENT} `, sign(EVENT))).toBe(false);
    expect(verifyAsanaSignature(SECRET, EVENT, null)).toBe(false);
    expect(verifyAsanaSignature(SECRET, EVENT, sign(EVENT).slice(0, 63))).toBe(false);
    expect(timing).toHaveBeenCalled();
  });
});
