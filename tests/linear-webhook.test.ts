import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deliveryOf, handleLinearWebhook, MAX_BODY_BYTES, verifyLinearSignature, type LinearWebhookDeps } from "@/lib/linear/webhook";

/**
 * Linear's app webhook (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN11): a delivery is checked first,
 * Linear-Signature as the hex HMAC-SHA256 of the raw body under the signing secret, compared in constant time, then its
 * webhookTimestamp within 60 seconds; either failing answers 401 and reads nothing. A signed delivery is answered 200 at
 * once, and only then is the one issue it names read again; an OAuthApp revoked delivery marks the connections to
 * reconnect. Nothing in the body is used but the Linear workspace and the issue's id.
 */

const SECRET = "lin_wh_5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a";
const NOW = Date.parse("2026-10-31T09:00:00Z");
const ORG_ID = "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01";
const ISSUE_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01";

const sign = (body: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

/** A delivery as Linear sends one: its body, its signature and its headers. */
function delivery(body: Record<string, unknown>, headers: Record<string, string> = {}, raw = JSON.stringify(body)) {
  return new Request("https://www.vestiarion.xyz/api/integrations/linear/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "linear-signature": sign(raw),
      "linear-delivery": crypto.randomUUID(),
      "linear-event": String(body.type ?? ""),
      "user-agent": "Linear-Webhook",
      ...headers,
    },
    body: raw,
  });
}

