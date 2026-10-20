import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { confirmCounterpartyAddress } from "@/lib/counterparty-address";
import { enforceApGuardrails } from "@/lib/agent/guardrails";
import { planFollowUp } from "@/lib/agent/follow-up";
import {
  changePayeeLock,
  coolingOffUntil,
  earlierLookalike,
  inCoolingOff,
  lockEased,
  lookalikes,
  parseVerification,
  payeeLockRefusal,
  readPayeeLockStatus,
} from "@/lib/payee-lock";
import { db } from "@/lib/dal";
import { readPaymentPolicies } from "@/lib/approval-policy";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The payee lock (docs/superpowers/specs/2026-10-20-payee-lock-design.md): the record of how an address was checked
 * (PL2), two people (PL3), no confirmation by approving (PL4), the cooling-off (PL5), lookalike addresses (PL6) and the
 * setting itself (PL1), against a real supabase-js client whose network is a recorder and a real signing key.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b10c";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b1";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bcb11";
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x2222222222222222222222222222222222222222";
const CHANGED_AT = "2026-09-30T12:00:00.000000+00:00";

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
    slug: "lockstar",
    name: "Lockstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

interface LockFake {
  lock?: { on: boolean; hours?: number } | "missing";
  counterparty?: Record<string, unknown> | null;
  /** All the workspace's counterparties, for lookalikes. */
  everyone?: Array<Record<string, unknown>>;
  /** The counterparty's address entries, newest first (new payee check N2). */
  entries?: Array<Record<string, unknown>>;
  approversBesides?: number;
  cycleRunning?: boolean;
  upsert?: FakeReply;
}

function lockFake(options: LockFake = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/approval_policies" && request.method === "GET") {
      if (options.lock === "missing") return { status: 400, body: { code: "42703", message: "column approval_policies.payee_lock does not exist" } };
      return { body: options.lock ? [{ payee_lock: options.lock.on, payee_lock_cooling_hours: options.lock.hours ?? 0 }] : [] };
    }
    if (request.path === "/rest/v1/approval_policies" && request.method === "POST") return options.upsert ?? { status: 201, body: null };
    if (request.path === "/rest/v1/cycle_runs") return { body: options.cycleRunning ? [{ id: "run-1" }] : [] };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") {
      // The list for lookalikes asks for no single row; the address checks ask for one.
      return request.params.get("id") ? { body: options.counterparty ?? null } : { body: options.everyone ?? [] };
    }
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return { body: [{ id: COUNTERPARTY_ID }] };
    // The address's own entries (new payee check N2); any other read, the key rotation check's, finds none.
    if (request.path === "/rest/v1/ledger_entries") return { body: request.params.get("action")?.startsWith("in.(") ? (options.entries ?? []) : [] };
    if (request.path === "/rest/v1/rpc/approvers_besides") return { body: options.approversBesides ?? 1 };
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

const ledgerBodies = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as Record<string, unknown>);
const unconfirmed = (overrides: Record<string, unknown> = {}) => ({
  id: COUNTERPARTY_ID,
  name: "Acme Supplies",
  address: NEW,
  address_changed_at: CHANGED_AT,
  address_confirmed_at: null,
  ...overrides,
});
/** The member who typed the new address in. */
const typedBy = (by: string) => [{ action: "counterparty_address_changed", detail: { by, counterpartyId: COUNTERPARTY_ID, from: OLD, to: NEW } }];
const CALL = { method: "call" as const, contact: "+44 20 7946 0000, from our contract", contactOnFileBefore: true, note: null };

