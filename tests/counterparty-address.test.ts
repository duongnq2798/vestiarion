import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  addressUnconfirmed,
  changeCounterpartyAddress,
  confirmCounterpartyAddress,
  CounterpartyAddressError,
  parseAddressInput,
} from "@/lib/counterparty-address";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/counterparty-address.ts` against a real supabase-js client whose
 * network is a recorder, inside a real organization scope with a real ledger
 * key, so the ledger entries are really signed and their bodies are the ones
 * PostgREST would receive.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a0d0";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bca11";
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x2222222222222222222222222222222222222222";
const CHANGED_AT = "2026-09-30T12:00:00.123456+00:00";

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
  return {
    id: COUNTERPARTY_ID,
    name: "Acme Supplies",
    address: OLD,
    address_changed_at: null,
    address_confirmed_at: null,
    ...overrides,
  };
}

function addressFake(options: {
  row?: Record<string, unknown> | null;
  /** The PATCH's reply; by default one row matched. */
  patch?: (request: RecordedRequest) => FakeReply | undefined;
} = {}) {
  const row = options.row === undefined ? counterpartyRow() : options.row;
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: row };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") {
      return options.patch?.(request) ?? { body: [{ id: COUNTERPARTY_ID }] };
    }
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

describe("parseAddressInput", () => {
  it("accepts an Arc address, trimmed", () => {
    expect(parseAddressInput(`  ${NEW}\n`)).toEqual({ ok: true, address: NEW });
  });

  it("reads an empty or blank value as clearing the address", () => {
    expect(parseAddressInput("")).toEqual({ ok: true, address: null });
    expect(parseAddressInput("   ")).toEqual({ ok: true, address: null });
  });

  it.each(["0x123", "1111111111111111111111111111111111111111", `${NEW}0`, "0xZZ22222222222222222222222222222222222222", "vitalik.eth"])(
    "refuses %s",
    (raw) => {
      expect(parseAddressInput(raw)).toEqual({ ok: false, message: "Enter an Arc address: 0x followed by 40 hex characters." });
    }
  );
});

describe("addressUnconfirmed", () => {
  it("is false for an address that was never changed", () => {
    expect(addressUnconfirmed(null, null)).toBe(false);
    expect(addressUnconfirmed(null, "2026-09-30T12:00:00Z")).toBe(false);
  });

  it("is true for a change no one has confirmed", () => {
    expect(addressUnconfirmed(CHANGED_AT, null)).toBe(true);
  });

  it("is true when the last confirmation is older than the change", () => {
    expect(addressUnconfirmed("2026-09-30T12:00:00Z", "2026-09-29T12:00:00Z")).toBe(true);
  });

  it("is false once a confirmation follows the change", () => {
    expect(addressUnconfirmed("2026-09-30T12:00:00Z", "2026-09-30T12:05:00Z")).toBe(false);
  });
});

describe("changeCounterpartyAddress", () => {
  it("changes the address guarded on the old one, marks it changed, and records both addresses", async () => {
    const { fake, run } = addressFake();

    const result = await run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: NEW }));

    expect(result).toEqual({ name: "Acme Supplies", from: OLD, to: NEW });
    const [patch] = patches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${COUNTERPARTY_ID}`);
    expect(patch.params.get("address")).toBe(`eq.${OLD}`);
    const body = patch.body as Record<string, unknown>;
    expect(body.address).toBe(NEW);
    expect(Number.isNaN(Date.parse(String(body.address_changed_at)))).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["address", "address_changed_at"]);

    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("counterparty_address_changed");
    expect(entry.p_domain).toBe("compliance");
    expect(entry.p_actor).toBe("human");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, from: OLD, to: NEW });
  });

  it("records a payee's own change through a payee link as the link, with no person", async () => {
    const { fake, run } = addressFake({ row: counterpartyRow({ address: null }) });
    const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";

    const result = await run(() => changeCounterpartyAddress({ payeeLinkId: LINK, counterpartyId: COUNTERPARTY_ID, raw: NEW }));

    expect(result).toEqual({ name: "Acme Supplies", from: null, to: NEW });
    // The change is stamped like any other, so payments wait for a member to confirm it.
    const body = patches(fake.requests)[0].body as Record<string, unknown>;
    expect(Number.isNaN(Date.parse(String(body.address_changed_at)))).toBe(false);
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_actor).toBe("human");
    expect(entry.p_detail).toEqual({ by: null, via: "payee_link", linkId: LINK, counterpartyId: COUNTERPARTY_ID, from: null, to: NEW });
    expect(entry.p_summary).toBe("An address was entered through Acme Supplies's payee link; the next payment waits for a person to confirm it");
  });

  it("guards on the change and the confirmation it read, so a confirmation that lands first makes this a conflict", async () => {
    const CONFIRMED_AT = "2026-09-30T12:05:00.654321+00:00";
    const { fake, run } = addressFake({ row: counterpartyRow({ address_changed_at: CHANGED_AT, address_confirmed_at: CONFIRMED_AT }) });

    await run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: NEW }));

    const [patch] = patches(fake.requests);
    expect(patch.params.get("address_changed_at")).toBe(`eq.${CHANGED_AT}`);
    expect(patch.params.get("address_confirmed_at")).toBe(`eq.${CONFIRMED_AT}`);
  });

  it("guards on never-changed and never-confirmed with is.null", async () => {
    const { fake, run } = addressFake();

    await run(() => changeCounterpartyAddress({ payeeLinkId: "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1", counterpartyId: COUNTERPARTY_ID, raw: NEW }));

    const [patch] = patches(fake.requests);
    expect(patch.params.get("address_changed_at")).toBe("is.null");
    expect(patch.params.get("address_confirmed_at")).toBe("is.null");
  });

  it("guards on a missing address with is.null, when the counterparty has none yet", async () => {
    const { fake, run } = addressFake({ row: counterpartyRow({ address: null }) });

    await run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: NEW }));

    expect(patches(fake.requests)[0].params.get("address")).toBe("is.null");
  });

  it("clears the address, which still counts as a change", async () => {
    const { fake, run } = addressFake();

    const result = await run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "" }));

    expect(result.to).toBeNull();
    const body = patches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.address).toBeNull();
    expect(body.address_changed_at).toEqual(expect.any(String));
  });

  it("refuses an invalid address before reading anything", async () => {
    const { fake, run } = addressFake();

    const attempt = run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: "0x123" }));

    await expect(attempt).rejects.toBeInstanceOf(CounterpartyAddressError);
    await expect(attempt).rejects.toThrow("Enter an Arc address: 0x followed by 40 hex characters.");
    expect(fake.requests.filter((r) => r.path === "/rest/v1/counterparties")).toHaveLength(0);
  });

  it("refuses the same address, whatever its letter case, and writes nothing", async () => {
    const mixed = "0xAbCdEf0000000000000000000000000000000001";
    const { fake, run } = addressFake({ row: counterpartyRow({ address: mixed }) });

    const attempt = run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: mixed.toLowerCase() }));

    await expect(attempt).rejects.toThrow("That is already this counterparty's address.");
    expect(patches(fake.requests)).toHaveLength(0);
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });

  it("refuses a counterparty this organization does not hold", async () => {
    const { run } = addressFake({ row: null });

    await expect(run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: NEW }))).rejects.toThrow(
      "Counterparty not found."
    );
  });

  it("says someone else won when the guarded update matches nothing, and records nothing", async () => {
    const { fake, run } = addressFake({ patch: () => ({ body: [] }) });

    await expect(run(() => changeCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, raw: NEW }))).rejects.toThrow(
      "Someone else changed this address a moment ago."
    );
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });
});

