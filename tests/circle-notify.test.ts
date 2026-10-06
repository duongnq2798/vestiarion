import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CycleEvent } from "@/lib/agent/cycle-soon";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handleCircleNotification, type NotifyDeps } from "@/lib/circle/notify";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * What a Circle notification starts (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2–N5): only a
 * notification signed by Circle, about a transfer a workspace is waiting on, starts that workspace's event cycle, which
 * reads Circle back before recording anything (N1). Money arriving is read at once, and starts a cycle only when it paid
 * a receivable (final review I2). The workspaces, their payments, Circle's key and the cycle are faked; a key pair made
 * here stands in for Circle's.
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
let now = 1_800_000_000_000;
/** A fresh moment per test: an inbound check is taken at most once in 15 seconds per workspace. */
const later = () => (now += 60_000);

function body(notificationType: string, notification: Record<string, unknown>): string {
  return JSON.stringify({ subscriptionId: "sub-1", notificationId: `n-${keyIds}`, notificationType, notification, timestamp: "2026-10-06T14:00:00Z", version: 2 });
}
const outbound = (state: string, id = "tx-own") => body("transactions.outbound", { id, walletId: "w-agent", state, transactionType: "OUTBOUND" });
const inbound = (state: string, walletId = "w-operating") => body("transactions.inbound", { id: "tx-in", walletId, state, transactionType: "INBOUND" });

function world(overrides: Partial<NotifyDeps> = {}, receivablesPaid = 1) {
  const raised: CycleEvent[] = [];
  const keyFetches: Array<{ scope: string | null; keyId: string }> = [];
  const inboundReads: Array<{ scope: string | null; accountId: string }> = [];
  let scope: string | null = null;
  const at = later();
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
    operatingAccount: async (walletId) => (scope === "org-hosted" && walletId === "w-operating" ? "acct-operating" : null),
    fetchKey: async (keyId) => {
      keyFetches.push({ scope, keyId });
      return KEY;
    },
    recordInbound: async (accountId) => {
      inboundReads.push({ scope, accountId });
      return receivablesPaid;
    },
    raise: (event) => raised.push(event),
    now: () => at,
    ...overrides,
  };
  return { deps, raised, keyFetches, inboundReads };
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
    // A subscription is made only if the endpoint answers 2xx: the test notification is answered whatever its headers,
    // since it starts nothing.
    expect(await handleCircleNotification(raw, { signature: null, keyId: null }, deps)).toEqual({ status: 200 });
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

  it("reads money arriving in a workspace's operating wallet at once, and starts payment_received when it paid a receivable", async () => {
    const { deps, raised, inboundReads } = world();
    const raw = inbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200, started: { slug: "acme", kind: "payment_received" } });
    expect(inboundReads).toEqual([{ scope: "org-hosted", accountId: "acct-operating" }]);
    expect(raised).toEqual([{ orgId: "org-hosted", sandbox: false, kind: "payment_received" }]);
  });

  it("starts no cycle for money that paid no receivable: dust, a funding transfer, the agent's own moves (final review I2)", async () => {
    const { deps, raised, inboundReads } = world({}, 0);
    const raw = inbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200 });
    expect(inboundReads).toHaveLength(1);
    expect(raised).toEqual([]);
  });

  it("reads one workspace's inbound transfers at most once in 15 seconds, however often money arrives", async () => {
    let at = later();
    const { deps, inboundReads } = world({ now: () => at }, 0);
    const send = async () => {
      const raw = inbound("COMPLETE");
      return handleCircleNotification(raw, signed(raw), deps);
    };
    await send();
    at += 5_000;
    expect(await send()).toEqual({ status: 200 });
    at += 10_001;
    await send();
    expect(inboundReads).toHaveLength(2);
  });

  it("starts nothing for an inbound transfer before it completes, or to a wallet that is not a workspace's operating wallet", async () => {
    const { deps, raised, inboundReads } = world();
    for (const raw of [inbound("CONFIRMED"), inbound("COMPLETE", "w-unknown"), inbound("COMPLETE", "w-reserve")]) {
      expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 200 });
    }
    expect(inboundReads).toEqual([]);
    expect(raised).toEqual([]);
  });

  it("answers 503 when Circle's key cannot be fetched, so Circle sends it again, and starts nothing; the log names no detail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, raised } = world({
      fetchKey: async () => {
        throw new Error("upstream said secret-detail");
      },
    });
    const raw = outbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 503 });
    expect(raised).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-detail");
    warn.mockRestore();
  });

  it("goes on to the next workspace when one cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
    error.mockRestore();
  });

  it("answers 503 when a workspace could not be read and none matched, so Circle sends it again (final review M7)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, raised } = world({
      inScope: async (orgId, fn) => {
        if (orgId === "org-own") throw new Error("scope failed");
        return fn();
      },
    });
    const raw = outbound("COMPLETE");
    expect(await handleCircleNotification(raw, signed(raw), deps)).toEqual({ status: 503 });
    expect(raised).toEqual([]);
    error.mockRestore();
  });
});

describe("the reads that match a notification, against the workspace's own tables", () => {
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

  it("finds a payment in flight, or recorded failed while it may still move, by its Circle transaction; and an operating wallet only", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/payment_intents") return { body: [{ id: "intent-1" }] };
      if (request.path === "/rest/v1/accounts") return { body: [{ id: "acct-operating" }] };
      return { body: [] };
    });
    const inScope: NonNullable<NotifyDeps["inScope"]> = (orgId, fn) => runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
    const raised: CycleEvent[] = [];
    const deps: NotifyDeps = {
      candidates: async () => [ORGS[1]],
      inScope,
      fetchKey: async () => KEY,
      recordInbound: async () => 1,
      raise: (event) => raised.push(event),
      now: later,
    };

    const out = outbound("COMPLETE");
    await handleCircleNotification(out, signed(out), deps);
    const [intents] = fake.requests.filter((request) => request.path === "/rest/v1/payment_intents");
    expect(intents.params.get("provider_tx_id")).toBe("eq.tx-own");
    expect(intents.params.get("status")).toBe("in.(submitting,pending,failed)");

    const into = inbound("COMPLETE");
    await handleCircleNotification(into, signed(into), deps);
    const [accounts] = fake.requests.filter((request) => request.path === "/rest/v1/accounts");
    expect(accounts.params.get("circle_wallet_id")).toBe("eq.w-operating");
    expect(accounts.params.get("kind")).toBe("eq.operating");
    expect(raised.map((event) => event.kind)).toEqual(["payment_settled", "payment_received"]);
  });
});