describe("parseVerification (PL2)", () => {
  it("records nothing for an empty form with the lock off, and asks for the method for anything filled in", () => {
    expect(parseVerification({}, false)).toEqual({ ok: true, verification: null });
    expect(parseVerification({ contact: "+1 555 0100" }, false)).toMatchObject({ ok: false, problem: "method" });
  });

  it("with the lock on, needs the method, a call's or a message's contact on file before, and another way's note", () => {
    expect(parseVerification({}, true)).toMatchObject({ ok: false, problem: "method" });
    expect(parseVerification({ method: "call" }, true)).toMatchObject({ ok: false, problem: "contact" });
    expect(parseVerification({ method: "message", contact: "Telegram @acme" }, true)).toMatchObject({ ok: false, problem: "contact_not_on_file" });
    expect(parseVerification({ method: "other" }, true)).toMatchObject({ ok: false, problem: "note" });
    expect(parseVerification({ method: "call", contact: " +44 20 7946 0000 ", contactOnFileBefore: "on" }, true)).toEqual({
      ok: true,
      verification: { method: "call", contact: "+44 20 7946 0000", contactOnFileBefore: true, note: null },
    });
    expect(parseVerification({ method: "in_person" }, true)).toEqual({
      ok: true,
      verification: { method: "in_person", contact: null, contactOnFileBefore: false, note: null },
    });
  });

  it("refuses a link, a control character, or text past its length", () => {
    expect(parseVerification({ method: "message", contact: "www.evil.example" }, false)).toMatchObject({ ok: false, problem: "text" });
    expect(parseVerification({ method: "other", note: "see https://evil.example" }, false)).toMatchObject({ ok: false, problem: "text" });
    expect(parseVerification({ method: "call", contact: "+1\u0007555" }, false)).toMatchObject({ ok: false, problem: "text" });
    expect(parseVerification({ method: "call", contact: "x".repeat(201) }, false)).toMatchObject({ ok: false, problem: "text" });
    expect(parseVerification({ method: "other", note: "line one\nline two" }, true)).toMatchObject({ ok: true });
  });

  it("refuses a format character that reverses how text reads (U+202E)", () => {
    expect(parseVerification({ method: "call", contact: "+44\u202E0000" }, false)).toMatchObject({ ok: false, problem: "text" });
  });

  it("refuses a method it does not know", () => {
    expect(parseVerification({ method: "email" }, false)).toMatchObject({ ok: false, problem: "method" });
  });
});

