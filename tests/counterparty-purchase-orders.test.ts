import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { changeCounterpartyPurchaseOrders } from "@/lib/counterparty-purchase-orders";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/counterparty-purchase-orders.ts` (docs/superpowers/specs/2026-10-05-three-way-match-design.md M2) against a
 * real supabase-js client whose network is a recorder, inside a real organization scope with a real ledger key, as
 * tests/counterparty-limit.test.ts does for the payment limit.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a1d2";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a2";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bca22";

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
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

function counterpartyRow(overrides: Record<string, unknown> = {}) {
  return { id: COUNTERPARTY_ID, name: "Centronex", purchase_order_required: true, ...overrides };
}

function purchaseOrdersFake(options: { row?: Record<string, unknown> | null; patch?: (request: RecordedRequest) => FakeReply | undefined } = {}) {
  const row = options.row === undefined ? counterpartyRow() : options.row;
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: row };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return options.patch?.(request) ?? { body: [{ id: COUNTERPARTY_ID }] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-10-05T00:00:00Z", actor: "human", domain: "compliance", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

const patches = (requests: RecordedRequest[]) => requests.filter((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH");
const ledgerBodies = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as Record<string, unknown>);

describe("changeCounterpartyPurchaseOrders", () => {
  it("marks a counterparty as paid without purchase orders, guarded on the value it read, and records who did", async () => {
    const { fake, run } = purchaseOrdersFake();

    const result = await run(() => changeCounterpartyPurchaseOrders({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, required: false }));

    expect(result).toEqual({ name: "Centronex", from: true, to: false });
    const [patch] = patches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${COUNTERPARTY_ID}`);
    expect(patch.params.get("purchase_order_required")).toBe("eq.true");
    expect(patch.body).toEqual({ purchase_order_required: false });
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_actor).toBe("human");
    expect(entry.p_domain).toBe("compliance");
    expect(entry.p_action).toBe("counterparty_purchase_orders_changed");
    expect(entry.p_summary).toBe("Marked Centronex as paid without purchase orders");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, from: true, to: false });
  });

  it("marks it as needing them again", async () => {
    const { fake, run } = purchaseOrdersFake({ row: counterpartyRow({ purchase_order_required: false }) });

    const result = await run(() => changeCounterpartyPurchaseOrders({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, required: true }));

    expect(result).toEqual({ name: "Centronex", from: false, to: true });
    expect(patches(fake.requests)[0].params.get("purchase_order_required")).toBe("eq.false");
    expect(ledgerBodies(fake.requests)[0].p_summary).toBe("Marked Centronex as needing purchase orders");
  });

  it("refuses the setting it already has, and writes nothing", async () => {
    const { fake, run } = purchaseOrdersFake();

    await expect(run(() => changeCounterpartyPurchaseOrders({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, required: true }))).rejects.toThrow(
      "Centronex already needs a purchase order."
    );
    expect(patches(fake.requests)).toHaveLength(0);
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });

  it("refuses a counterparty this organization does not hold", async () => {
    const { run } = purchaseOrdersFake({ row: null });

    await expect(run(() => changeCounterpartyPurchaseOrders({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, required: false }))).rejects.toThrow(
      "Counterparty not found."
    );
  });

  it("says someone else won when the guarded update matches nothing, and records nothing", async () => {
    const { fake, run } = purchaseOrdersFake({ patch: () => ({ body: [] }) });

    await expect(run(() => changeCounterpartyPurchaseOrders({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, required: false }))).rejects.toThrow(
      "This counterparty changed a moment ago. Check it and try again."
    );
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });
});
