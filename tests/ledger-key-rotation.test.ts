import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  appendLedgerEntry,
  ledgerVerificationKeyring,
  recordLedgerKeyRotation,
  verifyChain,
  type LedgerEntryInput,
  type LedgerRow,
} from "@/lib/ledger";
import { exportFromRows, ledgerExportJsonChunks } from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { LedgerKeyError, ledgerKeyStatus, rotateLedgerKey } from "@/lib/platform/ledger-key";
import { decryptSecret, encryptSecret, parseMasterKeys, type SecretEnvelope } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { buildChain, continueChain, GENESIS } from "./support/ledger-chain";

/**
 * `rotateLedgerKey` (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md §1)
 * over a real supabase-js client whose network is a small stateful PostgREST:
 * the organization row, its running cycles and its ledger, whose appends are
 * linked exactly as `append_ledger_entry()` links them. Scopes are entered
 * through the real `withOrg`, so each scope decrypts its signing key from the
 * row as production does, and a scope entered after the swap sees the new key.
 */

const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000b1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b7";
const NOW = new Date("2026-09-30T12:34:56.000Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const OTHER_MASTER_KEYS = `t9:${crypto.randomBytes(32).toString("base64")}`;

const keyA = crypto.generateKeyPairSync("ed25519");
const ID_A = ledgerKeyId(keyA.publicKey);
const PEM_A = keyA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM_A = keyA.publicKey.export({ type: "spki", format: "pem" }).toString();

/** A key this workspace retired before, already on the row. */
const keyZ = crypto.generateKeyPairSync("ed25519");
const EARLIER_RETIRED = {
  id: ledgerKeyId(keyZ.publicKey),
  publicKeyPem: keyZ.publicKey.export({ type: "spki", format: "pem" }).toString(),
  retiredAt: "2026-01-01T00:00:00.000Z",
};

const seal = (value: string, keys = MASTER_KEYS): SecretEnvelope =>
  encryptSecret(value, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(keys));
const open = (envelope: SecretEnvelope): string =>
  decryptSecret(envelope, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS));

const INPUTS: LedgerEntryInput[] = [
  { actor: "system", domain: "system", action: "workspace_created", summary: "Workspace created", detail: {} },
  { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY 240", detail: { amount: 240 } },
];

interface State {
  org: {
    ledger_signing_key_enc: SecretEnvelope | null;
    ledger_retired_keys: unknown;
  };
  entries: LedgerRow[];
  cycleRunning: boolean;
}

function workspace(overrides: Partial<State["org"]> = {}): State {
  return {
    org: { ledger_signing_key_enc: seal(PEM_A), ledger_retired_keys: [EARLIER_RETIRED], ...overrides },
    entries: buildChain(INPUTS, keyA.privateKey, ID_A),
    cycleRunning: false,
  };
}

interface DatabaseOptions {
  orgUpdateMatchesNothing?: boolean;
  appendFails?: boolean;
}

const eqValue = (request: RecordedRequest, column: string) => request.params.get(column)?.replace(/^eq\./, "");

function projectOrg(state: State, select: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox",
    circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null, ...state.org,
  };
  const out: Record<string, unknown> = {};
  for (const item of select.split(",").map((part) => part.trim())) out[item] = row[item];
  return out;
}

function one(request: RecordedRequest, rows: unknown[]): FakeReply {
  const asObject = request.headers.get("accept")?.includes("vnd.pgrst.object");
  return { body: asObject ? rows[0] : rows };
}