describe("the cooling-off (PL5)", () => {
  const lock = { on: true, coolingHours: 24 };

  it("runs from the change for the set hours, and only while the lock is on with a wait", () => {
    expect(coolingOffUntil(CHANGED_AT, lock)?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(coolingOffUntil(CHANGED_AT, { on: false, coolingHours: 24 })).toBeNull();
    expect(coolingOffUntil(CHANGED_AT, { on: true, coolingHours: 0 })).toBeNull();
    expect(coolingOffUntil(null, lock)).toBeNull();
  });

  it("holds until the time, then lets it through", () => {
    expect(inCoolingOff(CHANGED_AT, lock, Date.parse("2026-10-01T11:59:00Z"))).not.toBeNull();
    expect(inCoolingOff(CHANGED_AT, lock, Date.parse("2026-10-01T12:00:00Z"))).toBeNull();
  });

  it("calls a change easing when it shortens the wait in force, so the action starts a cycle (due-work watch DW8)", () => {
    expect(lockEased({ on: true, coolingHours: 24 }, { on: false, coolingHours: 24 })).toBe(true);
    expect(lockEased({ on: true, coolingHours: 24 }, { on: true, coolingHours: 4 })).toBe(true);
    expect(lockEased({ on: true, coolingHours: 24 }, { on: true, coolingHours: 0 })).toBe(true);
    // Turning it on, lengthening the wait, or changing a lock with no wait frees nothing.
    expect(lockEased({ on: false, coolingHours: 0 }, { on: true, coolingHours: 24 })).toBe(false);
    expect(lockEased({ on: true, coolingHours: 4 }, { on: true, coolingHours: 24 })).toBe(false);
    expect(lockEased({ on: true, coolingHours: 0 }, { on: false, coolingHours: 0 })).toBe(false);
    expect(lockEased({ on: false, coolingHours: 24 }, { on: false, coolingHours: 4 })).toBe(false);
  });

  it("holds a payment to a recently changed, confirmed address as counterparty.cooling_off, naming when it can be paid", () => {
    const base = { action: "pay" as const, reasoning: "Due today.", amount: 10, riskLevel: "clear", paymentLimit: 100 };
    const held = enforceApGuardrails({
      ...base,
      addressChangedAt: CHANGED_AT,
      addressConfirmedAt: "2026-09-30T13:00:00Z",
      payeeLock: lock,
      now: Date.parse("2026-09-30T20:00:00Z"),
    });
    expect(held).toMatchObject({ blocked: true, status: "held", rule: "counterparty.cooling_off" });
    expect(held.reasoning).toContain("it can be paid from Oct 1, 2026, 12:00 UTC");

    const later = enforceApGuardrails({
      ...base,
      addressChangedAt: CHANGED_AT,
      addressConfirmedAt: "2026-09-30T13:00:00Z",
      payeeLock: lock,
      now: Date.parse("2026-10-02T00:00:00Z"),
    });
    expect(later.rule).not.toBe("counterparty.cooling_off");
    // With the lock off nothing waits.
    expect(enforceApGuardrails({ ...base, addressChangedAt: CHANGED_AT, addressConfirmedAt: "2026-09-30T13:00:00Z", payeeLock: { on: false, coolingHours: 24 }, now: Date.parse("2026-09-30T20:00:00Z") }).rule).not.toBe("counterparty.cooling_off");
  });

  it("an unconfirmed address is held for its confirmation first", () => {
    const held = enforceApGuardrails({
      action: "pay",
      reasoning: "Due today.",
      amount: 10,
      riskLevel: "clear",
      paymentLimit: 100,
      addressChangedAt: CHANGED_AT,
      addressConfirmedAt: null,
      payeeLock: lock,
      now: Date.parse("2026-09-30T20:00:00Z"),
    });
    expect(held.rule).toBe("counterparty.address_unconfirmed");
  });

  it("the follow-up decides a payable held for it again once the wait has ended", () => {
    const frozen = {
      id: "i1",
      status: "held",
      amount: 10,
      currency: "USDC" as const,
      dueDate: "2026-10-05",
      decidedAt: "2026-09-30T20:00:00Z",
      escalatedAt: null,
      poReference: null,
      goodsReceived: true,
      riskLevel: "clear",
      paymentLimit: 100,
    };
    const atDecision = { poReference: null, goodsReceived: true, riskLevel: "clear", paymentLimit: 100, coolingOffHeld: true };
    const config = { reopenOnChange: true, escalateAfterDays: 3, closeAfterDays: 30 } as unknown as Parameters<typeof planFollowUp>[3];
    const still = planFollowUp({ ...frozen, coolingOff: true }, atDecision, Date.parse("2026-10-01T00:00:00Z"), config);
    expect(still.changes ?? []).not.toContain("the payee lock's wait for the new address has ended");
    const ended = planFollowUp({ ...frozen, coolingOff: false }, atDecision, Date.parse("2026-10-02T00:00:00Z"), config);
    expect(ended.changes).toContain("the payee lock's wait for the new address has ended");
  });
});

describe("earlierLookalike (PL6)", () => {
  it("finds an address the payee had or was paid at before that the new one is made to look like", () => {
    const poisoned = "0x1111110000000000000000000000000000001111";
    const entries = [{ action: "counterparty_address_changed", detail: { from: OLD, to: poisoned } }];
    expect(earlierLookalike(poisoned, entries)).toBe(OLD);
    expect(earlierLookalike(poisoned, [], [OLD])).toBe(OLD);
    // A real new wallet shares no such ends with the old one.
    expect(earlierLookalike(NEW, [{ action: "counterparty_address_changed", detail: { from: OLD, to: NEW } }])).toBeNull();
    expect(earlierLookalike(null, entries)).toBeNull();
  });
});

describe("lookalikes (PL6)", () => {
  const row = (id: string, name: string, address: string | null, chain = "ARC-TESTNET") => ({ id, name, address, chain });

  it("names the same address, and one sharing the first 6 and last 4 hex digits, on the same chain, case ignored", () => {
    const found = lookalikes([
      row("a", "Acme", "0xAbCdEf0000000000000000000000000000001234"),
      row("b", "Acme Co", "0xabcdef1111111111111111111111111111111234"),
      row("c", "Orbit", "0xABCDEF0000000000000000000000000000001234"),
      row("d", "Elsewhere", "0xabcdef2222222222222222222222222222221234", "BASE"),
      row("e", "None", null),
    ]);
    expect(found.get("a")).toEqual([
      { kind: "alike", id: "b", name: "Acme Co" },
      { kind: "same", id: "c", name: "Orbit" },
    ]);
    expect(found.get("d")).toBeUndefined();
    expect(found.get("e")).toBeUndefined();
  });

  it("names nothing for addresses that differ in their first 6 or last 4 digits", () => {
    expect(lookalikes([row("a", "A", OLD), row("b", "B", NEW)]).size).toBe(0);
  });
});

describe("the setting (PL1)", () => {
  it("reads as off, and not ready, before 0135 runs", async () => {
    const { run } = lockFake({ lock: "missing" });
    await expect(run(() => readPayeeLockStatus(db()))).resolves.toEqual({ lock: { on: false, coolingHours: 0 }, ready: false });
  });

  it("reads a workspace with no row as off, and a row as it is", async () => {
    expect(await lockFake().run(() => readPayeeLockStatus(db()))).toEqual({ lock: { on: false, coolingHours: 0 }, ready: true });
    expect(await lockFake({ lock: { on: true, hours: 48 } }).run(() => readPayeeLockStatus(db()))).toEqual({ lock: { on: true, coolingHours: 48 }, ready: true });
  });

  it("an owner turns it on with a wait, signed as payee_lock_changed", async () => {
    const { fake, run } = lockFake();
    await expect(run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 24 }))).resolves.toEqual({
      from: { on: false, coolingHours: 0 },
      to: { on: true, coolingHours: 24 },
    });
    const write = fake.requests.find((r) => r.path === "/rest/v1/approval_policies" && r.method === "POST");
    expect(write?.body).toMatchObject({ payee_lock: true, payee_lock_cooling_hours: 24, updated_by: ACTOR });
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("payee_lock_changed");
    expect(entry.p_summary).toBe("Turned on the payee lock, with a 24-hour wait after an address changes");
    expect(entry.p_detail).toEqual({ by: ACTOR, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 24 } });
  });

  it("refuses a save PostgREST cannot take yet, as not ready (PGRST204)", async () => {
    const upsert = { status: 400, body: { code: "PGRST204", message: "Could not find the 'payee_lock' column of 'approval_policies' in the schema cache" } };
    await expect(lockFake({ upsert }).run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 0 }))).rejects.toMatchObject({ code: "not_ready" });
  });

  it("fails closed on any other error, one naming the column included", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow() };
      if (request.path === "/rest/v1/approval_policies") return { status: 403, body: { code: "42501", message: "permission denied for column payee_lock" } };
      return { body: [] };
    });
    await expect(runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => readPayeeLockStatus(db())))).rejects.toThrow(/permission denied/);
  });

  it("names a change of wait alone, with the lock off", async () => {
    const { fake, run } = lockFake({ lock: { on: false, hours: 0 } });
    await run(() => changePayeeLock({ actorId: ACTOR, on: false, coolingHours: 24 }));
    expect(ledgerBodies(fake.requests)[0].p_summary).toBe("Changed the payee lock's wait after an address changes from 0 to 24 hours, with the lock off");
  });

  it("refuses no change, a wait out of range, a running cycle, and a database without it", async () => {
    await expect(lockFake({ lock: { on: true, hours: 24 } }).run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 24 }))).rejects.toMatchObject({ code: "unchanged" });
    await expect(lockFake().run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 169 }))).rejects.toMatchObject({ code: "invalid" });
    await expect(lockFake({ cycleRunning: true }).run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 0 }))).rejects.toMatchObject({ code: "cycle_running" });
    await expect(lockFake({ lock: "missing" }).run(() => changePayeeLock({ actorId: ACTOR, on: true, coolingHours: 0 }))).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("readPaymentPolicies, the agent stage's one read (PL5)", () => {
  it("reads the figure and the lock together", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow() };
      if (request.path === "/rest/v1/approval_policies") return { body: [{ two_approvals_above: "280", payee_lock: true, payee_lock_cooling_hours: 24 }] };
      return { body: [] };
    });
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => readPaymentPolicies(db())));
    expect(result).toEqual({ twoApprovalsAbove: 280, payeeLock: { on: true, coolingHours: 24 } });
    expect(fake.requests.filter((r) => r.path === "/rest/v1/approval_policies")).toHaveLength(1);
  });

  it("before 0135, reads the figure alone and the lock as off", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow() };
      if (request.path === "/rest/v1/approval_policies") {
        return request.params.get("select")?.includes("payee_lock")
          ? { status: 400, body: { code: "42703", message: "column approval_policies.payee_lock does not exist" } }
          : { body: [{ two_approvals_above: "280" }] };
      }
      return { body: [] };
    });
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => readPaymentPolicies(db())));
    expect(result).toEqual({ twoApprovalsAbove: 280, payeeLock: { on: false, coolingHours: 0 } });
  });
});

