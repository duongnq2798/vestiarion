import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  ACTIVITY_ACTIONS,
  activityAmount,
  activityItem,
  activityItems,
  afterTrigger,
  nextPollMs,
  workingLabel,
  type ActivityEntry,
  type ActivityRefs,
} from "@/lib/agent-activity";
import { readAgentActivity } from "@/lib/agent-activity-read";
import { agentResumes, CASH_SHORTFALL, counterpartyPath, heldForCash, ruleInBrief, ruleNextStep } from "@/lib/next-step";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Agent activity (spec 2026-10-03-agent-activity-design): what the agent just did, in words, as a page that is open
 * reads it every few seconds; and what a person can do about a payable code stopped.
 */

const INVOICE = "3755e7fa-e2e1-4803-9be3-c26604af5b3f";
const MILESTONE = "6b1f3a2e-8c1b-4f7a-9e6d-0000000000aa";
const TX = `0x${"79".repeat(32)}`;

const refs = (invoice: Partial<{ status: string; txRef: string | null; scheduledFor: string | null; currency: string }> = {}): ActivityRefs => ({
  network: "arc-testnet",
  invoices: new Map([[INVOICE, { name: "Jiren", amount: 0.3, currency: "USDC", status: "paid", txRef: TX, scheduledFor: null, ...invoice }]]),
  milestones: new Map([[MILESTONE, { name: "Puka Hotel", title: "Landing page", amount: 1, txRef: TX }]]),
});
const entry = (action: string, detail: Record<string, unknown>, seq = 972): ActivityEntry => ({ seq, action, detail: { invoiceId: INVOICE, ...detail } });

