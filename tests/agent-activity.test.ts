import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  activityAmount,
  activityItem,
  activityItems,
  nextPollMs,
  workingLabel,
  type ActivityEntry,
  type ActivityRefs,
} from "@/lib/agent-activity";
import { readAgentActivity } from "@/lib/agent-activity-read";
import { counterpartyPath, ruleNextStep } from "@/lib/next-step";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Agent activity (spec 2026-10-03-agent-activity-design): what the agent just did, in words, as a page that is open
 * reads it every few seconds; and what a person can do about a payable code stopped.
 */

const INVOICE = "3755e7fa-e2e1-4803-9be3-c26604af5b3f";
const MILESTONE = "6b1f3a2e-8c1b-4f7a-9e6d-0000000000aa";
const TX = `0x${"79".repeat(32)}`;

const refs = (invoice: Partial<{ status: string; txRef: string | null; scheduledFor: string | null; currency: string }> = {}): ActivityRefs => ({
  invoices: new Map([[INVOICE, { name: "Jiren", amount: 0.3, currency: "USDC", status: "paid", txRef: TX, scheduledFor: null, ...invoice }]]),
  milestones: new Map([[MILESTONE, { name: "Puka Hotel", title: "Landing page", amount: 1, txRef: TX }]]),
});
const entry = (action: string, detail: Record<string, unknown>, seq = 972): ActivityEntry => ({ seq, action, detail: { invoiceId: INVOICE, ...detail } });