describe("payeeLockRefusal (PL4, PL5)", () => {
  it("says nothing with the lock off", async () => {
    await expect(lockFake({ counterparty: unconfirmed() }).run(() => payeeLockRefusal(COUNTERPARTY_ID, "Acme Supplies"))).resolves.toBeNull();
  });

  it("refuses an unconfirmed address, and a confirmed one inside its wait, then lets it through", async () => {
    const on = { on: true, hours: 24 };
    await expect(lockFake({ lock: on, counterparty: unconfirmed() }).run(() => payeeLockRefusal(COUNTERPARTY_ID, "Acme Supplies"))).resolves.toBe(
      "Confirm Acme Supplies's address on Counterparties first, and record how you checked it."
    );
    const confirmed = unconfirmed({ address_confirmed_at: "2026-09-30T13:00:00Z" });
    await expect(lockFake({ lock: on, counterparty: confirmed }).run(() => payeeLockRefusal(COUNTERPARTY_ID, "Acme Supplies", Date.parse("2026-09-30T20:00:00Z")))).resolves.toBe(
      "Acme Supplies's address changed recently, and the payee lock makes it wait: it can be paid from Oct 1, 2026, 12:00 UTC."
    );
    await expect(lockFake({ lock: on, counterparty: confirmed }).run(() => payeeLockRefusal(COUNTERPARTY_ID, "Acme Supplies", Date.parse("2026-10-02T00:00:00Z")))).resolves.toBeNull();
  });
});

