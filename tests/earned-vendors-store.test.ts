import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendMock, canSignMock } = vi.hoisted(() => ({ appendMock: vi.fn(), canSignMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: appendMock, assertLedgerCanSign: canSignMock }));

import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { changeEarnedVendorPayments, changeEarnedVendorRule, EarnedVendorsError, readEarnedVendorRule, readEarnedView, syncEarnedVendors } from "@/lib/earned-vendors-store";
import type { LedgerEntryInput } from "@/lib/ledger";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Earned vendors, read, changed and signed (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL13,
 * AL15-AL17): the rule read as none and not ready before migration 0146; an owner's change, refused on Arc mainnet, while
 * a cycle runs, unchanged or out of bounds, written to the workspace's row and signed strictly, put back from its own
 * write when it cannot be signed, and never said to have changed nothing when it could not be put back; a rule left in
 * force that way signed when an owner asks for it again, or before the next change, from the rule the ledger names; a
 * rule where there was none refused, with nothing written, while a loss owed from the time with no rule cannot be
 * signed; and the sync, which signs only what changed since each vendor's newest signed status, stops at one read before
 * 0146, reads only the rule and the record with no rule, and leaves a vendor whose entry failed as it was recorded, for
 * the next sync to sign, a loss the rule's turning off could not sign included.
 *
 * Step 3's switch (AL21): an owner's, refused without a rule, without an agent spending limit, on Arc mainnet, while a
 * cycle runs and before 0146; signed strictly as `earned_vendor_payments_changed` and put back from its own write when it
 * cannot be; a switch left in force without its entry signed before the next change; turned off, with its entry, when
 * the rule is; and never turned back on by a rule change put back, unless that change turned it off and the ledger still
 * names it on. For the payments made on the agent's own that wait for a verdict (AL26), the sync also reads each bill's
 * status and a person's payments of the bills.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000e4e4e";
const OWNER = "a1b2c3d4-0000-4000-8000-0000000e4e01";
const NORTHWIND = "c0c0c0c0-0000-4000-8000-00000000a001";
const LUMEN = "c0c0c0c0-0000-4000-8000-00000000a002";

/** Postgres refusing a row with the switch on and no rule (0146's check). */
const PAYMENTS_CHECK: FakeReply = {
  status: 400,
  body: { code: "23514", message: 'new row for relation "approval_policies" violates check constraint "approval_policies_earned_vendor_payments_check"' },
};

const at = (day: number) => new Date(Date.parse("2026-10-01T09:00:00.000Z") + day * 86_400_000).toISOString();

interface World {
  rule: { earned_vendor_streak: number | null; earned_vendor_payments: boolean } | null | "missing";
  cycleRunning?: boolean;
  upsert?: (body: Record<string, unknown>) => FakeReply | null;
  /** The answer to a put-back (`PATCH`), in place of writing it where its guard matches. */
  update?: (body: Record<string, unknown>) => FakeReply | null;
  bills: Array<{ id: string; vendor: string; name: string; limit?: string | null; risk?: string; status?: string }>;
  decisions: Array<{ seq: number; day: number; invoice: string; action?: string; rule?: string; status?: string; earned?: boolean }>;
  /** A person's payments of the bills (`approval_paid`), or records of the transfer sent before them. */
  payments?: Array<{ seq: number; invoice: string; recorded?: boolean }>;
  verdicts: Array<{ seq: number; verdict: "agree" | "disagree"; day: number }>;
  record: Array<{ seq: number; ts: string; action: string; counterparty_id: string }>;
  /** The `earned_vendor_rule_changed` entries signed: a rule set already was signed when it was set. */
  rules: Array<{ seq: number; from: number | null; to: number | null }>;
  /** The record (`vendor_earned`, `vendor_earned_lost`) cannot be read. */
  recordUnreadable?: boolean;
  /** The agent's spending limit row; none when absent. */
  budget?: { daily_usdc: string | null; weekly_usdc: string | null };
  /** The `earned_vendor_payments_changed` entries signed. */
  switches?: Array<{ seq: number; from: boolean; to: boolean }>;
}