/** What `append_ledger_entry()` does: link the signed body after the head. */
function append(state: State, body: Record<string, unknown>): LedgerRow {
  const head = state.entries[state.entries.length - 1];
  const prev = head?.hash ?? GENESIS;
  const row: LedgerRow = {
    seq: (head?.seq ?? 0) + 1,
    id: crypto.randomUUID(),
    ts: NOW.toISOString(),
    actor: body.p_actor as LedgerRow["actor"],
    domain: body.p_domain as LedgerRow["domain"],
    action: body.p_action as string,
    summary: body.p_summary as string,
    detail: body.p_detail as Record<string, unknown>,
    body_hash: body.p_body_hash as string,
    signature: body.p_signature as string,
    prev_hash: prev,
    hash: crypto.createHash("sha256").update(prev + (body.p_body_hash as string) + (body.p_signature as string)).digest("hex"),
    signing_key_id: (body.p_signing_key_id as string | null) ?? null,
  };
  state.entries.push(row);
  return row;
}

function database(state: State, options: DatabaseOptions = {}) {
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/orgs" && request.method === "GET") {
      if (eqValue(request, "id") !== ORG) return { status: 406, body: { code: "PGRST116", message: "no rows" } };
      return one(request, [projectOrg(state, request.params.get("select") ?? "*")]);
    }
    if (request.path === "/rest/v1/orgs" && request.method === "PATCH") {
      if (options.orgUpdateMatchesNothing || eqValue(request, "id") !== ORG) return { body: [] };
      for (const [filter, value] of request.params) {
        const json = /^(\w+)->>(\w+)$/.exec(filter);
        if (!json) continue;
        const envelope = (state.org as Record<string, unknown>)[json[1]] as Record<string, unknown> | null;
        if (`eq.${envelope?.[json[2]] ?? ""}` !== value) return { body: [] };
      }
      Object.assign(state.org, request.body);
      return { body: [{ id: ORG }] };
    }
    if (request.path === "/rest/v1/cycle_runs" && request.method === "GET") {
      return { body: state.cycleRunning ? [{ id: "run-1" }] : [] };
    }
    if (request.path === "/rest/v1/ledger_entries" && request.method === "GET") {
      const limit = Number(request.params.get("limit") ?? state.entries.length);
      return { body: [...state.entries].reverse().slice(0, limit) };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (options.appendFails) {
        return { status: 500, body: { code: "XX000", message: "the ledger is unavailable", details: null, hint: null } };
      }
      return { body: append(state, request.body as Record<string, unknown>) };
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const base = { config, db: fake.client, fetch: fake.fetch };
  return {
    fake,
    /** Inside the organization's scope, as a server action runs after `inOrg`. */
    inScope: <T>(fn: () => Promise<T>) => runWith(base, () => withOrg(ORG, fn, { userId: ACTOR })),
    /** Outside any organization's scope, as a script would call it. */
    unscoped: <T>(fn: () => Promise<T>) => runWith(base, fn),
  };
}

const orgPatches = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path === "/rest/v1/orgs" && request.method === "PATCH");
const appends = (requests: RecordedRequest[]) =>
  requests
    .filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry")
    .map((request) => request.body as Record<string, unknown>);

const logged: string[] = [];
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;

beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
});

afterEach(() => {
  // Nothing private is ever logged: not the old key, not the new one.
  for (const line of logged) expect(line).not.toContain("PRIVATE KEY");
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  vi.restoreAllMocks();
});

