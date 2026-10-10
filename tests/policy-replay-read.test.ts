import { beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { MAX_REPLAY_PAGES, replayForApply, RuleReplayError, ruleReplay } from "@/lib/policy-replay-read";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The server side of trying a rule (docs/superpowers/specs/2026-10-10-policy-replay-design.md §4): the candidate read
 * with the setting's own parser, the figures in force, the window's agent decisions in pages, and names for what
 * changed. Against a real supabase-js client whose network is a recorder, inside an organization scope.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const NORTHWIND = "018f8ce0-1557-7b54-a931-4d777f6bca31";
const KESTREL = "018f8ce0-1557-7b54-a931-4d777f6bca32";
const NOW = new Date("2026-10-10T12:00:00.000Z");

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);

function decision(seq: number, options: { action: string; counterpartyId: string; amount: number; ts: string; rule?: string | null; sourceId: string }) {
  const rule = options.rule ?? null;
  const bill = options.action.startsWith("ap_");
  const paid = rule === null && (options.action === "ap_pay" || options.action === "milestone_release");
  return {
    seq,
    ts: options.ts,
    action: options.action,
    detail: {
      ...(bill ? { invoiceId: options.sourceId, currency: "USDC", amountPaid: paid ? options.amount : null } : { milestoneId: options.sourceId }),
      counterpartyId: options.counterpartyId,
      decision: { action: options.action.replace(/^(ap|milestone)_/, "") },
      guardrailBlocked: rule !== null,
      guardrailRule: rule,
      observed: { amount: options.amount, paymentLimit: 500, riskLevel: "clear" },
      execution: { chainMode: "simulate", resultingStatus: paid ? "paid" : "held" },
    },
  };
}

const ENTRIES = [
  decision(11, { action: "ap_pay", counterpartyId: NORTHWIND, amount: 300, ts: "2026-10-08T09:00:00.000Z", sourceId: "inv-1" }),
  decision(12, { action: "ap_pay", counterpartyId: NORTHWIND, amount: 50, ts: "2026-10-08T10:00:00.000Z", sourceId: "inv-2" }),
  decision(13, { action: "milestone_release", counterpartyId: KESTREL, amount: 150, ts: "2026-10-09T09:00:00.000Z", sourceId: "ms-1" }),
  decision(14, { action: "ap_pay", counterpartyId: NORTHWIND, amount: 700, ts: "2026-10-09T10:00:00.000Z", rule: "counterparty.payment_limit", sourceId: "inv-3" }),
];

function workspace(over: { entries?: (request: RecordedRequest) => unknown[]; policy?: unknown[]; budget?: unknown[] } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/counterparties") {
      return {
        body: [
          { id: NORTHWIND, name: "Northwind Trading", role: "vendor", baseline_payment_limit: "500.000000" },
          { id: KESTREL, name: "Kestrel Design", role: "contractor", baseline_payment_limit: "200.000000" },
        ],
      };
    }
    if (r.path === "/rest/v1/approval_policies") return { body: over.policy ?? [] };
    if (r.path === "/rest/v1/agent_budgets") return { body: over.budget ?? [] };
    if (r.path === "/rest/v1/ledger_entries") return { body: over.entries ? over.entries(r) : r.params.get("seq") === "gt.0" ? ENTRIES : [] };
    if (r.path === "/rest/v1/invoices") return { body: [{ id: "inv-1", memo: "Office chairs" }, { id: "inv-3", memo: "Warehouse racking" }] };
    if (r.path === "/rest/v1/milestones") return { body: [{ id: "ms-1", title: "Brand refresh" }] };
    return { body: [] };
  };
}

const ledgerReads = () => fake.requests.filter((r) => r.path === "/rest/v1/ledger_entries");

beforeEach(() => {
  fake = fakeSupabase(workspace());
});