/** A workspace whose rule, facts and record a fake PostgREST answers, and whose writes and signed entries it keeps. */
function workspace(world: World) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const { path, method, params } = request;
    if (path === "/rest/v1/approval_policies" && method === "GET") {
      if (world.rule === "missing") return { status: 400, body: { code: "42703", message: "column approval_policies.earned_vendor_streak does not exist" } };
      return { body: world.rule ? [world.rule] : [] };
    }
    if (path === "/rest/v1/approval_policies" && method === "POST") {
      const body = request.body as Record<string, unknown>;
      const reply = world.upsert?.(body);
      if (reply) return reply;
      // As Postgres does: an upsert's CHECK is checked on the row it would insert, before it looks for the existing one
      // (tests/earned-vendors-migration.test.ts), so a body without a rule cannot turn the switch on.
      const inserted = { earned_vendor_streak: null, earned_vendor_payments: false, ...(body as Partial<{ earned_vendor_streak: number | null; earned_vendor_payments: boolean }>) };
      if (inserted.earned_vendor_payments && inserted.earned_vendor_streak === null) return PAYMENTS_CHECK;
      const current = world.rule && world.rule !== "missing" ? world.rule : { earned_vendor_streak: null, earned_vendor_payments: false };
      world.rule = { ...current, ...(body as Partial<typeof current>) };
      return { status: 201, body: null };
    }
    if (path === "/rest/v1/approval_policies" && method === "PATCH") {
      const body = request.body as Record<string, unknown>;
      const reply = world.update?.(body);
      if (reply) return reply;
      const guard = params.get("earned_vendor_streak");
      const switchGuard = params.get("earned_vendor_payments");
      const current = world.rule && world.rule !== "missing" ? world.rule : null;
      const guarded =
        switchGuard !== null
          ? switchGuard === `eq.${current?.earned_vendor_payments}`
          : guard === "not.is.null"
            ? current?.earned_vendor_streak !== null
            : guard === (current?.earned_vendor_streak === null ? "is.null" : `eq.${current?.earned_vendor_streak}`);
      const next = current && guarded ? { ...current, ...(body as Partial<typeof current>) } : null;
      if (next && next.earned_vendor_payments && next.earned_vendor_streak === null) return PAYMENTS_CHECK;
      if (next) world.rule = next;
      // With `select`, PostgREST answers the rows it changed.
      return { body: params.has("select") ? (next ? [{ org_id: ORG }] : []) : null };
    }
    if (path === "/rest/v1/cycle_runs") return { body: world.cycleRunning ? [{ id: "run-1" }] : [] };
    if (path === "/rest/v1/agent_budgets") return { body: world.budget ? [world.budget] : [] };
    if (path === "/rest/v1/invoices") {
      return {
        body: world.bills.map((bill) => ({
          id: bill.id,
          amount: "120.000000",
          currency: "USDC",
          status: bill.status ?? "held",
          counterparties: {
            id: bill.vendor,
            name: bill.name,
            sample: false,
            role: "vendor",
            risk_level: bill.risk ?? "clear",
            payment_limit: bill.limit === undefined ? "500" : bill.limit,
          },
        })),
      };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("actor") === "eq.agent") {
      return {
        body: world.decisions.map((decision) => ({
          seq: String(decision.seq),
          ts: at(decision.day),
          action: decision.action ?? "ap_pay",
          invoice_id: decision.invoice,
          guardrail_blocked: decision.rule ? true : null,
          guardrail_rule: decision.rule ?? null,
          resulting_status: decision.status ?? "held",
          earned: decision.earned ? { recordSeq: 900, streak: 5, agreed: 5 } : null,
        })),
      };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("actor") === "eq.human") {
      return { body: (world.payments ?? []).map((payment) => ({ seq: String(payment.seq), action: "approval_paid", invoice_id: payment.invoice, recorded: payment.recorded ?? null })) };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("action") === "in.(vendor_earned,vendor_earned_lost)") {
      if (world.recordUnreadable) return { status: 500, body: { code: "XX000", message: "database unavailable" } };
      return { body: [...world.record].sort((a, b) => b.seq - a.seq) };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("action") === "eq.earned_vendor_rule_changed") {
      const newest = [...world.rules].sort((a, b) => b.seq - a.seq).slice(0, Number(params.get("limit") ?? "1000"));
      return { body: newest.map((rule) => ({ detail: { by: OWNER, from: rule.from, to: rule.to } })) };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("action") === "eq.earned_vendor_payments_changed") {
      const newest = [...(world.switches ?? [])].sort((a, b) => b.seq - a.seq).slice(0, Number(params.get("limit") ?? "1000"));
      return { body: newest.map((entry) => ({ detail: { by: OWNER, from: entry.from, to: entry.to } })) };
    }
    if (path === "/rest/v1/decision_verdicts") {
      return { body: world.verdicts.map((verdict) => ({ entry_seq: String(verdict.seq), verdict: verdict.verdict, decided_at: at(verdict.day) })) };
    }
    if (path === "/rest/v1/counterparties") {
      const ids = params.get("id")?.match(/^in\.\((.*)\)$/)?.[1].split(",") ?? [];
      const names = new Map(world.bills.map((bill) => [bill.vendor, bill.name]));
      return { body: ids.map((id) => ({ id, name: names.get(id) ?? "Gone Co." })) };
    }
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>, network: "arc-testnet" | "arc-mainnet" = "arc-testnet") =>
    runWith(orgTestContext({ config: { ...config, network }, client: fake.client, orgId: ORG, userId: OWNER }), fn);
  return { fake, run };
}

let nextSeq = 5000;
/** The entries signed, as `appendLedgerEntry` got them; a `vendor_earned` or a loss joins the world's record. */
function signing(world: World, refuse: (entry: LedgerEntryInput) => boolean = () => false) {
  const signed: LedgerEntryInput[] = [];
  appendMock.mockImplementation(async (entry: LedgerEntryInput) => {
    if (refuse(entry)) throw new Error("ledger signing key not readable");
    signed.push(entry);
    const seq = (nextSeq += 1);
    if (entry.action === "vendor_earned" || entry.action === "vendor_earned_lost") {
      world.record.push({ seq, ts: at(40), action: entry.action, counterparty_id: entry.detail.counterpartyId as string });
    }
    if (entry.action === "earned_vendor_rule_changed") world.rules.push({ seq, from: entry.detail.from as number | null, to: entry.detail.to as number | null });
    if (entry.action === "earned_vendor_payments_changed") (world.switches ??= []).push({ seq, from: entry.detail.from as boolean, to: entry.detail.to as boolean });
    return { ...entry, seq, id: `e${seq}`, ts: at(40) };
  });
  return signed;
}