describe("confirmCounterpartyAddress", () => {
  const unconfirmed = () => counterpartyRow({ address: NEW, address_changed_at: CHANGED_AT });

  it("confirms the shown address, guarded on it and on the change it confirms, and records who", async () => {
    const { fake, run } = addressFake({ row: unconfirmed() });

    const confirmed = await run(() =>
      confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: ` ${NEW} `, via: "confirm" })
    );

    expect(confirmed).toBe(true);
    const [patch] = patches(fake.requests);
    expect(patch.params.get("address")).toBe(`eq.${NEW}`);
    expect(patch.params.get("address_changed_at")).toBe(`eq.${CHANGED_AT}`);
    expect(Object.keys(patch.body as object)).toEqual(["address_confirmed_at"]);
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("counterparty_address_confirmed");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: NEW, via: "confirm" });
  });

  it("stamps the confirmation after the change even when this clock runs behind the one that stamped it", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { fake, run } = addressFake({ row: counterpartyRow({ address: NEW, address_changed_at: future }) });

    await run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: NEW, via: "confirm" }));

    const body = patches(fake.requests)[0].body as { address_confirmed_at: string };
    expect(addressUnconfirmed(future, body.address_confirmed_at)).toBe(false);
  });

  it("refuses an address that is no longer the counterparty's, before writing", async () => {
    const { fake, run } = addressFake({ row: unconfirmed() });

    const attempt = run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: OLD, via: "confirm" }));

    await expect(attempt).rejects.toThrow("This counterparty's address changed after this page loaded. Check the new address and try again.");
    expect(patches(fake.requests)).toHaveLength(0);
  });

  it("refuses as stale when another change lands between the read and the write", async () => {
    const { run } = addressFake({ row: unconfirmed(), patch: () => ({ body: [] }) });

    await expect(
      run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: NEW, via: "confirm" }))
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("does nothing for an address that needs no confirmation", async () => {
    const { fake, run } = addressFake({
      row: counterpartyRow({ address: NEW, address_changed_at: CHANGED_AT, address_confirmed_at: "2026-09-30T13:00:00Z" }),
    });

    const confirmed = await run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: NEW, via: "approval" }));

    expect(confirmed).toBe(false);
    expect(patches(fake.requests)).toHaveLength(0);
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });

  it("confirms a cleared address with nothing shown", async () => {
    const { fake, run } = addressFake({ row: counterpartyRow({ address: null, address_changed_at: CHANGED_AT }) });

    const confirmed = await run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: "", via: "confirm" }));

    expect(confirmed).toBe(true);
    expect(patches(fake.requests)[0].params.get("address")).toBe("is.null");
  });
});