describe("ruleReplay for a counterparty's payment limit", () => {
  it("replays the window's agent decisions with the candidate and names what changes", async () => {
    const view = await run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "200" }, days: 30 }, NOW));

    expect(view.setting).toBe("Northwind Trading's payment limit");
    expect(view.from).toBe("500.00 USDC");
    expect(view.to).toBe("200.00 USDC");
    expect(view.windowDays).toBe(30);
    expect(view.windowFrom).toBe("2026-09-10T12:00:00.000Z");
    expect(view.windowTo).toBe("2026-10-10T12:00:00.000Z");
    expect(view.counts).toEqual({ decisions: 4, unchanged: 3, nowHeld: 1, nowPaid: 0, nowTwoPeople: 0, cantTell: 0 });
    expect(view.rows).toEqual([
      {
        seq: 11,
        date: "2026-10-08",
        source: "bill",
        bill: "Office chairs",
        counterparty: "Northwind Trading",
        amount: 300,
        currency: "USDC",
        change: "now_held",
        before: "The agent pays it",
        after: "Held: above the payment limit",
      },
    ]);
    expect(view.more).toBe(0);
    // What Apply posts back: the window, and the limit in force when it ran.
    expect(view.apply).toEqual({ replayDays: "30", expectedLimit: "500" });
  });

  it("reads only the agent's decisions, from the six days before the window on, in ledger order, scoped to the workspace", async () => {
    await run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "200" }, days: 30 }, NOW));
    const read = ledgerReads()[0];
    expect(read.params.get("actor")).toBe("eq.agent");
    expect(read.params.get("action")).toBe("in.(ap_pay,ap_schedule,ap_hold,ap_flag_fraud,ap_request_info,milestone_release,milestone_hold)");
    expect(read.params.get("ts")).toBe("gte.2026-09-04T00:00:00.000Z");
    expect(read.params.get("order")).toBe("seq.asc");
    expect(read.params.get("limit")).toBe("1000");
    for (const request of fake.requests) expect(carriesOrg(request, ORG), request.path).toBe(true);
  });

  it("lists a bill a higher limit would now let the agent pay, by its memo", async () => {
    const view = await run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "800" }, days: 90 }, NOW));
    expect(view.windowFrom).toBe("2026-07-12T12:00:00.000Z");
    expect(view.rows.map((row) => [row.bill, row.change, row.before, row.after])).toEqual([
      ["Warehouse racking", "now_paid", "Held: above the payment limit", "The agent pays it"],
    ]);
    expect(view.apply).toEqual({ replayDays: "90", expectedLimit: "500" });
  });

  it("refuses a limit the form would refuse, the limit already in force, and a counterparty not in the workspace", async () => {
    await expect(run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "abc" }, days: 30 }, NOW))).rejects.toThrow(RuleReplayError);
    await expect(run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "500" }, days: 30 }, NOW))).rejects.toThrow(
      "That is already this counterparty's limit."
    );
    await expect(run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "" }, days: 30 }, NOW))).rejects.toThrow(
      "A vendor or contractor needs a payment limit"
    );
    await expect(run(() => ruleReplay({ rule: "counterparty_limit", counterpartyId: "018f8ce0-1557-7b54-a931-4d777f6bca99", values: { paymentLimit: "5" }, days: 30 }, NOW))).rejects.toThrow(
      "Counterparty not found."
    );
  });
});

describe("ruleReplay for two approvals and the spending limit", () => {
  it("tries a figure for two approvals and counts the bills it would put before two people", async () => {
    const view = await run(() => ruleReplay({ rule: "two_approvals", values: { above: "100" }, days: 30 }, NOW));
    expect(view.setting).toBe("Two approvals above a figure");
    expect(view.from).toBe("Off");
    expect(view.to).toBe("Above 100.00 USDC");
    expect(view.counts.nowTwoPeople).toBe(2);
    expect(view.rows.map((row) => [row.bill, row.source, row.after])).toEqual([
      ["Office chairs", "bill", "Held: needs two people's approval"],
      ["Brand refresh", "milestone", "Held: needs two people's approval"],
    ]);
    expect(view.apply).toEqual({ replayDays: "30", expectedAbove: "" });
  });

  it("refuses the figure already in force for two approvals", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100.000000" }] }));
    await expect(run(() => ruleReplay({ rule: "two_approvals", values: { above: "100" }, days: 30 }, NOW))).rejects.toThrow("Payments above 100 USDC already need two approvals.");
  });

  it("tries the agent's spending limit, its running totals in recorded order", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "1000.000000", weekly_usdc: null }] }));
    const view = await run(() => ruleReplay({ rule: "spending_limit", values: { daily: "320", weekly: "" }, days: 30 }, NOW));
    expect(view.setting).toBe("Agent spending limit");
    expect(view.from).toBe("1,000.00 USDC a day, no 7-day limit");
    expect(view.to).toBe("320.00 USDC a day, no 7-day limit");
    // Oct 8: 300, then 50 would make 350.
    expect(view.rows.map((row) => [row.seq, row.change])).toEqual([[12, "now_held"]]);
    expect(view.apply).toEqual({ replayDays: "30", expectedDaily: "1000", expectedWeekly: "" });
  });

  it("refuses a spending limit the form would refuse", async () => {
    await expect(run(() => ruleReplay({ rule: "spending_limit", values: { daily: "100", weekly: "50" }, days: 30 }, NOW))).rejects.toThrow(
      "The 7-day limit cannot be lower than the daily limit."
    );
  });
});