/** Northwind: five agreed payments, days 1-5; Lumen: two agreed, then a Disagree on day 8. */
function northwindEarned(rule: World["rule"]): World {
  return {
    rule,
    bills: [
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `inv-n${n}`, vendor: NORTHWIND, name: "Northwind Packaging" })),
      ...[1, 2, 3].map((n) => ({ id: `inv-l${n}`, vendor: LUMEN, name: "Lumen Print Co." })),
    ],
    decisions: [
      ...[1, 2, 3, 4, 5].map((n) => ({ seq: 100 + n, day: n, invoice: `inv-n${n}` })),
      { seq: 106, day: 6, invoice: "inv-l1" },
      { seq: 107, day: 7, invoice: "inv-l2" },
      { seq: 108, day: 8, invoice: "inv-l3", action: "ap_hold" },
    ],
    verdicts: [
      ...[1, 2, 3, 4, 5].map((n) => ({ seq: 100 + n, verdict: "agree" as const, day: n })),
      { seq: 106, verdict: "agree" as const, day: 6 },
      { seq: 107, verdict: "agree" as const, day: 7 },
      { seq: 108, verdict: "disagree" as const, day: 8 },
    ],
    record: [],
    rules: rule && rule !== "missing" && rule.earned_vendor_streak !== null ? [{ seq: 800, from: null, to: rule.earned_vendor_streak }] : [],
  };
}

const posts = (requests: RecordedRequest[]) => requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "POST");

beforeEach(() => {
  appendMock.mockReset();
  canSignMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reading the rule (AL11)", () => {
  it("is no rule for a workspace that never set one, and as stored once it did", async () => {
    expect(await workspace(northwindEarned(null)).run(() => readEarnedVendorRule(db()))).toEqual({ streak: null, payments: false, ready: true });
    const set = workspace(northwindEarned({ earned_vendor_streak: 8, earned_vendor_payments: false }));
    expect(await set.run(() => readEarnedVendorRule(db()))).toEqual({ streak: 8, payments: false, ready: true });
  });

  it("is no rule, and not available yet, before migration 0146; any other failure throws", async () => {
    expect(await workspace(northwindEarned("missing")).run(() => readEarnedVendorRule(db()))).toEqual({ streak: null, payments: false, ready: false });
    const schemaCache = fakeSupabase((r) => (r.path === "/rest/v1/approval_policies" ? { status: 400, body: { code: "PGRST204", message: "Could not find the column" } } : { body: [] }));
    const run = <T,>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
    expect(await run(schemaCache, () => readEarnedVendorRule(db()))).toMatchObject({ ready: false });
    const refused = fakeSupabase((r) => (r.path === "/rest/v1/approval_policies" ? { status: 401, body: { code: "42501", message: "permission denied" } } : { body: [] }));
    await expect(run(refused, () => readEarnedVendorRule(db()))).rejects.toThrow(/permission denied/);
  });
});