const issueUpdate = (fields: Record<string, unknown> = {}) => ({
  action: "update",
  type: "Issue",
  createdAt: "2026-10-31T08:59:59.000Z",
  organizationId: ORG_ID,
  webhookTimestamp: NOW - 1_000,
  webhookId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b01",
  url: "https://linear.app/fernhill/issue/ENG-123/billing-export",
  actor: { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a01", type: "user", name: "Mai Tran" },
  // What Linear says changed is never believed: the issue is read again through the API.
  data: { id: ISSUE_ID, identifier: "ENG-123", title: "Billing export", state: { type: "completed", name: "Done" }, completedAt: "2026-10-31T08:59:00.000Z" },
  updatedFrom: { completedAt: null, stateId: "x" },
  ...fields,
});

function deps(over: Partial<LinearWebhookDeps> = {}) {
  const deferred: Array<() => Promise<void>> = [];
  const reread = vi.fn(async () => 1);
  const revoked = vi.fn(async () => 1);
  const value: LinearWebhookDeps = { secret: SECRET, defer: (work) => void deferred.push(work), reread, revoked, now: () => NOW, ...over };
  return { value, deferred, reread, revoked, flush: async () => Promise.all(deferred.map((work) => work())) };
}

describe("the signature (Linear acceptance LN11)", () => {
  it("is the hex HMAC-SHA256 of the exact raw body under the secret", () => {
    const body = JSON.stringify(issueUpdate());
    expect(verifyLinearSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyLinearSignature(SECRET, body, sign(body).toUpperCase())).toBe(true);
    expect(verifyLinearSignature(SECRET, `${body} `, sign(body))).toBe(false);
    expect(verifyLinearSignature("another-secret", body, sign(body))).toBe(false);
    expect(verifyLinearSignature(SECRET, body, null)).toBe(false);
    expect(verifyLinearSignature(SECRET, body, "abc")).toBe(false);
    expect(verifyLinearSignature("", body, sign(body, ""))).toBe(false);
  });

  it("is compared in constant time", () => {
    expect(readFileSync("src/lib/linear/webhook.ts", "utf8")).toMatch(/crypto\.timingSafeEqual\(actual, expected\)/);
  });
});

describe("a delivery", () => {
  it("is answered 200 at once, and the issue it names is read again only after the answer", async () => {
    const d = deps();
    const response = await handleLinearWebhook(delivery(issueUpdate()), d.value);
    expect(response.status).toBe(200);
    expect(d.reread).not.toHaveBeenCalled();
    await d.flush();
    expect(d.reread).toHaveBeenCalledWith({ organizationId: ORG_ID, issueId: ISSUE_ID });
    expect(d.revoked).not.toHaveBeenCalled();
  });

  it("names the issue by a Comment's and an Attachment's issueId", async () => {
    for (const type of ["Comment", "Attachment"]) {
      const d = deps();
      const body = issueUpdate({ type, action: "create", data: { id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c01", issueId: ISSUE_ID, body: "https://evil.example" } });
      expect((await handleLinearWebhook(delivery(body), d.value)).status).toBe(200);
      await d.flush();
      expect(d.reread, type).toHaveBeenCalledWith({ organizationId: ORG_ID, issueId: ISSUE_ID });
    }
  });

  it("reads nothing for another kind of event, or one whose ids are not ids, and still answers 200", async () => {
    for (const body of [
      issueUpdate({ type: "Project", data: { id: ISSUE_ID } }),
      issueUpdate({ type: "Reaction" }),
      issueUpdate({ data: { id: "ENG-123" } }),
      issueUpdate({ organizationId: "not-an-org" }),
      issueUpdate({ type: "Comment", data: { id: ISSUE_ID } }),
    ]) {
      const d = deps();
      expect((await handleLinearWebhook(delivery(body), d.value)).status).toBe(200);
      expect(d.deferred).toHaveLength(0);
    }
  });

  it("marks the Linear workspace's connections to reconnect when the app was revoked there", async () => {
    const d = deps();
    const body = { action: "revoked", type: "OAuthApp", createdAt: "2026-10-31T08:59:59.000Z", organizationId: ORG_ID, oauthClientId: "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a", webhookTimestamp: NOW, webhookId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b01" };
    expect((await handleLinearWebhook(delivery(body), d.value)).status).toBe(200);
    await d.flush();
    expect(d.revoked).toHaveBeenCalledWith(ORG_ID);
    expect(d.reread).not.toHaveBeenCalled();
  });

  it("answers 401 and reads nothing for a bad or missing signature, a stale or missing time, or another secret", async () => {
    const body = issueUpdate();
    const cases: Array<[string, Request]> = [
      ["no signature", delivery(body, { "linear-signature": "" })],
      ["another secret", delivery(body, { "linear-signature": sign(JSON.stringify(body), "another-secret") })],
      ["a changed body", new Request("https://www.vestiarion.xyz/api/integrations/linear/webhook", { method: "POST", headers: { "linear-signature": sign(JSON.stringify(body)) }, body: JSON.stringify({ ...body, action: "remove" }) })],
      ["a minute and more old", delivery(issueUpdate({ webhookTimestamp: NOW - 60_001 }))],
      ["from the future", delivery(issueUpdate({ webhookTimestamp: NOW + 60_001 }))],
      ["no time", delivery(issueUpdate({ webhookTimestamp: undefined }))],
      ["a time in seconds", delivery(issueUpdate({ webhookTimestamp: Math.floor(NOW / 1000) }))],
      ["a signed body that is not JSON", delivery({}, {}, "not json")],
    ];
    for (const [name, request] of cases) {
      const d = deps();
      expect((await handleLinearWebhook(request, d.value)).status, name).toBe(401);
      expect(d.deferred, name).toHaveLength(0);
    }
    // Within the minute either way is taken.
    expect((await handleLinearWebhook(delivery(issueUpdate({ webhookTimestamp: NOW - 59_000 })), deps().value)).status).toBe(200);
  });

  it("refuses a body over 1 MB before reading anything", async () => {
    const d = deps();
    const big = new Request("https://www.vestiarion.xyz/api/integrations/linear/webhook", { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "x" });
    expect((await handleLinearWebhook(big, d.value)).status).toBe(413);
  });

  it("logs a read that failed after the answer, with no detail from the body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps({ reread: vi.fn(async () => Promise.reject(new Error(`token for ${ISSUE_ID}`))) });
    expect((await handleLinearWebhook(delivery(issueUpdate()), d.value)).status).toBe(200);
    await d.flush();
    expect(error).toHaveBeenCalledWith("linear webhook: the issue was not read again", "Error");
    error.mockRestore();
  });
});

describe("what a delivery is read for", () => {
  it("is the Linear workspace and the issue's id, nothing else", () => {
    expect(deliveryOf(issueUpdate())).toEqual({ kind: "issue", organizationId: ORG_ID, issueId: ISSUE_ID });
    const source = readFileSync("src/lib/linear/webhook.ts", "utf8");
    // No state, completion, deliverable or person is taken from a delivery.
    expect(source).not.toMatch(/data\??\.(state|completedAt|title|identifier|assignee|url|body)/);
    expect(source).not.toMatch(/body\.(actor|url|updatedFrom)/);
    const route = readFileSync("src/app/api/integrations/linear/webhook/route.ts", "utf8");
    expect(route).toMatch(/defer: \(work\) => after\(work\)/);
    expect(route).toMatch(/secret: provider\.webhookSecret/);
  });
});