describe("reading the window", () => {
  it("reads the ledger in pages of 1,000, after the last entry read", async () => {
    const page = (from: number) => Array.from({ length: 1000 }, (_, i) => ({ ...ENTRIES[1], seq: from + i, detail: { ...ENTRIES[1].detail, invoiceId: `inv-p${from + i}` } }));
    fake = fakeSupabase(
      workspace({
        entries: (r) => (r.params.get("seq") === "gt.0" ? page(1) : r.params.get("seq") === "gt.1000" ? [ENTRIES[0]].map((entry) => ({ ...entry, seq: 1001 })) : []),
      })
    );
    const view = await run(() => ruleReplay({ rule: "two_approvals", values: { above: "100" }, days: 30 }, NOW));
    expect(ledgerReads().map((r) => r.params.get("seq"))).toEqual(["gt.0", "gt.1000"]);
    expect(view.counts.decisions).toBe(1001);
  });

  it("refuses a window with more decisions than it replays", async () => {
    let next = 1;
    fake = fakeSupabase(
      workspace({
        entries: () => {
          const rows = Array.from({ length: 1000 }, (_, i) => ({ seq: next + i, ts: "2026-10-08T09:00:00.000Z", action: "ap_hold", detail: {} }));
          next += 1000;
          return rows;
        },
      })
    );
    await expect(run(() => ruleReplay({ rule: "two_approvals", values: { above: "100" }, days: 90 }, NOW))).rejects.toThrow(
      "This window holds too many decisions to try at once. Try the last 30 days."
    );
    expect(ledgerReads()).toHaveLength(MAX_REPLAY_PAGES);
  });

  it("caps the list at 100 decisions and says how many more changed", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ ...ENTRIES[0], seq: 100 + i, detail: { ...ENTRIES[0].detail, invoiceId: `inv-m${i}` } }));
    fake = fakeSupabase(workspace({ entries: (r) => (r.params.get("seq") === "gt.0" ? many : []) }));
    const view = await run(() => ruleReplay({ rule: "two_approvals", values: { above: "100" }, days: 30 }, NOW));
    expect(view.counts.nowTwoPeople).toBe(130);
    expect(view.rows).toHaveLength(100);
    expect(view.more).toBe(30);
    // An invoice whose row is gone is named by its kind.
    expect(view.rows[1].bill).toBe("Invoice");
  });
});

describe("replayForApply", () => {
  it("is the replay's summary, for the change's signed entry", async () => {
    const summary = await run(() => replayForApply({ rule: "counterparty_limit", counterpartyId: NORTHWIND, values: { paymentLimit: "200" }, days: 30 }, NOW));
    expect(summary).toEqual({
      windowDays: 30,
      from: "2026-09-10T12:00:00.000Z",
      to: "2026-10-10T12:00:00.000Z",
      decisions: 4,
      unchanged: 3,
      nowHeld: 1,
      nowPaid: 0,
      nowTwoPeople: 0,
      cantTell: 0,
    });
    // It names nothing: no invoice or milestone is read for a summary.
    expect(fake.requests.some((r) => r.path === "/rest/v1/invoices" || r.path === "/rest/v1/milestones")).toBe(false);
  });
});