describe("changing it (AL11, AL17)", () => {
  it("writes the workspace's row and signs who changed it, from what, to what, after checking it can sign", async () => {
    const world = northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false });
    const signed = signing(world);
    const { fake, run } = workspace(world);
    canSignMock.mockImplementation(() => expect(posts(fake.requests)).toHaveLength(0));

    expect(await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 5 }))).toEqual({ from: null, to: 5 });

    expect(canSignMock).toHaveBeenCalledTimes(1);
    const [upsert] = posts(fake.requests);
    expect(upsert.params.get("on_conflict")).toBe("org_id");
    expect(upsert.body).toMatchObject({ org_id: ORG, earned_vendor_streak: 5, updated_by: OWNER });
    expect(upsert.body).not.toHaveProperty("earned_vendor_payments");
    expect(signed[0]).toEqual({
      actor: "human",
      domain: "system",
      action: "earned_vendor_rule_changed",
      summary: "Earned vendors: 5 agreed verdicts in a row",
      detail: { by: OWNER, from: null, to: 5 },
    });
    // Then the statuses under the new rule, signed in the same request (AL16).
    expect(signed.slice(1).map((entry) => [entry.action, entry.detail.counterpartyId, entry.detail.trigger])).toEqual([["vendor_earned", NORTHWIND, "rule"]]);
    for (const request of fake.requests.filter((r) => !r.path.startsWith("/rest/v1/rpc/"))) expect(carriesOrg(request, ORG), request.path).toBe(true);
  });

  it("turns the step 3 switch off with the rule, and signs each vendor recorded earned as lost, naming it", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    world.record.push({ seq: 900, ts: at(6), action: "vendor_earned", counterparty_id: NORTHWIND }, { seq: 901, ts: at(6), action: "vendor_earned_lost", counterparty_id: LUMEN });
    const signed = signing(world);
    const { fake, run } = workspace(world);

    expect(await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }))).toEqual({ from: 5, to: null });

    expect(posts(fake.requests)[0].body).toMatchObject({ earned_vendor_streak: null, earned_vendor_payments: false, updated_by: OWNER });
    expect(signed.map((entry) => entry.summary)).toEqual(["Earned vendors turned off", "Northwind Packaging is no longer an earned vendor: the rule is off"]);
    expect(signed[1]).toMatchObject({ actor: "system", domain: "compliance", action: "vendor_earned_lost", detail: { counterpartyId: NORTHWIND, streak: null, because: "rule_off", trigger: "rule" } });
    // With no rule, the facts are not read: only the record and the names.
    expect(fake.requests.some((r) => r.path === "/rest/v1/decision_verdicts")).toBe(false);
  });

  it("refuses a rule out of bounds, no change, Arc mainnet, a running cycle and a database without 0146, writing nothing", async () => {
    const off = () => workspace(northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false }));
    for (const streak of [4, 51, 7.5]) await expect(off().run(() => changeEarnedVendorRule({ actorId: OWNER, streak }))).rejects.toMatchObject({ code: "invalid" });
    await expect(workspace(northwindEarned({ earned_vendor_streak: 8, earned_vendor_payments: false })).run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }))).rejects.toMatchObject({
      code: "unchanged",
      message: "It is set to that already.",
    });
    await expect(off().run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }), "arc-mainnet")).rejects.toMatchObject({
      code: "mainnet",
      message: "Earned vendors are counted from your verdicts in shadow mode, which runs on Arc testnet.",
    });
    const running = workspace({ ...northwindEarned(null), cycleRunning: true });
    await expect(running.run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }))).rejects.toMatchObject({
      code: "cycle_running",
      message: "A cycle is running. Try again in a minute, once it has finished.",
    });
    expect(posts(running.fake.requests)).toHaveLength(0);
    await expect(workspace(northwindEarned("missing")).run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }))).rejects.toMatchObject({
      code: "not_ready",
      message: "Not available in this workspace yet.",
    });
    const raced = workspace({ ...northwindEarned(null), upsert: () => ({ status: 400, body: { code: "PGRST204", message: "Could not find the 'earned_vendor_streak' column" } }) });
    await expect(raced.run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }))).rejects.toBeInstanceOf(EarnedVendorsError);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("refuses before writing when the workspace cannot sign", async () => {
    canSignMock.mockImplementation(() => {
      throw new Error("no ledger key");
    });
    const { fake, run } = workspace(northwindEarned(null));
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 }))).rejects.toMatchObject({
      code: "not_signed",
      message: "The change could not be signed in the ledger, so nothing changed. Try again in a moment.",
    });
    expect(posts(fake.requests)).toHaveLength(0);
  });

  it("puts the rule back and refuses when its entry cannot be signed, so no rule is in force without its entry", async () => {
    const world = { ...northwindEarned({ earned_vendor_streak: 8, earned_vendor_payments: true }), switches: [{ seq: 810, from: false, to: true }] };
    signing(world, (entry) => entry.action === "earned_vendor_rule_changed");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }))).rejects.toMatchObject({ code: "not_signed" });
    expect(posts(fake.requests).map((r) => r.body)).toEqual([expect.objectContaining({ earned_vendor_streak: null, earned_vendor_payments: false })]);
    // Put back only from this change's own write, as the mirror address is: another owner's change since stays.
    const [back] = fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "PATCH");
    expect(back.params.get("earned_vendor_streak")).toBe("is.null");
    expect(back.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(back.body).toMatchObject({ earned_vendor_streak: 8, earned_vendor_payments: true });
    expect(world.rule).toMatchObject({ earned_vendor_streak: 8, earned_vendor_payments: true });
  });

  it("puts back only the rule after a change from one rule to another, so a switch another owner turned off since stays off", async () => {
    const world: World = { ...northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: true }), switches: [{ seq: 810, from: false, to: true }] };
    // Another owner turns the switch off, signed, between this change's write and its entry.
    world.upsert = (body) => {
      world.rule = { earned_vendor_streak: body.earned_vendor_streak as number, earned_vendor_payments: false };
      world.switches!.push({ seq: 811, from: true, to: false });
      return { status: 201, body: null };
    };
    signing(world, (entry) => entry.action === "earned_vendor_rule_changed");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 10 }))).rejects.toMatchObject({ code: "not_signed" });
    const [back] = fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "PATCH");
    expect(back.params.get("earned_vendor_streak")).toBe("eq.10");
    expect(back.body).toMatchObject({ earned_vendor_streak: 5 });
    expect(back.body).not.toHaveProperty("earned_vendor_payments");
    expect(world.rule).toMatchObject({ earned_vendor_streak: 5, earned_vendor_payments: false });
  });

  it("puts the switch back on with the rule only while the ledger still names it on", async () => {
    const world: World = { ...northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: true }), switches: [{ seq: 810, from: false, to: true }] };
    // The rule's turning off wrote the switch off; another owner then signed it off, before the rule's entry failed.
    world.upsert = (body) => {
      world.rule = { earned_vendor_streak: null, earned_vendor_payments: false };
      expect(body).toMatchObject({ earned_vendor_streak: null, earned_vendor_payments: false });
      world.switches!.push({ seq: 811, from: true, to: false });
      return { status: 201, body: null };
    };
    signing(world, (entry) => entry.action === "earned_vendor_rule_changed");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }))).rejects.toMatchObject({ code: "not_signed" });
    const [back] = fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "PATCH");
    expect(back.params.get("earned_vendor_streak")).toBe("is.null");
    expect(back.body).not.toHaveProperty("earned_vendor_payments");
    expect(world.rule).toMatchObject({ earned_vendor_streak: 5, earned_vendor_payments: false });
  });

  it("never says nothing changed when the rule could not be put back either: it fails as anything else does, and logs it", async () => {
    const refusedWrite = () => ({ status: 500, body: { code: "XX000", message: "database unavailable" } });
    const unreachable = (): FakeReply => {
      throw new Error("fetch failed");
    };
    for (const update of [refusedWrite, unreachable]) {
      const world = { ...northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false }), update };
      signing(world, (entry) => entry.action === "earned_vendor_rule_changed");
      const { run } = workspace(world);
      const refused = await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 8 })).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(EarnedVendorsError);
      expect(world.rule).toMatchObject({ earned_vendor_streak: 8 });
      expect(console.error).toHaveBeenCalledWith("earned vendors: rule not put back", ORG, expect.any(String));
    }
  });

  it("signs a rule left in force without its entry when an owner asks for it again, never refusing it as unchanged", async () => {
    const policyWrites = (requests: RecordedRequest[]) => requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method !== "GET").length;
    for (const [before, after] of [
      [null, 5],
      [5, null],
    ] as const) {
      const world: World = { ...northwindEarned({ earned_vendor_streak: before, earned_vendor_payments: false }), update: () => ({ status: 500, body: { code: "XX000", message: "database unavailable" } }) };
      let failing = true;
      const signed = signing(world, (entry) => failing && entry.action === "earned_vendor_rule_changed");
      const { fake, run } = workspace(world);

      // Neither signed nor put back: the new rule is in force, and the ledger still names the old one.
      const refused = await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: after })).catch((error: unknown) => error);
      expect(refused).not.toBeInstanceOf(EarnedVendorsError);
      expect(world.rule).toMatchObject({ earned_vendor_streak: after });
      expect(world.rules.map((rule) => rule.to)).toEqual(before === null ? [] : [before]);
      const writes = policyWrites(fake.requests);

      // Asked again while it still cannot sign: refused as not signed, and nothing is written.
      await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: after }))).rejects.toMatchObject({ code: "not_signed" });
      expect(policyWrites(fake.requests)).toBe(writes);

      // Asked again once it can: the missing entry is signed, from the rule the ledger last named, and nothing written.
      failing = false;
      world.update = undefined;
      expect(await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: after }))).toEqual({ from: before, to: after });
      expect(policyWrites(fake.requests)).toBe(writes);
      expect(signed.filter((entry) => entry.action === "earned_vendor_rule_changed")).toEqual([
        { actor: "human", domain: "system", action: "earned_vendor_rule_changed", summary: after === null ? "Earned vendors turned off" : "Earned vendors: 5 agreed verdicts in a row", detail: { by: OWNER, from: before, to: after } },
      ]);
      // Then the statuses under the rule now signed, as after any change (AL16).
      if (after === 5) expect(signed.at(-1)).toMatchObject({ action: "vendor_earned", detail: { counterpartyId: NORTHWIND, streak: 5, trigger: "rule" } });

      // Signed, the same value is unchanged.
      await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: after }))).rejects.toMatchObject({ code: "unchanged" });
    }
  });

  it("signs a turn-off left without its entry before the owner's next change, so the ledger's rules follow one another", async () => {
    const world: World = { ...northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false }), update: () => ({ status: 500, body: { code: "XX000", message: "database unavailable" } }) };
    let failing = true;
    signing(world, (entry) => failing && entry.action === "earned_vendor_rule_changed");
    const { run } = workspace(world);
    await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null })).catch(() => null);
    expect(world.rule).toMatchObject({ earned_vendor_streak: null });

    failing = false;
    world.update = undefined;
    expect(await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 10 }))).toEqual({ from: null, to: 10 });
    expect(world.rules.map((rule) => [rule.from, rule.to])).toEqual([
      [null, 5],
      [5, null],
      [null, 10],
    ]);
  });

  it("refuses a rule where there was none, writing nothing, while a loss owed from the time with no rule cannot be signed", async () => {
    const world = northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false });
    // Recorded earned under an earlier rule, whose turning off could not sign its loss, and it cannot be signed now.
    world.record.push({ seq: 900, ts: at(6), action: "vendor_earned", counterparty_id: NORTHWIND });
    const signed = signing(world, (entry) => entry.action === "vendor_earned_lost");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 5 }))).rejects.toMatchObject({
      code: "not_signed",
      message: "The change could not be signed in the ledger, so nothing changed. Try again in a moment.",
    });
    expect(posts(fake.requests)).toHaveLength(0);
    expect(signed).toEqual([]);

    // Nor when the record cannot be read, so whether a loss is owed is not known.
    const unknown: World = { ...northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false }), recordUnreadable: true };
    const none = signing(unknown);
    const unreadable = workspace(unknown);
    await expect(unreadable.run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 5 }))).rejects.toMatchObject({ code: "not_signed" });
    expect(posts(unreadable.fake.requests)).toHaveLength(0);
    expect(none).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("earned vendors: statuses not signed", ORG, expect.stringContaining("database unavailable"));
  });
});