describe("confirmCounterpartyAddress under the payee lock (PL2–PL4, PL6)", () => {
  const confirm = (actorId: string, verification: typeof CALL | null, via: "confirm" | "approval" = "confirm") =>
    confirmCounterpartyAddress({ actorId, counterpartyId: COUNTERPARTY_ID, shownAddress: NEW, via, verification });

  it("refuses a confirmation by approving a payment, and one with no record or a contact not on file before", async () => {
    const options = { lock: { on: true }, counterparty: unconfirmed(), entries: typedBy(OTHER) };
    await expect(lockFake(options).run(() => confirm(ACTOR, CALL, "approval"))).rejects.toMatchObject({ code: "lock_requires_confirm" });
    await expect(lockFake(options).run(() => confirm(ACTOR, null))).rejects.toMatchObject({ code: "verification_required" });
    await expect(lockFake(options).run(() => confirm(ACTOR, { ...CALL, contactOnFileBefore: false }))).rejects.toMatchObject({ code: "verification_required" });
  });

  it("refuses whoever typed the address while someone else may confirm it, and writes nothing", async () => {
    const { fake, run } = lockFake({ lock: { on: true }, counterparty: unconfirmed(), entries: typedBy(ACTOR), approversBesides: 1 });
    await expect(run(() => confirm(ACTOR, CALL))).rejects.toMatchObject({ code: "giver_confirms" });
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH")).toBe(false);
    expect(ledgerBodies(fake.requests)).toHaveLength(0);
  });

  it("lets them confirm it alone when no one else may, and says so in the record", async () => {
    const { fake, run } = lockFake({ lock: { on: true, hours: 24 }, counterparty: unconfirmed(), entries: typedBy(ACTOR), approversBesides: 0 });
    await expect(run(() => confirm(ACTOR, CALL))).resolves.toBe(true);
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_detail).toMatchObject({ by: ACTOR, verification: CALL, soloConfirmation: true, payeeLock: { coolingHours: 24 } });
  });

  it("signs another member's confirmation with its record", async () => {
    const { fake, run } = lockFake({ lock: { on: true }, counterparty: unconfirmed(), entries: typedBy(OTHER) });
    await expect(run(() => confirm(ACTOR, CALL))).resolves.toBe(true);
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_detail).toEqual({
      by: ACTOR,
      counterpartyId: COUNTERPARTY_ID,
      address: NEW,
      chain: "ARC-TESTNET",
      via: "confirm",
      verification: CALL,
      payeeLock: { coolingHours: 0 },
    });
  });

  it("with the lock off, confirms as before and records when the giver confirmed it themselves", async () => {
    const { fake, run } = lockFake({ counterparty: unconfirmed(), entries: typedBy(ACTOR) });
    await expect(run(() => confirm(ACTOR, null))).resolves.toBe(true);
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: NEW, chain: "ARC-TESTNET", via: "confirm", byGiver: true });
  });

  it("refuses the member who created the payee link the address came through, and records an unknown giver", async () => {
    const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
    const throughLink = [
      { action: "counterparty_address_changed", detail: { by: null, via: "payee_link", linkId: LINK, counterpartyId: COUNTERPARTY_ID, from: OLD, to: NEW } },
      { action: "payee_link_created", detail: { by: ACTOR, linkId: LINK, counterpartyId: COUNTERPARTY_ID } },
    ];
    await expect(
      lockFake({ lock: { on: true }, counterparty: unconfirmed(), entries: throughLink, approversBesides: 1 }).run(() => confirm(ACTOR, CALL))
    ).rejects.toMatchObject({ code: "giver_confirms" });

    // A change whose entry names no one: anyone may confirm it, and the record says no giver was known.
    const unknown = [{ action: "counterparty_address_changed", detail: { by: null, counterpartyId: COUNTERPARTY_ID, from: OLD, to: NEW } }];
    const { fake, run } = lockFake({ lock: { on: true }, counterparty: unconfirmed(), entries: unknown });
    await run(() => confirm(ACTOR, CALL));
    expect(ledgerBodies(fake.requests)[0].p_detail).toMatchObject({ giverUnknown: true });
  });

  it("records an earlier address of the payee the new one is made to look like (address poisoning)", async () => {
    const poisoned = "0x1111110000000000000000000000000000001111";
    const { fake, run } = lockFake({
      counterparty: unconfirmed({ address: poisoned }),
      entries: [{ action: "counterparty_address_changed", detail: { by: OTHER, counterpartyId: COUNTERPARTY_ID, from: OLD, to: poisoned } }],
    });
    await run(() => confirmCounterpartyAddress({ actorId: ACTOR, counterpartyId: COUNTERPARTY_ID, shownAddress: poisoned, via: "confirm" }));
    expect(ledgerBodies(fake.requests)[0].p_detail).toMatchObject({ looksLikeEarlier: OLD });
  });

  it("records the counterparties whose address this one is, or looks like", async () => {
    const { fake, run } = lockFake({
      counterparty: unconfirmed(),
      entries: typedBy(OTHER),
      everyone: [
        { id: COUNTERPARTY_ID, name: "Acme Supplies", address: NEW, chain: null },
        { id: "c-orbit", name: "Orbit", address: "0x2222220000000000000000000000000000002222", chain: null },
      ],
    });
    await run(() => confirm(ACTOR, null));
    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_detail).toMatchObject({ lookalikeOf: ["c-orbit"] });
  });
});
