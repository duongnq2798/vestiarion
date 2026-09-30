import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { changeCounterpartyLimit, CounterpartyLimitError, parseLimitInput } from "@/lib/counterparty-limit";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/counterparty-limit.ts` against a real supabase-js client whose
 * network is a recorder, inside a real organization scope with a real ledger
 * key, as tests/counterparty-address.test.ts does for the address.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a1d1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bca21";

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
  return { id: COUNTERPARTY_ID, name: "Centronex", role: "vendor", risk_level: "clear", baseline_payment_limit: 2, payment_limit: 2, ...overrides };
}

function limitFake(options: {
  row?: Record<string, unknown> | null;
  patch?: (request: RecordedRequest) => FakeReply | undefined;
  runningCycles?: Array<{ id: string }>;
} = {}) {
  const row = options.row === undefined ? counterpartyRow() : options.row;
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: row };
    if (request.path === "/rest/v1/cycle_runs") return { body: options.runningCycles ?? [] };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return options.patch?.(request) ?? { body: [{ id: COUNTERPARTY_ID }] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-30T00:00:00Z", actor: "human", domain: "compliance", action: "x",
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

describe("parseLimitInput", () => {
  it("accepts a positive USDC amount, trimmed", () => {
    expect(parseLimitInput(" 10.5 ", "vendor")).toEqual({ ok: true, limit: "10.5" });
  });

  it.each(["0", "-1", "abc", "1.1234567"])("refuses %s", (raw) => {
    expect(parseLimitInput(raw, "vendor")).toMatchObject({ ok: false });
  });

  it("lets a client's limit be cleared, as when it was added", () => {
    expect(parseLimitInput("", "client")).toEqual({ ok: true, limit: null });
  });

  it.each(["vendor", "contractor"])("never clears a %s's limit: no limit would let the agent pay any amount", (role) => {
    expect(parseLimitInput("  ", role)).toEqual({
      ok: false,
      message: "A vendor or contractor needs a payment limit: without one, the agent could pay any amount.",
    });
  });
});

describe("changeCounterpartyLimit", () => {
  it("sets the configured limit and the current one together, guarded on the old limit, and records both", async () => {
    const { fake, run } = limitFake();

    const result = await run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "10" }));

    expect(result).toEqual({ name: "Centronex", from: 2, to: 10, current: 10 });
    const [patch] = patches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${COUNTERPARTY_ID}`);
    expect(patch.params.get("baseline_payment_limit")).toBe("eq.2");
    expect(patch.body).toEqual({ baseline_payment_limit: "10", payment_limit: 10 });
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("counterparty_limit_changed");
    expect(entry.p_domain).toBe("compliance");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, from: 2, to: 10, currentLimit: 10 });
  });

  it("derives the current limit from the risk screening already found: a quarter for medium risk", async () => {
    const { fake, run } = limitFake({ row: counterpartyRow({ risk_level: "medium", payment_limit: 0.5 }) });

    const result = await run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "100" }));

    expect(result.current).toBe(25);
    expect((patches(fake.requests)[0].body as Record<string, unknown>).payment_limit).toBe(25);
  });

  it("keeps a high-risk counterparty's current limit at 0, whatever is configured", async () => {
    const { fake, run } = limitFake({ row: counterpartyRow({ risk_level: "high", payment_limit: 0 }) });

    await run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "1000" }));

    expect((patches(fake.requests)[0].body as Record<string, unknown>).payment_limit).toBe(0);
  });

  it("guards on is.null when a client had no limit", async () => {
    const { fake, run } = limitFake({ row: counterpartyRow({ role: "client", baseline_payment_limit: null, payment_limit: null }) });

    await run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "50" }));

    expect(patches(fake.requests)[0].params.get("baseline_payment_limit")).toBe("is.null");
  });

  it("refuses the same limit, however it is written, and writes nothing", async () => {
    const { fake, run } = limitFake({ row: counterpartyRow({ baseline_payment_limit: "2.000000" }) });

    await expect(run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "2.00" }))).rejects.toThrow(
      "That is already this counterparty's limit."
    );
    expect(patches(fake.requests)).toHaveLength(0);
  });

  it("refuses to clear a vendor's limit before writing", async () => {
    const { fake, run } = limitFake();

    const attempt = run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "" }));

    await expect(attempt).rejects.toBeInstanceOf(CounterpartyLimitError);
    expect(patches(fake.requests)).toHaveLength(0);
  });

  it("refuses while a cycle is running, whose screening would write the old limit back", async () => {
    const { fake, run } = limitFake({ runningCycles: [{ id: "run-1" }] });

    await expect(run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "10" }))).rejects.toThrow(
      "A cycle is running. Try again in a minute, once it has finished."
    );
    expect(patches(fake.requests)).toHaveLength(0);
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/cycle_runs");
    expect(lookup.params.get("status")).toBe("eq.running");
    expect(lookup.params.get("started_at")).toMatch(/^gt\./);
  });

  it("refuses a counterparty this organization does not hold", async () => {
    const { run } = limitFake({ row: null });

    await expect(run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "10" }))).rejects.toThrow("Counterparty not found.");
  });

  it("says someone else won when the guarded update matches nothing, and records nothing", async () => {
    const { fake, run } = limitFake({ patch: () => ({ body: [] }) });

    await expect(run(() => changeCounterpartyLimit({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "10" }))).rejects.toThrow(
      "Someone else changed this limit a moment ago."
    );
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });
});