describe("the owner's switch (AL21)", () => {
  const LIMIT = { daily_usdc: "2000", weekly_usdc: null };
  /** Northwind earned under a rule of 5, the switch as given, a spending limit, and the switch's signed entries. */
  const ruled = (payments: boolean, extra: Partial<World> = {}): World => ({
    ...northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: payments }),
    budget: LIMIT,
    switches: payments ? [{ seq: 810, from: false, to: true }] : [],
    ...extra,
  });

  it("turns it on: writes the workspace's row and signs who, from what, to what, after checking it can sign", async () => {
    const world = ruled(false);
    const signed = signing(world);
    const { fake, run } = workspace(world);
    canSignMock.mockImplementation(() => expect(posts(fake.requests)).toHaveLength(0));

    expect(await run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true }))).toEqual({ from: false, to: true });

    expect(canSignMock).toHaveBeenCalledTimes(1);
    // An update of the row that holds the rule, never an upsert, which Postgres refuses (see the fake above).
    expect(posts(fake.requests)).toHaveLength(0);
    const [write] = fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "PATCH");
    expect(write.params.get("earned_vendor_streak")).toBe("not.is.null");
    expect(write.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(write.body).toMatchObject({ earned_vendor_payments: true, updated_by: OWNER });
    expect(write.body).not.toHaveProperty("earned_vendor_streak");
    expect(signed).toEqual([
      {
        actor: "human",
        domain: "system",
        action: "earned_vendor_payments_changed",
        summary: "The agent pays earned vendors on its own in shadow mode",
        detail: { by: OWNER, from: false, to: true },
      },
    ]);
    expect(world.rule).toMatchObject({ earned_vendor_payments: true });
    for (const request of fake.requests.filter((r) => !r.path.startsWith("/rest/v1/rpc/"))) expect(carriesOrg(request, ORG), request.path).toBe(true);
  });

  it("turns it off without asking for a rule or a spending limit, and says so", async () => {
    const world = ruled(true, { budget: undefined });
    const signed = signing(world);
    const { run } = workspace(world);
    expect(await run(() => changeEarnedVendorPayments({ actorId: OWNER, on: false }))).toEqual({ from: true, to: false });
    expect(signed.map((entry) => [entry.summary, entry.detail])).toEqual([["Earned vendors' payments wait for a verdict again", { by: OWNER, from: true, to: false }]]);
  });

  it("refuses it on without a rule, without an agent spending limit, unchanged, on Arc mainnet, while a cycle runs and before 0146, writing nothing", async () => {
    const refusal = async (world: World, code: string, message: string, network: "arc-testnet" | "arc-mainnet" = "arc-testnet") => {
      const { fake, run } = workspace(world);
      await expect(run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true }), network)).rejects.toMatchObject({ code, message });
      expect(posts(fake.requests)).toHaveLength(0);
    };
    const noLimit = "Set the agent's spending limit first, in Settings: the agent's own payments always count against it.";
    await refusal({ ...ruled(false), rule: { earned_vendor_streak: null, earned_vendor_payments: false } }, "no_rule", "Set a rule first: how many agreed verdicts in a row a vendor needs.");
    await refusal(ruled(false, { budget: undefined }), "no_spending_limit", noLimit);
    await refusal(ruled(false, { budget: { daily_usdc: null, weekly_usdc: null } }), "no_spending_limit", noLimit);
    await refusal(ruled(true), "unchanged", "It is set to that already.");
    await refusal(ruled(false), "mainnet", "Earned vendors are counted from your verdicts in shadow mode, which runs on Arc testnet.", "arc-mainnet");
    await refusal(ruled(false, { cycleRunning: true }), "cycle_running", "A cycle is running. Try again in a minute, once it has finished.");
    await refusal({ ...ruled(false), rule: "missing" }, "not_ready", "Not available in this workspace yet.");
    canSignMock.mockImplementation(() => {
      throw new Error("no ledger key");
    });
    await refusal(ruled(false), "not_signed", "The change could not be signed in the ledger, so nothing changed. Try again in a moment.");
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("refuses it on, signing nothing, when the rule was taken away before the write", async () => {
    // Another owner turned the rule off between the read and the write: the guarded update changes no row.
    const world = ruled(false, { update: (body) => (body.earned_vendor_payments === true ? { body: [] } : null) });
    const signed = signing(world);
    const { run } = workspace(world);
    await expect(run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true }))).rejects.toMatchObject({ code: "no_rule" });
    expect(signed).toEqual([]);
    expect(world.rule).toMatchObject({ earned_vendor_payments: false });
  });

  it("puts the switch back and refuses when its entry cannot be signed, only from its own write", async () => {
    const world = ruled(false);
    signing(world, (entry) => entry.action === "earned_vendor_payments_changed");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true }))).rejects.toMatchObject({ code: "not_signed" });
    // The turning on, then its put-back.
    const [, back] = fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "PATCH");
    expect(back.params.get("earned_vendor_payments")).toBe("eq.true");
    expect(back.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(back.body).toMatchObject({ earned_vendor_payments: false });
    expect(world.rule).toMatchObject({ earned_vendor_payments: false });
  });

  it("never says nothing changed when the switch could not be put back either, and signs it when asked again", async () => {
    // The turning on is written; only its put-back, to off, cannot be.
    const world = ruled(false, { update: (body) => (body.earned_vendor_payments === false ? { status: 500, body: { code: "XX000", message: "database unavailable" } } : null) });
    let failing = true;
    const signed = signing(world, (entry) => failing && entry.action === "earned_vendor_payments_changed");
    const { run } = workspace(world);
    const refused = await run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true })).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(EarnedVendorsError);
    expect(world.rule).toMatchObject({ earned_vendor_payments: true });
    expect(console.error).toHaveBeenCalledWith("earned vendors: switch not put back", ORG, expect.any(String));

    // Asked for again once it can sign: the switch in force is signed, from what the ledger last named, and nothing written.
    failing = false;
    expect(await run(() => changeEarnedVendorPayments({ actorId: OWNER, on: true }))).toEqual({ from: false, to: true });
    expect(signed.map((entry) => entry.detail)).toEqual([{ by: OWNER, from: false, to: true }]);
  });

  it("is turned off with the rule, in the same write, and its entry signed after the rule's", async () => {
    const world = ruled(true);
    const signed = signing(world);
    const { fake, run } = workspace(world);
    expect(await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }))).toEqual({ from: 5, to: null });
    expect(posts(fake.requests)[0].body).toMatchObject({ earned_vendor_streak: null, earned_vendor_payments: false });
    expect(signed.slice(0, 2).map((entry) => [entry.action, entry.detail])).toEqual([
      ["earned_vendor_rule_changed", { by: OWNER, from: 5, to: null }],
      ["earned_vendor_payments_changed", { by: OWNER, from: true, to: false }],
    ]);
  });

  it("reads as off before 0146, and as stored after", async () => {
    expect(await workspace(ruled(true)).run(() => readEarnedVendorRule(db()))).toEqual({ streak: 5, payments: true, ready: true });
    expect(await workspace({ ...ruled(true), rule: "missing" }).run(() => readEarnedVendorRule(db()))).toEqual({ streak: null, payments: false, ready: false });
  });
});

