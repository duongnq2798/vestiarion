import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CycleEvent } from "@/lib/agent/cycle-soon";
import { handleCircleNotification, type NotifyDeps } from "@/lib/circle/notify";

/**
 * What a Circle notification starts (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2–N5): only a
 * notification signed by Circle, about a transfer a workspace is waiting on, starts that workspace's event cycle, which
 * reads Circle back before recording anything (N1). The workspaces, their payments, Circle's key and the cycle are
 * faked; a key pair made here stands in for Circle's.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sign = (raw: string) => crypto.sign("sha256", Buffer.from(raw), privateKey).toString("base64");

/** A hosted workspace, live, whose operating wallet is w-operating; a workspace on its own account, in sandbox, with tx-own in flight. */
const ORGS = [
  { id: "org-hosted", slug: "acme", mode: "live" as const },
  { id: "org-own", slug: "studio", mode: "sandbox" as const },
];

let keyIds = 0;
/** A fresh key id per notification: Circle's keys are remembered by id for the life of the instance. */
const freshKeyId = () => `key-${++keyIds}`;

function body(notificationType: string, notification: Record<string, unknown>): string {
  return JSON.stringify({ subscriptionId: "sub-1", notificationId: `n-${keyIds}`, notificationType, notification, timestamp: "2026-10-06T14:00:00Z", version: 2 });
}
const outbound = (state: string, id = "tx-own") => body("transactions.outbound", { id, walletId: "w-agent", state, transactionType: "OUTBOUND" });
const inbound = (state: string, walletId = "w-operating") => body("transactions.inbound", { id: "tx-in", walletId, state, transactionType: "INBOUND" });

function world(overrides: Partial<NotifyDeps> = {}) {
  const raised: CycleEvent[] = [];
  const keyFetches: Array<{ scope: string | null; keyId: string }> = [];
  let scope: string | null = null;
  const deps: NotifyDeps = {
    candidates: async () => ORGS,
    inScope: async (orgId, fn) => {
      scope = orgId;
      try {
        return await fn();
      } finally {
        scope = null;
      }
    },
    inFlightIntent: async (txId) => scope === "org-own" && txId === "tx-own",
    walletAccount: async (walletId) => scope === "org-hosted" && walletId === "w-operating",
    fetchKey: async (keyId) => {
      keyFetches.push({ scope, keyId });
      return KEY;
    },
    raise: (event) => raised.push(event),
    ...overrides,
  };
  return { deps, raised, keyFetches };
}

const signed = (raw: string) => ({ signature: sign(raw), keyId: freshKeyId() });

describe("handleCircleNotification", () => {
  it("refuses a request without Circle's two headers, starting nothing", async () => {
    const { deps, raised } = world();
    const raw = outbound("COMPLETE");
    expect(await handleCircleNotification(raw, { signature: null, keyId: freshKeyId() }, deps)).toEqual({ status: 401 });
    expect(await handleCircleNotification(raw, { signature: sign(raw), keyId: null }, deps)).toEqual({ status: 401 });
    expect(raised).toEqual([]);
  });

  it("refuses a body that is not Circle's envelope", async () => {
    const { deps, raised } = world();
    expect(await handleCircleNotification("{}", signed("{}"), deps)).toEqual({ status: 400 });
    expect(raised).toEqual([]);
  });

  it("answers Circle's test notification, made with each subscription, and starts nothing", async () => {
    const { deps, raised } = world();
    const raw = body("webhooks.test", { hello: "world" });
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200 });
    expect(raised).toEqual([]);
  });

  it.each(["COMPLETE", "FAILED", "DENIED", "CANCELLED"])(
    "starts payment_settled for an outbound %s whose payment is still in flight, in that workspace only",
    async (state) => {
      const { deps, raised, keyFetches } = world();
      const raw = outbound(state);
      const headers = signed(raw);
      expect(await handleCircleNotification(raw, headers, deps)).toEqual({ status: 200, started: { slug: "studio", kind: "payment_settled" } });
      expect(raised).toEqual([{ orgId: "org-own", sandbox: true, kind: "payment_settled" }]);
      // Circle's key is asked for in the matched workspace's scope: with its own account's credentials.
      expect(keyFetches).toEqual([{ scope: "org-own", keyId: headers.keyId }]);
    }
  );

  it("refuses a signature that does not verify against the matched account's key, starting nothing", async () => {
    const { deps, raised } = world();
    const raw = outbound("COMPLETE");
    const forged = { signature: sign(outbound("COMPLETE", "tx-other")), keyId: freshKeyId() };
    expect(await handleCircleNotification(raw, forged, deps)).toEqual({ status: 401 });
    expect(raised).toEqual([]);
  });

  it("starts nothing for a payment no longer in flight, the usual case, nor for a state before settling", async () => {
    const { deps, raised, keyFetches } = world();
    for (const raw of [outbound("COMPLETE", "tx-confirmed-in-its-cycle"), outbound("CONFIRMED"), outbound("SENT"), outbound("STUCK")]) {
      expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200 });
    }
    expect(raised).toEqual([]);
    expect(keyFetches).toEqual([]);
  });

  it("starts payment_received for an inbound COMPLETE to a workspace's wallet", async () => {
    const { deps, raised } = world();
    const raw = inbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200, started: { slug: "acme", kind: "payment_received" } });
    expect(raised).toEqual([{ orgId: "org-hosted", sandbox: false, kind: "payment_received" }]);
  });

  it("starts nothing for an inbound transfer before it completes, or to a wallet no workspace has", async () => {
    const { deps, raised } = world();
    for (const raw of [inbound("CONFIRMED"), inbound("COMPLETE", "w-unknown")]) {
      expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200 });
    }
    expect(raised).toEqual([]);
  });

  it("answers 503 when Circle's key cannot be fetched, so Circle sends it again, and starts nothing", async () => {
    const { deps, raised } = world({
      fetchKey: async () => {
        throw new Error("Circle did not answer");
      },
    });
    const raw = outbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 503 });
    expect(raised).toEqual([]);
  });

  it("goes on to the next workspace when one cannot be read", async () => {
    const { deps, raised } = world({
      inScope: async (orgId, fn) => {
        if (orgId === "org-hosted") throw new Error("scope failed");
        return fn();
      },
      inFlightIntent: async () => true,
    });
    const raw = outbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toMatchObject({ status: 200, started: { slug: "studio" } });
    expect(raised).toHaveLength(1);
  });
});