describe("rotateLedgerKey", () => {
  it("swaps in a new sealed key and retires the old public key, conditional on the old envelope", async () => {
    const state = workspace();
    const oldIv = state.org.ledger_signing_key_enc!.iv;
    const { fake, unscoped } = database(state);

    const result = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));

    expect(result.from).toBe(ID_A);
    expect(result.to).toMatch(/^[0-9a-f]{16}$/);
    expect(result.to).not.toBe(ID_A);

    const [patch] = orgPatches(fake.requests);
    expect(orgPatches(fake.requests)).toHaveLength(1);
    expect(patch.params.get("id")).toBe(`eq.${ORG}`);
    expect(patch.params.get("ledger_signing_key_enc->>iv")).toBe(`eq.${oldIv}`);

    const body = patch.body as { ledger_signing_key_enc: SecretEnvelope; ledger_retired_keys: unknown[] };
    const newPrivate = crypto.createPrivateKey(open(body.ledger_signing_key_enc));
    expect(ledgerKeyId(newPrivate)).toBe(result.to);
    expect(body.ledger_retired_keys).toEqual([
      EARLIER_RETIRED,
      { id: ID_A, publicKeyPem: PUBLIC_PEM_A, retiredAt: NOW.toISOString() },
    ]);
  });

  it("writes ledger_key_rotated, by the owner, signed by the new key", async () => {
    const state = workspace();
    const { fake, unscoped } = database(state);

    const { from, to } = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));

    const recorded = appends(fake.requests);
    expect(recorded).toHaveLength(1);
    const [entry] = recorded;
    expect(entry).toMatchObject({
      p_actor: "human",
      p_domain: "system",
      p_action: "ledger_key_rotated",
      p_summary: `Ledger signing key rotated: ${from} retired, ${to} now signs`,
      p_detail: { from, to, by: ACTOR },
      p_signing_key_id: to,
    });
    const newPublic = crypto.createPublicKey(crypto.createPrivateKey(open(state.org.ledger_signing_key_enc!)));
    expect(ledgerKeyId(newPublic)).toBe(to);
    expect(
      crypto.verify(null, Buffer.from(entry.p_body_hash as string, "hex"), newPublic, Buffer.from(entry.p_signature as string, "hex"))
    ).toBe(true);
    expect(
      crypto.verify(null, Buffer.from(entry.p_body_hash as string, "hex"), keyA.publicKey, Buffer.from(entry.p_signature as string, "hex"))
    ).toBe(false);
  });

  it("signs the entry with the new key when called from inside the organization's scope, as the server action does", async () => {
    const state = workspace();
    const { fake, inScope } = database(state);

    // The action's scope was entered before the swap: its configuration holds key A.
    const { to } = await inScope(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));

    const recorded = appends(fake.requests);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ p_action: "ledger_key_rotated", p_signing_key_id: to });
    const newPublic = crypto.createPublicKey(crypto.createPrivateKey(open(state.org.ledger_signing_key_enc!)));
    expect(
      crypto.verify(
        null,
        Buffer.from(recorded[0].p_body_hash as string, "hex"),
        newPublic,
        Buffer.from(recorded[0].p_signature as string, "hex")
      )
    ).toBe(true);

    // The org row was read again for the entry: the swap happened before that read.
    const orgReads = fake.requests.filter((request) => request.path === "/rest/v1/orgs" && request.method === "GET");
    const patchIndex = fake.requests.findIndex((request) => request.path === "/rest/v1/orgs" && request.method === "PATCH");
    expect(orgReads.some((read) => fake.requests.indexOf(read) > patchIndex)).toBe(true);
  });

  it("changes nothing and records nothing when another rotation won the race", async () => {
    const state = workspace();
    const before = structuredClone(state.org);
    const { fake, unscoped } = database(state, { orgUpdateMatchesNothing: true });

    const error = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW })).catch((e) => e);

    expect(error).toBeInstanceOf(LedgerKeyError);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("The signing key changed a moment ago. Reload and check it before rotating again.");
    expect(appends(fake.requests)).toHaveLength(0);
    expect(state.org).toEqual(before);
  });

  it("refuses while a cycle is running, before touching the key", async () => {
    const state = { ...workspace(), cycleRunning: true };
    const { fake, inScope } = database(state);

    const error = await inScope(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW })).catch((e) => e);

    expect(error).toBeInstanceOf(LedgerKeyError);
    expect(error.code).toBe("cycle_running");
    expect(error.message).toBe("A cycle is running. Try again in a minute, once it has finished.");
    expect(orgPatches(fake.requests)).toHaveLength(0);
    expect(appends(fake.requests)).toHaveLength(0);

    const check = fake.requests.find((request) => request.path === "/rest/v1/cycle_runs");
    expect(check?.params.get("status")).toBe("eq.running");
    expect(check?.params.get("started_at")).toBe(`gt.${new Date(NOW.getTime() - 15 * 60_000).toISOString()}`);
  });

  it("refuses a current key it cannot open, changing nothing", async () => {
    const state = workspace({ ledger_signing_key_enc: seal(PEM_A, OTHER_MASTER_KEYS) });
    const { fake, unscoped } = database(state);

    const error = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW })).catch((e) => e);

    expect(error).toBeInstanceOf(LedgerKeyError);
    expect(error.code).toBe("key_unreadable");
    expect(error.message).toBe(
      "The current signing key cannot be read, so it cannot be retired safely. Nothing was changed."
    );
    expect(orgPatches(fake.requests)).toHaveLength(0);
    expect(appends(fake.requests)).toHaveLength(0);
  });

  it("refuses a workspace with no signing key stored", async () => {
    const state = workspace({ ledger_signing_key_enc: null });
    const { fake, unscoped } = database(state);

    const error = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW })).catch((e) => e);

    expect(error).toBeInstanceOf(LedgerKeyError);
    expect(error.code).toBe("key_unreadable");
    expect(orgPatches(fake.requests)).toHaveLength(0);
  });

  it("still returns the rotation when the entry cannot be written after the swap, and logs no key", async () => {
    const state = workspace();
    const { fake, inScope } = database(state, { appendFails: true });

    const result = await inScope(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));

    expect(result).toEqual({ from: ID_A, to: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(orgPatches(fake.requests)).toHaveLength(1);
    const errorSpy = vi.mocked(console.error);
    expect(errorSpy).toHaveBeenCalledWith(
      "ledger key rotation: the rotation entry could not be written",
      ORG,
      expect.any(String)
    );
    for (const call of errorSpy.mock.calls) {
      const text = call.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" ");
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain(PEM_A);
    }
  });

  it("sends no private key anywhere but inside the sealed envelope, and returns only ids", async () => {
    const state = workspace();
    const { fake, inScope } = database(state);

    const result = await inScope(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));

    for (const request of fake.requests) {
      expect(JSON.stringify(request.body ?? null)).not.toContain("PRIVATE KEY");
      expect(request.params.toString()).not.toContain("PRIVATE");
    }
    expect(Object.keys(result).sort()).toEqual(["from", "to"]);
    expect(JSON.stringify(result)).not.toContain("KEY");
  });
});