describe("the sync (AL15, AL16)", () => {
  it("with no rule, reads only the rule and the record, and signs nothing while no vendor is recorded earned; before 0146, one read", async () => {
    for (const trigger of ["verdict", "cycle"] as const) {
      const world = northwindEarned(null);
      world.record.push({ seq: 901, ts: at(6), action: "vendor_earned_lost", counterparty_id: NORTHWIND });
      const signed = signing(world);
      const { fake, run } = workspace(world);
      expect(await run(() => syncEarnedVendors(db(), { trigger }))).toMatchObject({ streak: null, statuses: [], signed: [] });
      expect(fake.requests.map((r) => [r.path, r.params.get("action")])).toEqual([
        ["/rest/v1/approval_policies", null],
        ["/rest/v1/ledger_entries", "in.(vendor_earned,vendor_earned_lost)"],
      ]);
      expect(signed).toEqual([]);
    }
    const before = workspace(northwindEarned("missing"));
    expect(await before.run(() => syncEarnedVendors(db(), { trigger: "cycle" }))).toMatchObject({ streak: null, signed: [] });
    expect(before.fake.requests).toHaveLength(1);
  });

  it("with no rule, signs at the next verdict or cycle a loss the rule's turning off could not sign (AL15)", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    world.record.push({ seq: 900, ts: at(6), action: "vendor_earned", counterparty_id: NORTHWIND });
    let failing = true;
    const signed = signing(world, (entry) => failing && entry.action === "vendor_earned_lost");
    const { fake, run } = workspace(world);

    // The rule is off and signed, but Northwind's loss is not: it stays recorded earned, for now.
    await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }));
    expect(signed.map((entry) => entry.action)).toEqual(["earned_vendor_rule_changed"]);

    failing = false;
    const next = await run(() => syncEarnedVendors(db(), { trigger: "verdict" }));
    expect(signed.slice(1)).toEqual([
      {
        actor: "system",
        domain: "compliance",
        action: "vendor_earned_lost",
        summary: "Northwind Packaging is no longer an earned vendor: the rule is off",
        detail: { counterpartyId: NORTHWIND, streak: null, because: "rule_off", decisionSeq: null, rule: null, trigger: "verdict" },
      },
    ]);
    expect(next.recorded.get(NORTHWIND)?.state).toBe("lost");
    // With no rule, the facts are never read: only the rule, the record and the names a loss gives.
    expect(fake.requests.some((r) => r.path === "/rest/v1/decision_verdicts" || r.path === "/rest/v1/invoices")).toBe(false);

    await run(() => syncEarnedVendors(db(), { trigger: "cycle" }));
    expect(signed).toHaveLength(2);
  });

  it("signs a loss still owed from while the rule was off before a new rule is set, so no earned status spans a time with no rule", async () => {
    const world = northwindEarned({ earned_vendor_streak: null, earned_vendor_payments: false });
    // Recorded earned under an earlier rule, whose turning off could not sign its loss; it is earned under the new one.
    world.record.push({ seq: 900, ts: at(6), action: "vendor_earned", counterparty_id: NORTHWIND });
    const signed = signing(world);
    const { run } = workspace(world);

    await run(() => changeEarnedVendorRule({ actorId: OWNER, streak: 5 }));
    expect(signed.map((entry) => [entry.action, entry.detail.counterpartyId, entry.detail.because, entry.detail.streak])).toEqual([
      ["vendor_earned_lost", NORTHWIND, "rule_off", null],
      ["earned_vendor_rule_changed", undefined, undefined, undefined],
      ["vendor_earned", NORTHWIND, undefined, 5],
    ]);
  });

  it("signs a vendor that earned the rule once, with its evidence; a second sync in a row signs nothing", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    const signed = signing(world);
    const { fake, run } = workspace(world);

    const first = await run(() => syncEarnedVendors(db(), { trigger: "verdict" }));
    expect(signed).toEqual([
      {
        actor: "system",
        domain: "compliance",
        action: "vendor_earned",
        summary: "Northwind Packaging is an earned vendor: 5 agreed verdicts in a row on the agent's decisions to pay it",
        detail: { counterpartyId: NORTHWIND, streak: 5, agreed: 5, evidence: [105, 104, 103, 102, 101], from: at(1), to: at(5), since: null, trigger: "verdict" },
      },
    ]);
    expect(first.recorded.get(NORTHWIND)?.state).toBe("earned");
    expect(first.statuses.find((status) => status.vendorId === LUMEN)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "disagreed" } });

    await run(() => syncEarnedVendors(db(), { trigger: "cycle" }));
    expect(signed).toHaveLength(1);

    // What it read: the payees with their role, screening and payment limit, the agent's decisions, and each verdict's
    // time.
    const invoices = fake.requests.find((r) => r.path === "/rest/v1/invoices");
    expect(invoices?.params.get("select")).toContain("counterparties(id,name,sample,role,risk_level,payment_limit)");
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    expect(fake.requests.find((r) => r.path === "/rest/v1/decision_verdicts")?.params.get("select")).toBe("entry_seq,verdict,decided_at");
    const record = fake.requests.find((r) => r.params.get("action") === "in.(vendor_earned,vendor_earned_lost)");
    expect(record?.params.get("order")).toBe("seq.desc");
  });

  it("signs the loss with what broke it, the decision and the rule", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    world.record.push({ seq: 900, ts: at(5), action: "vendor_earned", counterparty_id: NORTHWIND });
    world.bills.push({ id: "inv-n6", vendor: NORTHWIND, name: "Northwind Packaging" });
    world.decisions.push({ seq: 109, day: 9, invoice: "inv-n6", rule: "invoice.pay_to_differs" });
    const signed = signing(world);
    await workspace(world).run(() => syncEarnedVendors(db(), { trigger: "cycle" }));
    expect(signed).toEqual([
      {
        actor: "system",
        domain: "compliance",
        action: "vendor_earned_lost",
        summary: "Northwind Packaging is no longer an earned vendor: a check in code stopped one of its bills",
        detail: { counterpartyId: NORTHWIND, streak: 5, because: "code_stop", decisionSeq: 109, rule: "invoice.pay_to_differs", trigger: "cycle" },
      },
    ]);
  });

  it("signs a vendor screened high risk as lost for that, never as one with no payment limit (AL13)", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    world.record.push({ seq: 900, ts: at(5), action: "vendor_earned", counterparty_id: NORTHWIND });
    // Screening keeps a high-risk payee's limit at 0, whatever limit the owner set.
    for (const bill of world.bills) if (bill.vendor === NORTHWIND) Object.assign(bill, { risk: "high", limit: "0" });
    const signed = signing(world);
    await workspace(world).run(() => syncEarnedVendors(db(), { trigger: "cycle" }));
    expect(signed).toEqual([
      expect.objectContaining({
        action: "vendor_earned_lost",
        summary: "Northwind Packaging is no longer an earned vendor: it is screened high risk",
        detail: expect.objectContaining({ counterpartyId: NORTHWIND, because: "high_risk", decisionSeq: null, rule: null }),
      }),
    ]);
  });

  it("leaves a vendor whose entry could not be signed as it was recorded, signs the others, and signs it at the next sync", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    // Lumen's two agreed payments come before its Disagree on a hold: it earns the rule with five after it.
    for (const n of [4, 5, 6, 7, 8]) {
      world.bills.push({ id: `inv-l${n}`, vendor: LUMEN, name: "Lumen Print Co." });
      world.decisions.push({ seq: 106 + n, day: 6 + n, invoice: `inv-l${n}` });
      world.verdicts.push({ seq: 106 + n, verdict: "agree", day: 6 + n });
    }
    let failing = true;
    const signed = signing(world, (entry) => failing && entry.detail.counterpartyId === NORTHWIND);
    const { run } = workspace(world);

    const first = await run(() => syncEarnedVendors(db(), { trigger: "cycle" }));
    expect(signed.map((entry) => entry.detail.counterpartyId)).toEqual([LUMEN]);
    expect(first.recorded.has(NORTHWIND)).toBe(false);
    expect(first.recorded.get(LUMEN)?.state).toBe("earned");

    failing = false;
    await run(() => syncEarnedVendors(db(), { trigger: "verdict" }));
    expect(signed.map((entry) => entry.detail.counterpartyId)).toEqual([LUMEN, NORTHWIND]);
  });

  it("counts as waiting only a payment made on its own whose bill is paid or on its way and that no person paid after (AL26)", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: true });
    world.record.push({ seq: 900, ts: at(5), action: "vendor_earned", counterparty_id: NORTHWIND });
    // On its way; failed and held for a person; paid again by a person; only recorded by a person's Approve and pay.
    for (const [n, status] of [[6, "matched"], [7, "held"], [8, "paid"], [9, "matched"]] as const) {
      world.bills.push({ id: `inv-n${n}`, vendor: NORTHWIND, name: "Northwind Packaging", status });
      world.decisions.push({ seq: 200 + n, day: 9 + n, invoice: `inv-n${n}`, status: "matched", earned: true });
    }
    world.payments = [
      { seq: 220, invoice: "inv-n8" },
      { seq: 221, invoice: "inv-n9", recorded: true },
    ];
    signing(world);
    const { fake, run } = workspace(world);

    const sync = await run(() => syncEarnedVendors(db(), { trigger: "cycle", shadow: { startedAt: at(0) } }));
    expect(sync.statuses.find((status) => status.vendorId === NORTHWIND)).toMatchObject({ state: "earned", waiting: 2, paused: false });
    // What it read for that: each bill's status, and a person's payments of the bills with whether each only recorded one.
    expect(fake.requests.find((r) => r.path === "/rest/v1/invoices")?.params.get("select")).toContain("status");
    const payments = fake.requests.find((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("actor") === "eq.human");
    expect(payments?.params.get("action")).toBe("eq.approval_paid");
    expect(payments?.params.get("select")).toContain("recorded:detail->recorded");
  });
});

