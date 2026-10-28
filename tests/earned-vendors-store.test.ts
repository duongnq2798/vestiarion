import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendMock, canSignMock } = vi.hoisted(() => ({ appendMock: vi.fn(), canSignMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: appendMock, assertLedgerCanSign: canSignMock }));

import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { changeEarnedVendorRule, EarnedVendorsError, readEarnedVendorRule, readEarnedView, syncEarnedVendors } from "@/lib/earned-vendors-store";
import type { LedgerEntryInput } from "@/lib/ledger";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Earned vendors, read, changed and signed (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL15-AL17):
 * the rule read as none and not ready before migration 0146; an owner's change, refused on Arc mainnet, while a cycle
 * runs, unchanged or out of bounds, written to the workspace's row and signed strictly, and put back when it cannot be
 * signed; and the sync, which signs only what changed since each vendor's newest signed status, stops at one read with
 * no rule, and leaves a vendor whose entry failed as it was recorded, for the next sync to sign.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000e4e4e";
const OWNER = "a1b2c3d4-0000-4000-8000-0000000e4e01";
const NORTHWIND = "c0c0c0c0-0000-4000-8000-00000000a001";
const LUMEN = "c0c0c0c0-0000-4000-8000-00000000a002";

const at = (day: number) => new Date(Date.parse("2026-10-01T09:00:00.000Z") + day * 86_400_000).toISOString();

interface World {
  rule: { earned_vendor_streak: number | null; earned_vendor_payments: boolean } | null | "missing";
  cycleRunning?: boolean;
  upsert?: (body: Record<string, unknown>) => FakeReply | null;
  bills: Array<{ id: string; vendor: string; name: string; limit?: string | null }>;
  decisions: Array<{ seq: number; day: number; invoice: string; action?: string; rule?: string; status?: string }>;
  verdicts: Array<{ seq: number; verdict: "agree" | "disagree"; day: number }>;
  record: Array<{ seq: number; ts: string; action: string; counterparty_id: string }>;
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
      const current = world.rule && world.rule !== "missing" ? world.rule : { earned_vendor_streak: null, earned_vendor_payments: false };
      world.rule = { ...current, ...(body as Partial<typeof current>) };
      return { status: 201, body: null };
    }
    if (path === "/rest/v1/cycle_runs") return { body: world.cycleRunning ? [{ id: "run-1" }] : [] };
    if (path === "/rest/v1/invoices") {
      return {
        body: world.bills.map((bill) => ({
          id: bill.id,
          amount: "120.000000",
          currency: "USDC",
          counterparties: { id: bill.vendor, name: bill.name, sample: false, role: "vendor", payment_limit: bill.limit === undefined ? "500" : bill.limit },
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
        })),
      };
    }
    if (path === "/rest/v1/ledger_entries" && params.get("action") === "in.(vendor_earned,vendor_earned_lost)") {
      return { body: [...world.record].sort((a, b) => b.seq - a.seq) };
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
    const world = northwindEarned({ earned_vendor_streak: 8, earned_vendor_payments: true });
    signing(world, (entry) => entry.action === "earned_vendor_rule_changed");
    const { fake, run } = workspace(world);
    await expect(run(() => changeEarnedVendorRule({ actorId: OWNER, streak: null }))).rejects.toMatchObject({ code: "not_signed" });
    const writes = posts(fake.requests).map((r) => r.body);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ earned_vendor_streak: null, earned_vendor_payments: false });
    expect(writes[1]).toMatchObject({ earned_vendor_streak: 8, earned_vendor_payments: true });
    expect(world.rule).toMatchObject({ earned_vendor_streak: 8, earned_vendor_payments: true });
  });
});

describe("the sync (AL15, AL16)", () => {
  it("with no rule, reads the rule and stops: one read after a verdict or as a cycle starts", async () => {
    for (const trigger of ["verdict", "cycle"] as const) {
      const { fake, run } = workspace(northwindEarned(null));
      expect(await run(() => syncEarnedVendors(db(), { trigger }))).toMatchObject({ streak: null, statuses: [], signed: [] });
      expect(fake.requests.map((r) => r.path)).toEqual(["/rest/v1/approval_policies"]);
    }
    const before = workspace(northwindEarned("missing"));
    expect(await before.run(() => syncEarnedVendors(db(), { trigger: "cycle" }))).toMatchObject({ streak: null, signed: [] });
    expect(before.fake.requests).toHaveLength(1);
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

    // What it read: the payees with their role and payment limit, the agent's decisions, and each verdict's time.
    const invoices = fake.requests.find((r) => r.path === "/rest/v1/invoices");
    expect(invoices?.params.get("select")).toContain("counterparties(id,name,sample,role,payment_limit)");
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