describe("recordLedgerKeyRotation", () => {
  it("returns null and appends nothing when the head is already signed by the current key", async () => {
    const state = workspace();
    const { fake, inScope } = database(state);

    const entry = await inScope(() => recordLedgerKeyRotation(ACTOR));

    expect(entry).toBeNull();
    expect(appends(fake.requests)).toHaveLength(0);
  });
});

describe("ledgerKeyStatus", () => {
  it("names the current key and the well-formed retired keys, newest first", async () => {
    const keyY = crypto.generateKeyPairSync("ed25519");
    const later = {
      id: ledgerKeyId(keyY.publicKey),
      publicKeyPem: keyY.publicKey.export({ type: "spki", format: "pem" }).toString(),
      retiredAt: "2026-06-01T00:00:00.000Z",
    };
    const state = workspace({
      ledger_retired_keys: [
        EARLIER_RETIRED,
        later,
        { id: "ffffffffffffffff", publicKeyPem: "not a key", retiredAt: "2026-07-01T00:00:00.000Z" },
        { id: "eeeeeeeeeeeeeeee", publicKeyPem: EARLIER_RETIRED.publicKeyPem, retiredAt: "whenever" },
        { nope: true },
        "junk",
      ],
    });
    const { unscoped } = database(state);

    const status = await unscoped(() => ledgerKeyStatus(ORG));

    expect(status).toEqual({
      current: ID_A,
      retired: [
        { id: later.id, retiredAt: later.retiredAt },
        { id: EARLIER_RETIRED.id, retiredAt: EARLIER_RETIRED.retiredAt },
      ],
    });
  });

  it("lists the key a rotation just retired", async () => {
    const state = workspace({ ledger_retired_keys: [] });
    const { unscoped } = database(state);

    const { from, to } = await unscoped(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));
    const status = await unscoped(() => ledgerKeyStatus(ORG));

    expect(status).toEqual({ current: to, retired: [{ id: from, retiredAt: NOW.toISOString() }] });
  });
});