describe("the report's view (AL18)", () => {
  it("is the rule, every vendor's status from the report's facts, and the vendors recorded earned; none before 0146", async () => {
    const world = northwindEarned({ earned_vendor_streak: 5, earned_vendor_payments: false });
    world.record.push({ seq: 900, ts: at(5), action: "vendor_earned", counterparty_id: NORTHWIND }, { seq: 899, ts: at(4), action: "vendor_earned", counterparty_id: LUMEN }, { seq: 901, ts: at(9), action: "vendor_earned_lost", counterparty_id: LUMEN });
    const facts = {
      bills: [{ id: "inv-n1", amount: 120, currency: "USDC", payee: { id: NORTHWIND, name: "Northwind Packaging", sample: false, role: "vendor", paymentLimit: 500 } }],
      decisions: [{ seq: 101, ts: at(1), action: "ap_pay", invoiceId: "inv-n1", guardrailBlocked: false, guardrailRule: null, resultingStatus: "held" }],
      verdicts: [{ entrySeq: 101, verdict: "agree" as const, decidedAt: at(1) }],
    };
    const { fake, run } = workspace(world);
    const view = await run(() => readEarnedView(db(), facts));
    expect(view?.streak).toBe(5);
    expect(view?.statuses).toEqual([expect.objectContaining({ vendorId: NORTHWIND, state: "counting", agreed: 1, needed: 5 })]);
    expect([...(view?.recorded ?? [])]).toEqual([NORTHWIND]);
    // The facts are the report's: nothing else is read but the rule and the record.
    expect(fake.requests.some((r) => r.path === "/rest/v1/invoices" || r.path === "/rest/v1/decision_verdicts")).toBe(false);

    expect(await workspace(northwindEarned("missing")).run(() => readEarnedView(db(), facts))).toBeNull();
    const none = await workspace(northwindEarned(null)).run(() => readEarnedView(db(), facts));
    expect(none).toEqual({ streak: null, statuses: [], recorded: new Set() });
  });
});