describe("what the agent did, in words", () => {
  it("says a payment, with its transaction and where to see it", () => {
    expect(activityItem(entry("ap_pay", { execution: { txRef: TX, resultingStatus: "paid" } }), refs())).toEqual({
      seq: 972,
      text: "Paid Jiren 0.30 USDC.",
      tone: "done",
      path: "/invoices",
      pathLabel: "AP / AR",
      txHash: TX,
    });
  });

  it("says a payment still confirming, and one that did not go out", () => {
    expect(activityItem(entry("ap_pay", { execution: { txRef: TX, resultingStatus: "matched" } }), refs())?.text).toBe(
      "Sent 0.30 USDC to Jiren; Arc testnet is confirming it."
    );
    const held = activityItem(entry("ap_pay", { execution: { txRef: null, resultingStatus: "held" } }), refs({ status: "held" }));
    expect(held).toMatchObject({ text: "Tried to pay Jiren 0.30 USDC; it is held for you.", tone: "stopped", path: `/approvals#payable-${INVOICE}`, txHash: null });
  });

  it("names a refusal by code and its rule, and sends the person to Approvals", () => {
    const refused = activityItem(entry("ap_pay", { guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap" }), refs({ status: "held" }));
    expect(refused).toMatchObject({
      text: "Code stopped paying Jiren 0.30 USDC (bridge.fee_above_cap).",
      tone: "stopped",
      path: `/approvals#payable-${INVOICE}`,
      pathLabel: "Decide in Approvals",
    });
  });

  it("says a schedule with its day, and each kind of stop", () => {
    expect(activityItem(entry("ap_schedule", { decision: { action: "schedule", payOn: "2026-10-05" } }), refs({ status: "scheduled" }))?.text).toBe(
      "Scheduled Jiren 0.30 USDC for Oct 5."
    );
    expect(activityItem(entry("ap_hold", {}), refs({ status: "held" }))).toMatchObject({ text: "Held Jiren 0.30 USDC for you.", tone: "stopped" });
    expect(activityItem(entry("ap_request_info", {}), refs({ status: "awaiting_info" }))).toMatchObject({
      text: "Asked for details before paying Jiren 0.30 USDC.",
      tone: "stopped",
      path: "/invoices",
      pathLabel: "Add details",
    });
    expect(activityItem(entry("ap_flag_fraud", {}), refs({ status: "flagged" }))?.text).toBe("Flagged Jiren 0.30 USDC for you to review.");
  });

  it("says milestones and money received", () => {
    const milestone = (action: string, detail: Record<string, unknown> = {}) => ({ seq: 5, action, detail: { milestoneId: MILESTONE, ...detail } });
    expect(activityItem(milestone("milestone_release", { execution: { txRef: TX } }), refs())).toMatchObject({
      text: "Released 1.00 USDC for Landing page to Puka Hotel.",
      tone: "done",
      txHash: TX,
    });
    expect(activityItem(milestone("milestone_hold"), refs())).toMatchObject({ text: "Held 1.00 USDC for Landing page from Puka Hotel for you.", tone: "stopped", path: "/contractors" });
    expect(activityItem(entry("ar_received", { txHash: TX }), refs({ status: "received" }))).toMatchObject({ text: "Received 0.30 USDC from Jiren.", tone: "done", txHash: TX });
  });

  it("tells nothing of a treasury hold, of an entry whose record is gone, or of a simulated transaction", () => {
    expect(activityItem({ seq: 1, action: "hold", detail: {} }, refs())).toBeNull();
    expect(activityItem(entry("ap_pay", { invoiceId: "gone" }), refs())).toBeNull();
    expect(activityItem(entry("ap_pay", { execution: { txRef: "sim_44bd8923", resultingStatus: "paid" } }), refs({ txRef: "sim_44bd8923" }))?.txHash).toBeNull();
  });

  it("writes amounts as the app does, in the invoice's own token", () => {
    expect(activityAmount(1250, "USDC")).toBe("1,250.00 USDC");
    expect(activityAmount(0.123074, "USDC")).toBe("0.123074 USDC");
    expect(activityItem(entry("ap_pay", {}), refs({ currency: "EURC" }))?.text).toBe("Paid Jiren 0.30 EURC.");
  });

  it("keeps the order things happened in", () => {
    const items = activityItems([entry("ap_pay", {}, 9), entry("ap_hold", {}, 7)], refs());
    expect(items.map((item) => item.seq)).toEqual([7, 9]);
  });
});

describe("how often an open page asks", () => {
  it("asks every 3 s while the agent works or is about to, every 20 s otherwise", () => {
    expect(nextPollMs({ running: true, expectingUntil: 0, now: 10 })).toBe(3_000);
    expect(nextPollMs({ running: false, expectingUntil: 100, now: 10 })).toBe(3_000);
    expect(nextPollMs({ running: false, expectingUntil: 5, now: 10 })).toBe(20_000);
  });

  it("counts the seconds a cycle has run", () => {
    expect(workingLabel("2026-10-03T02:20:30Z", Date.parse("2026-10-03T02:20:42Z"))).toBe("The agent is working · 12 s");
  });
});

describe("what to do about a payable code stopped", () => {
  const counterparty = { id: "cp-1", name: "CME" };

  it("links the page that removes the cause, for the rules a person can change", () => {
    expect(ruleNextStep("counterparty.payment_limit", counterparty)).toEqual({
      sentence: "It is above CME's payment limit. Pay it in Approvals, or raise the limit.",
      fix: { label: "Edit limit", path: counterpartyPath("cp-1") },
    });
    expect(ruleNextStep("counterparty.address_unconfirmed", counterparty)?.fix).toEqual({ label: "Confirm address", path: "/counterparties#counterparty-cp-1" });
    // "Not this person" is on the counterparty's row.
    expect(ruleNextStep("counterparty.high_risk", counterparty)?.fix).toEqual({ label: "Review screening", path: "/counterparties#counterparty-cp-1" });
    expect(ruleNextStep("workspace.outflow_budget", counterparty)?.fix).toEqual({ label: "Spending limit", path: "/console#agent-budget" });
    expect(ruleNextStep("workspace.onchain_limit", counterparty)?.fix?.path).toBe("/console#agent-budget");
  });

  it("sends the rest to Approvals, saying why", () => {
    expect(ruleNextStep("bridge.fee_above_cap", counterparty)).toEqual({
      sentence: "The payout fee is above 10% of the invoice, more than the agent pays. Pay it with the fee in Approvals, or reject it.",
      fix: null,
    });
    for (const rule of ["invoice.duplicate_of_settled", "workspace.onchain_limit_route", "bridge.fee_unavailable", "bridge.unsupported_token", "fx.rate_unavailable"]) {
      expect(ruleNextStep(rule, counterparty)?.fix, rule).toBeNull();
    }
  });

  it("has a next step for every rule code holds by", () => {
    const rules = [
      "bridge.fee_above_cap", "bridge.fee_unavailable", "bridge.gateway_balance_short", "bridge.unsupported_token",
      "counterparty.address_unconfirmed", "counterparty.high_risk", "counterparty.payment_limit", "counterparty.unscreened",
      "fx.rate_unavailable", "fx.swap_cost_above_cap", "fx.swap_usdc_short", "invoice.duplicate_of_settled",
      "treasury.insufficient_eurc", "workspace.onchain_limit", "workspace.onchain_limit_route", "workspace.outflow_budget",
    ];
    for (const rule of rules) expect(ruleNextStep(rule, counterparty), rule).not.toBeNull();
    expect(ruleNextStep(null, counterparty)).toBeNull();
    expect(ruleNextStep("something.new", counterparty)).toBeNull();
  });
});

describe("reading the agent's activity", () => {
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const NOW = Date.parse("2026-10-03T02:20:45Z");

  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  function fake(newEntries: Array<Record<string, unknown>> = []) {
    return fakeSupabase((request: RecordedRequest) => {
      const select = request.params.get("select") ?? "";
      if (request.path === "/rest/v1/cycle_runs") return { body: [{ started_at: "2026-10-03T02:20:30Z" }] };
      if (request.path === "/rest/v1/ledger_entries" && select === "seq") return { body: [{ seq: 974 }] };
      if (request.path === "/rest/v1/ledger_entries" && select === "ts") return { body: [{ ts: "2026-10-03T02:00:08Z" }] };
      if (request.path === "/rest/v1/ledger_entries") return { body: newEntries };
      if (request.path === "/rest/v1/invoices") {
        return { body: [{ id: INVOICE, amount: "0.300000", currency: "USDC", status: "paid", tx_ref: TX, scheduled_for: null, counterparties: { name: "Jiren" } }] };
      }
      return { body: [] };
    });
  }
  const read = (client: ReturnType<typeof fakeSupabase>, since: number | null) =>
    runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () => readAgentActivity(since, NOW));

  it("says a cycle is running, where the ledger is, and when the last cycle completed, telling nothing to a page that has just opened", async () => {
    const client = fake();
    const activity = await read(client, null);
    expect(activity).toEqual({ running: { startedAt: "2026-10-03T02:20:30Z" }, head: 974, lastCycleAt: "2026-10-03T02:00:08Z", items: [] });
    const run = client.requests.find((r) => r.path === "/rest/v1/cycle_runs")!;
    expect(run.params.get("status")).toBe("eq.running");
    expect(run.params.get("started_at")).toMatch(/^gt\./);
    // Nothing new to read: no entries asked for.
    expect(client.requests.filter((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("select") === "seq,action,detail")).toHaveLength(0);
  });

  it("reads the agent's decisions after what the page has seen, and says them", async () => {
    const client = fake([{ seq: 972, action: "ap_pay", detail: { invoiceId: INVOICE, execution: { txRef: TX, resultingStatus: "paid" } } }]);
    const activity = await read(client, 967);
    expect(activity.items).toEqual([{ seq: 972, text: "Paid Jiren 0.30 USDC.", tone: "done", path: "/invoices", pathLabel: "AP / AR", txHash: TX }]);
    const asked = client.requests.find((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("select") === "seq,action,detail")!;
    expect(asked.params.get("actor")).toBe("eq.agent");
    expect(asked.params.get("seq")).toBe("gt.967");
    expect(asked.params.get("action")).toContain("ap_pay");
    expect(asked.params.get("action")).not.toContain("cycle_complete");
  });

  it("reads nothing more when the page has seen the head", async () => {
    const client = fake();
    expect((await read(client, 974)).items).toEqual([]);
    expect(client.requests.some((r) => r.path === "/rest/v1/invoices")).toBe(false);
  });
});