describe("a chain across a rotation", () => {
  const SCRIPT = path.join(process.cwd(), "public", "tools", "verify-ledger-export.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-rotation-"));
  let n = 0;

  function runVerifier(rows: LedgerRow[], keyring: LedgerKeyring, extra: string[] = []) {
    const doc = exportFromRows({ rows, keyring, workspace: { slug: "northstar", name: "Northstar" }, now: NOW });
    const file = path.join(dir, `export-${++n}.json`);
    writeFileSync(file, [...ledgerExportJsonChunks(doc)].join(""));
    const result = spawnSync(process.execPath, [SCRIPT, file, ...extra], { encoding: "utf8" });
    return { code: result.status, first: result.stdout.split("\n")[0] };
  }

  const pemFile = (name: string, keys: crypto.KeyObject[]) => {
    const file = path.join(dir, name);
    writeFileSync(file, keys.map((key) => key.export({ type: "spki", format: "pem" }).toString()).join("\n"));
    return file;
  };

  it("verifies in memory and passes the standalone verifier; pinning only the new key is NOT CHECKED", () => {
    const keyB = crypto.generateKeyPairSync("ed25519");
    const idB = ledgerKeyId(keyB.publicKey);
    const before = buildChain(INPUTS, keyA.privateKey, ID_A);
    const after = continueChain(
      before,
      [
        { actor: "human", domain: "system", action: "ledger_key_rotated", summary: `Ledger signing key rotated: ${ID_A} retired, ${idB} now signs`, detail: { from: ID_A, to: idB, by: ACTOR } },
        { actor: "agent", domain: "ap", action: "ap_hold", summary: "HOLD 1200", detail: { amount: 1200 } },
      ],
      keyB.privateKey,
      idB
    );
    const rows = [...before, ...after];
    const keyring: LedgerKeyring = { active: keyB.publicKey, retired: [keyA.publicKey] };

    expect(verifyChain(rows, keyring).valid).toBe(true);
    expect(runVerifier(rows, keyring).code).toBe(0);
    expect(runVerifier(rows, keyring, ["--public-key", pemFile("both.pem", [keyA.publicKey, keyB.publicKey])]).code).toBe(0);
    const bOnly = runVerifier(rows, keyring, ["--public-key", pemFile("b-only.pem", [keyB.publicKey])]);
    expect(bOnly.code).toBe(2);
    expect(bOnly.first).toMatch(/^NOT CHECKED/);
  });

  it("rotated through rotateLedgerKey and continued, verifies over the workspace's new keyring and exports cleanly", async () => {
    const state = workspace();
    const { inScope } = database(state);

    const { from, to } = await inScope(() => rotateLedgerKey({ orgId: ORG, actorId: ACTOR, now: NOW }));
    // A later request, in a scope of its own: the next entry needs no second rotation entry.
    const keyring = await inScope(async () => {
      await appendLedgerEntry({ actor: "agent", domain: "ap", action: "ap_hold", summary: "HOLD 1200", detail: { amount: 1200 } });
      return ledgerVerificationKeyring();
    });

    expect(state.entries.map((row) => row.action)).toEqual(["workspace_created", "ap_pay", "ledger_key_rotated", "ap_hold"]);
    expect(state.entries.map((row) => row.signing_key_id)).toEqual([from, from, to, to]);
    expect(keyring.active && ledgerKeyId(keyring.active)).toBe(to);
    expect(keyring.retired.map((key) => ledgerKeyId(key))).toContain(from);
    expect(verifyChain(state.entries, keyring).valid).toBe(true);
    expect(runVerifier(state.entries, keyring).code).toBe(0);
  });
});