describe("what the agent did, in words", () => {
  it("says a payment, who decided it and what was checked, with its transaction and how it was decided", () => {
    const paid = entry("ap_pay", {
      decisionMode: "deepseek",
      agreedWithReference: true,
      observed: { riskLevel: "clear", paymentLimit: 30, poReference: "PO-131", goodsReceived: true },
      onChainLimit: { verdict: { state: "allowed" } },
      execution: { txRef: TX, resultingStatus: "paid" },
    });
    expect(activityItem(paid, refs())).toEqual({
      seq: 972,
      text: "Paid Jiren 0.30 USDC.",
      detail: "DeepSeek decided, as the written policy would. Checks passed: purchase order and goods, the 30.00 USDC limit, screening, the spending-limit contract.",
      tone: "done",
      path: `/invoices#trail-${INVOICE}`,
      pathLabel: "How it decided",
      txHash: TX,
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
      network: "arc-testnet",
    });
  });

  it("says the goods were checked, with no purchase order needed, for a counterparty paid without them (three-way match design M4)", () => {
    const paid = entry("ap_pay", {
      decisionMode: "deepseek",
      agreedWithReference: true,
      observed: { riskLevel: "clear", paymentLimit: 30, poReference: null, goodsReceived: true, purchaseOrderRequired: false },
      execution: { txRef: TX, resultingStatus: "paid" },
    });
    expect(activityItem(paid, refs())?.detail).toBe(
      "DeepSeek decided, as the written policy would. Checks passed: goods received, with no purchase order needed, the 30.00 USDC limit, screening."
    );
  });

  it("says what came back when the agent decided a payable again because a fresh quote cleared what held it (FX re-evaluation F6)", () => {
    const decidedAgain = (trigger: string) =>
      activityItem(
        entry("ap_pay", { reevaluation: { reopenedSeq: 971, trigger, previousDecisionSeq: 965, previousAction: "hold" }, execution: { txRef: TX, resultingStatus: "paid" } }),
        refs({ currency: "EURC" })
      )?.text;
    expect(decidedAgain("rate_available")).toBe("Paid Jiren 0.30 EURC · decided again once a EURC rate was quoted.");
    expect(decidedAgain("swap_available")).toBe("Paid Jiren 0.30 EURC · decided again once a USDC→EURC swap was quoted.");
    expect(decidedAgain("swap_cost_within_cap")).toBe("Paid Jiren 0.30 EURC · decided again once a swap cost within its cap.");
    expect(decidedAgain("value_within_limit")).toBe("Paid Jiren 0.30 EURC · decided again once the rate brought it within the limit.");
  });

  it("says how long after the person's action the agent decided", () => {
    const paid = { ...entry("ap_pay", { execution: { txRef: TX, resultingStatus: "paid" } }), ts: "2026-10-03T02:20:53Z" };
    const withTriggers = (action: string, ts: string) => ({ ...refs(), triggers: new Map([[INVOICE, [{ seq: 968, ts, action }]]]) });
    expect(activityItem(paid, withTriggers("invoice_details_added", "2026-10-03T02:20:25Z"))?.text).toBe("Paid Jiren 0.30 USDC · 28 s after details were added.");
    expect(activityItem(paid, withTriggers("create_invoice", "2026-10-03T02:15:53Z"))?.text).toBe("Paid Jiren 0.30 USDC · 5 min after it was added.");
    // More than an hour later is not news of speed; neither is an action after the decision.
    expect(activityItem(paid, withTriggers("create_invoice", "2026-10-03T00:00:00Z"))?.text).toBe("Paid Jiren 0.30 USDC.");
    expect(afterTrigger(paid, [{ seq: 990, ts: "2026-10-03T02:30:00Z", action: "approval_returned" }])).toBe("");
  });

  it("names the workspace's network: Arc mainnet is confirming a payment there, and its item says so (mainnet copy C1)", () => {
    const sent = activityItem(entry("ap_pay", { execution: { txRef: TX, resultingStatus: "matched" } }), { ...refs(), network: "arc-mainnet" });
    expect(sent?.text).toBe("Sent 0.30 USDC to Jiren; Arc mainnet is confirming it.");
    expect(sent?.network).toBe("arc-mainnet");
    expect(sent?.txUrl).toBe(`https://explorer.arc.io/tx/${TX}`);
  });

  it("says a payment still confirming, and one that did not go out", () => {
    expect(activityItem(entry("ap_pay", { execution: { txRef: TX, resultingStatus: "matched" } }), refs())?.text).toBe(
      "Sent 0.30 USDC to Jiren; Arc testnet is confirming it."
    );
    const held = activityItem(entry("ap_pay", { execution: { txRef: null, resultingStatus: "held" } }), refs({ status: "held" }));
    expect(held).toMatchObject({ text: "Tried to pay Jiren 0.30 USDC; it is held for you.", tone: "stopped", path: `/approvals#payable-${INVOICE}`, txHash: null });
  });

  it("says a refusal by code, why and the way through, and sends the person to Approvals", () => {
    const refused = activityItem(
      entry("ap_pay", { decisionMode: "deepseek", agreedWithReference: false, guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap" }),
      refs({ status: "held" })
    );
    expect(refused).toMatchObject({
      text: "Code stopped paying Jiren 0.30 USDC.",
      detail: "DeepSeek decided to pay it; code stopped it: the payout fee is above 10% of the invoice.",
      tone: "stopped",
      path: `/approvals#payable-${INVOICE}`,
      pathLabel: "Decide in Approvals",
    });
  });

  it("says why it stopped, from the first sentence of the model's reasoning", () => {
    const asked = entry("ap_request_info", {
      decision: { action: "request_info", reasoning: "There is no purchase order on file, so the three-way match is incomplete. Please provide it before I pay." },
    });
    expect(activityItem(asked, refs({ status: "awaiting_info" }))?.detail).toBe("There is no purchase order on file, so the three-way match is incomplete.");
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

  it("says a reminder it sent a client, with who decided (collections R8)", () => {
    expect(activityItem(entry("ar_reminder_sent", { tone: "firm", decisionMode: "deepseek", agreedWithReference: true }), refs())).toMatchObject({
      text: "Reminded Jiren by email of 0.30 USDC (firm).",
      detail: "DeepSeek decided, as the written policy would.",
      tone: "done",
      pathLabel: "How it decided",
    });
    expect(activityItem(entry("ar_reminder_sent", { tone: "final" }), refs())?.text).toBe("Reminded Jiren by email of 0.30 USDC, a final reminder.");
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

describe("a code stop, in a few words", () => {
  it("says why in one sentence, for every rule code holds by", () => {
    const budget = activityItem(
      entry("ap_pay", { decisionMode: "deepseek", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget" }),
      refs({ status: "held" })
    );
    expect(budget?.detail).toBe("DeepSeek decided to pay it; code stopped it: the agent's spending limit has no room today, and the agent pays it once there is.");
    const rules = [
      "bridge.fee_above_cap", "bridge.fee_unavailable", "bridge.gateway_balance_short", "bridge.unsupported_token",
      "counterparty.address_unconfirmed", "counterparty.client_payable", "counterparty.high_risk", "counterparty.payment_limit", "counterparty.unscreened",
      "fx.rate_unavailable", "fx.swap_cost_above_cap", "fx.swap_usdc_short", "invoice.duplicate_of_settled", "invoice.match_incomplete", "counterparty.new_payee",
      "treasury.insufficient_eurc", "workspace.onchain_limit", "workspace.onchain_limit_route", "workspace.outflow_budget", "workspace.two_approvals",
    ];
    for (const rule of rules) {
      expect(ruleInBrief(rule), rule).not.toBeNull();
      expect(ruleInBrief(rule), rule).not.toMatch(/^rule /);
    }
    expect(ruleInBrief("something.new")).toBe("rule something.new");
    expect(ruleInBrief(null)).toBeNull();
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

  it("asks for what an incomplete three-way match lacks, or for the counterparty to be marked paid without purchase orders (three-way match design M7)", () => {
    expect(ruleNextStep("invoice.match_incomplete", counterparty)).toEqual({
      sentence:
        "Its three-way match is incomplete. Add the purchase order or confirm the goods with Add details, and the agent decides it again; or mark CME as paid without purchase orders, if it is.",
      fix: { label: "Purchase orders", path: counterpartyPath("cp-1") },
    });
    expect(ruleInBrief("invoice.match_incomplete")).toBe("its three-way match is incomplete");
    expect(agentResumes("invoice.match_incomplete")).toBe(
      "The agent decides it again on its own once an owner or admin adds what the match lacks, or marks the counterparty as paid without purchase orders."
    );
  });

  it("sends the first payment to an address one person alone stands behind to someone else, in Approvals (new payee check N3)", () => {
    expect(ruleNextStep("counterparty.new_payee", counterparty)).toEqual({
      sentence:
        "It is the first payment to CME's address, and only one person stands behind it. Someone other than whoever gave the address approves it in Approvals; after that, the agent pays this address on its own.",
      fix: null,
    });
    expect(ruleInBrief("counterparty.new_payee")).toBe("it would be the first payment to an address only one person stands behind");
    expect(agentResumes("counterparty.new_payee")).toBe("The agent decides it again on its own once another payment to this address goes through.");
  });

  it("sends a payment above the figure for two approvals to two people, in Approvals (two approvals T3)", () => {
    expect(ruleNextStep("workspace.two_approvals", counterparty)).toEqual({
      sentence:
        "Payments above the workspace's figure need two people's approval. Two people who can approve payments approve it in Approvals: the first approval is recorded, and the second pays it.",
      fix: null,
    });
    expect(ruleInBrief("workspace.two_approvals")).toBe("payments above the workspace's figure need two people's approval");
    expect(agentResumes("workspace.two_approvals")).toBe(
      "The agent decides it again on its own if an owner raises the figure for two approvals to its amount or more, or turns it off."
    );
  });

  it("explains a hold for want of cash, says the agent resumes once cash comes in, and links the reserve (reserve cash back R4)", () => {
    expect(ruleNextStep(CASH_SHORTFALL, counterparty)).toEqual({
      sentence:
        "The operating wallet did not hold the cash it needs, and the reserve could not cover it. The agent decides it again on its own once cash comes in: add USDC to the operating wallet, or bring cash back from the USYC reserve; or pay it in Approvals.",
      fix: { label: "USYC reserve", path: "/settings#usyc-reserve-title" },
    });
    expect(agentResumes(CASH_SHORTFALL)).toBe("The agent decides it again on its own once cash comes in: USDC added to the operating wallet, or brought back from the reserve.");
  });

  it("tells a hold for want of cash from a decision's ledger detail, never one a guardrail refused", () => {
    expect(heldForCash({ execution: { resultingStatus: "held", heldBecause: "cash_shortfall", cashNeededUsdc: 0.35 } })).toBe(true);
    expect(heldForCash({ guardrailBlocked: true, execution: { heldBecause: "cash_shortfall" } })).toBe(false);
    expect(heldForCash({ execution: { heldBecause: "outflow_budget" } })).toBe(false);
    expect(heldForCash({ execution: null })).toBe(false);
    expect(heldForCash(undefined)).toBe(false);
  });

  it("has a next step for every rule code holds by", () => {
    const rules = [
      "bridge.fee_above_cap", "bridge.fee_unavailable", "bridge.gateway_balance_short", "bridge.unsupported_token",
      "counterparty.address_unconfirmed", "counterparty.client_payable", "counterparty.high_risk", "counterparty.payment_limit", "counterparty.unscreened",
      "fx.rate_unavailable", "fx.swap_cost_above_cap", "fx.swap_usdc_short", "invoice.duplicate_of_settled",
      "treasury.insufficient_eurc", "workspace.onchain_limit", "workspace.onchain_limit_route", "workspace.outflow_budget", "workspace.two_approvals",
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
      if (request.path === "/rest/v1/ledger_entries" && select.includes("invoiceId")) {
        return { body: [{ seq: 968, ts: "2026-10-03T02:20:25Z", action: "invoice_details_added", invoiceId: INVOICE }] };
      }
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
    expect(activity).toEqual({ running: { startedAt: "2026-10-03T02:20:30Z" }, head: 974, lastCycleAt: "2026-10-03T02:00:08Z", items: [], through: 974 });
    const run = client.requests.find((r) => r.path === "/rest/v1/cycle_runs")!;
    expect(run.params.get("status")).toBe("eq.running");
    expect(run.params.get("started_at")).toMatch(/^gt\./);
    // Nothing new to read: no entries asked for.
    expect(client.requests.filter((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("select") === "seq,ts,action,detail")).toHaveLength(0);
  });

  it("reads the agent's decisions after what the page has seen, and says them", async () => {
    const client = fake([{ seq: 972, ts: "2026-10-03T02:20:53Z", action: "ap_pay", detail: { invoiceId: INVOICE, execution: { txRef: TX, resultingStatus: "paid" } } }]);
    const activity = await read(client, 967);
    expect(activity.items).toEqual([
      { seq: 972, text: "Paid Jiren 0.30 USDC · 28 s after details were added.", detail: null, tone: "done", path: `/invoices#trail-${INVOICE}`, pathLabel: "How it decided", txHash: TX, txUrl: `https://explorer.testnet.arc.io/tx/${TX}`, network: "arc-testnet" },
    ]);
    const triggers = client.requests.find((r) => r.path === "/rest/v1/ledger_entries" && (r.params.get("select") ?? "").includes("invoiceId"))!;
    expect(triggers.params.get("actor")).toBe("eq.human");
    expect(triggers.params.get("action")).toBe("in.(create_invoice,invoice_details_added,approval_returned)");
    const asked = client.requests.find((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("select") === "seq,ts,action,detail")!;
    expect(asked.params.get("actor")).toBe("eq.agent");
    expect(asked.params.get("seq")).toBe("gt.967");
    expect(asked.params.get("action")).toContain("ap_pay");
    expect(asked.params.get("action")).not.toContain("cycle_complete");
  });

  it("has read through the head when fewer entries than a page came back, so entries that say nothing are passed over", async () => {
    const client = fake([{ seq: 972, ts: "2026-10-03T02:20:53Z", action: "ap_pay", detail: { invoiceId: INVOICE, execution: { txRef: TX, resultingStatus: "paid" } } }]);
    expect((await read(client, 967)).through).toBe(974);
  });

  it("has read only through the last entry when a full page came back, as more may follow it", async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ seq: 950 + index, ts: "2026-10-03T02:20:53Z", action: "ap_pay", detail: { invoiceId: "gone" } }));
    expect((await read(fake(page), 949)).through).toBe(969);
  });

  it("reads nothing more when the page has seen the head", async () => {
    const client = fake();
    expect((await read(client, 974)).through).toBe(974);
    expect((await read(client, 974)).items).toEqual([]);
    expect(client.requests.some((r) => r.path === "/rest/v1/invoices")).toBe(false);
  });
});

describe("a payment that has not confirmed (stuck-transfer alert D6, D7)", () => {
  const stuck = (detail: Record<string, unknown> = {}) =>
    entry("payment_stuck", { amount: 0.3, currency: "USDC", minutes: 18, circleAsked: true, sendAnswered: true, providerState: "STUCK", txHash: TX, network: "arc-testnet", ...detail }, 990);

  it("is one of the actions a person is told about as it happens", () => {
    expect(ACTIVITY_ACTIONS).toContain("payment_stuck");
  });

  it("tells it as stopped, with Circle's state and the transaction, and no card to approve", () => {
    const item = activityItem(stuck(), refs());
    expect(item).toMatchObject({
      seq: 990,
      text: "Payment of 0.30 USDC to Jiren has not confirmed 18 min after it was sent on Arc testnet.",
      detail: "Circle shows it stuck.",
      tone: "stopped",
      path: `/invoices#trail-${INVOICE}`,
      pathLabel: "How it decided",
      txHash: TX,
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
    });
    expect(item).not.toHaveProperty("invoiceId");
  });

  it("names Arc mainnet for a workspace there, and says what Circle said, or that it was not asked or never answered", () => {
    expect(activityItem(stuck({ circleAsked: false, providerState: null }), { ...refs(), network: "arc-mainnet" })).toMatchObject({
      text: "Payment of 0.30 USDC to Jiren has not confirmed 18 min after it was sent on Arc mainnet.",
      detail: "Circle could not be asked just now.",
    });
    expect(activityItem(stuck({ circleAsked: false, sendAnswered: false, providerState: null, txHash: null }), refs())).toMatchObject({
      detail: "Circle never answered the send.",
      txHash: null,
      txUrl: null,
    });
    expect(activityItem(stuck({ providerState: "SENT" }), refs())?.detail).toBe("Circle shows it as SENT.");
  });

  it("tells a milestone's on Contractors", () => {
    const milestone: ActivityEntry = {
      seq: 991,
      action: "payment_stuck",
      detail: { milestoneId: MILESTONE, amount: 1, currency: "USDC", minutes: 16, circleAsked: true, sendAnswered: true, providerState: "QUEUED", txHash: null, network: "arc-testnet" },
    };
    expect(activityItem(milestone, refs())).toMatchObject({
      text: "Payment of 1.00 USDC to Puka Hotel has not confirmed 16 min after it was sent on Arc testnet.",
      detail: "Circle shows it as QUEUED.",
      tone: "stopped",
      path: "/contractors",
      pathLabel: "Contractors",
    });
  });

  it("says nothing of a payment whose invoice is gone", () => {
    expect(activityItem(stuck({ invoiceId: "00000000-0000-4000-8000-000000000000" }), refs())).toBeNull();
  });
});
