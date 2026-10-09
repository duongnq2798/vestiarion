import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { readReportFacts } from "@/lib/workspace-report-read";
import { buildReport, type ReportBill, type ReportDecision, type ReportFacts, type ReportPayment, type ReportPersonAction } from "@/lib/workspace-report";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

const OPENED = "2026-10-01T00:00:00.000Z";

function bill(id: string, over: Partial<ReportBill> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-02T10:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false },
    ...over,
  };
}

function decision(seq: number, invoiceId: string, over: Partial<ReportDecision> = {}): ReportDecision {
  return {
    seq,
    ts: "2026-10-02T10:01:00.000Z",
    action: "ap_pay",
    invoiceId,
    guardrailBlocked: false,
    guardrailRule: null,
    heldBecause: null,
    resultingStatus: "paid",
    shadow: false,
    reasoning: "Pay it. The bill matches the order.",
    ...over,
  };
}

function payment(invoiceId: string, over: Partial<ReportPayment> = {}): ReportPayment {
  return { invoiceId, amount: 100, token: "USDC", txHash: `0x${"a".repeat(64)}`, at: "2026-10-02T10:02:00.000Z", ...over };
}

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return { network: "arc-testnet", openedAt: OPENED, shadow: null, bills: [], decisions: [], personActions: [], verdicts: [], payments: [], ...over };
}

describe("buildReport", () => {
  it("leaves sample bills, and everything about them, out of every figure", () => {
    const report = buildReport(
      facts({
        bills: [bill("real"), bill("sample", { payee: { id: "s", name: "Sample Co", mirror: false, sample: true } })],
        decisions: [decision(1, "real"), decision(2, "sample")],
        payments: [payment("real"), payment("sample")],
      })
    );
    expect(report.bills.handled).toBe(1);
    expect(report.bills.decided).toBe(1);
    expect(report.paid.count).toBe(1);
    expect(report.paymentList.map((row) => row.payee)).toEqual(["Payee real"]);
  });

  it("measures the median minutes from a bill being added to its first decision", () => {
    const report = buildReport(
      facts({
        bills: [bill("a"), bill("b"), bill("c")],
        decisions: [
          decision(1, "a", { ts: "2026-10-02T10:01:00.000Z" }),
          decision(2, "a", { ts: "2026-10-02T12:00:00.000Z" }),
          decision(3, "b", { ts: "2026-10-02T10:03:00.000Z" }),
          decision(4, "c", { ts: "2026-10-02T10:10:00.000Z" }),
        ],
      })
    );
    expect(report.bills.decided).toBe(3);
    expect(report.bills.medianMinutesToDecision).toBe(3);
  });

  it("has no median when no bill was decided", () => {
    expect(buildReport(facts({ bills: [bill("a")] })).bills.medianMinutesToDecision).toBeNull();
  });

  it("sums payments per currency and counts the ones made on or before the due day", () => {
    const report = buildReport(
      facts({
        bills: [bill("a"), bill("b", { dueDate: "2026-10-02T00:00:00.000Z" }), bill("c", { currency: "EURC", amount: 5 })],
        decisions: [decision(1, "a"), decision(2, "b"), decision(3, "c")],
        payments: [
          payment("a", { amount: 100, at: "2026-10-10T23:00:00.000Z" }),
          payment("b", { amount: 40, at: "2026-10-03T00:30:00.000Z" }),
          payment("c", { amount: 5, token: "EURC" }),
        ],
      })
    );
    expect(report.paid.count).toBe(3);
    expect(report.paid.byCurrency).toEqual([
      { currency: "USDC", amount: 140 },
      { currency: "EURC", amount: 5 },
    ]);
    expect(report.paid.onTime).toBe(2);
  });

  it("splits stopped bills into code's refusals, waits and the agent's own calls, and never counts a hold for a verdict", () => {
    const report = buildReport(
      facts({
        bills: [bill("code"), bill("cash"), bill("agent"), bill("verdict"), bill("paid")],
        decisions: [
          decision(1, "code", { action: "ap_hold", resultingStatus: "held", guardrailBlocked: true, guardrailRule: "counterparty.payment_limit" }),
          decision(2, "cash", { resultingStatus: "held", heldBecause: "cash_shortfall" }),
          decision(3, "agent", { action: "ap_flag_fraud", resultingStatus: "flagged", reasoning: "The bank details changed. Ask first." }),
          decision(4, "verdict", { resultingStatus: "held", heldBecause: "shadow_verdict", shadow: true }),
          decision(5, "paid"),
        ],
      })
    );
    expect(report.stopped).toEqual({ total: 3, byCode: 1, waited: 1, byAgent: 1, notSent: 0 });
    const why = Object.fromEntries(report.stoppedList.map((row) => [row.payee, row.why]));
    expect(why["Payee code"]).toBe("Code refused it: it is above the counterparty's payment limit.");
    expect(why["Payee cash"]).toBe("The operating wallet was short of cash for it.");
    expect(why["Payee agent"]).toBe("The agent's call: The bank details changed.");
    expect(report.stoppedList.find((row) => row.payee === "Payee verdict")).toBeUndefined();
  });

  it("counts a spending-limit hold as a wait, though code set it, and a transfer that did not go through apart from the agent's calls", () => {
    const report = buildReport(
      facts({
        bills: [bill("budget"), bill("failed"), bill("schedule")],
        decisions: [
          decision(1, "budget", { resultingStatus: "held", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget", heldBecause: "outflow_budget" }),
          decision(2, "failed", { action: "ap_pay", resultingStatus: "held", reasoning: "Pay it. The bill matches the order." }),
          decision(3, "schedule", { action: "ap_schedule", resultingStatus: "scheduled" }),
        ],
      })
    );
    expect(report.stopped).toEqual({ total: 2, byCode: 0, waited: 1, byAgent: 0, notSent: 1 });
    const why = Object.fromEntries(report.stoppedList.map((row) => [row.payee, row.why]));
    expect(why["Payee budget"]).toBe("It would have passed the workspace's spending limit.");
    expect(why["Payee failed"]).toBe("The agent decided to pay, and the transfer did not go through.");
  });

  it("takes what a paid bill's transfer carried from the bill, so a resend at the full amount shows no discount", () => {
    const terms = { pct: 2, deadline: "2026-10-05T00:00:00.000Z" };
    const report = buildReport(
      facts({
        bills: [bill("resent", { amount: 100, discount: terms, paidAmount: 100 }), bill("taken", { amount: 100, discount: terms, paidAmount: 98 })],
        decisions: [decision(1, "resent"), decision(2, "taken")],
        // The intent kept the discounted amount of a first try that failed; the resend carried the full amount.
        payments: [payment("resent", { amount: 98 }), payment("taken", { amount: 98 })],
      })
    );
    expect(report.paid.byCurrency).toEqual([{ currency: "USDC", amount: 198 }]);
    expect(report.discounts.captured).toEqual({ count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] });
    expect(report.paymentList.find((row) => row.payee === "Payee resent")?.amount).toBe(100);
  });

  it("counts verdicts on real bills only", () => {
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: "2026-10-02T00:00:00.000Z" },
        bills: [bill("real"), bill("sample", { payee: { id: "s", name: "Sample Co", mirror: false, sample: true } })],
        decisions: [decision(1, "real", { shadow: true }), decision(2, "sample", { shadow: true })],
        verdicts: [
          { entrySeq: 1, verdict: "agree" },
          { entrySeq: 2, verdict: "disagree" },
        ],
      })
    );
    expect(report.verdicts).toEqual({ agreed: 1, disagreed: 0, waiting: 0 });
  });

  it("credits a person, not a verdict, for paying a bill after agreeing that the agent should hold it", () => {
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: "2026-10-02T00:00:00.000Z" },
        bills: [bill("held", { status: "paid" })],
        decisions: [decision(1, "held", { action: "ap_hold", resultingStatus: "held", shadow: true })],
        personActions: [{ seq: 3, ts: "2026-10-02T11:00:00.000Z", action: "approval_paid", invoiceId: "held" }],
        verdicts: [{ entrySeq: 1, verdict: "agree" }],
        payments: [payment("held")],
      })
    );
    expect(report.paymentList[0].decidedBy).toBe("person");
  });

  it("says a stopped bill whose transfer is in flight is being paid", () => {
    const report = buildReport(
      facts({
        bills: [bill("flight", { status: "matched" })],
        decisions: [decision(1, "flight", { resultingStatus: "held", heldBecause: "cash_shortfall" })],
      })
    );
    expect(report.stoppedList[0].since).toBe("paying");
  });

  it("says what happened to a stopped bill since", () => {
    const report = buildReport(
      facts({
        bills: [bill("later", { status: "paid", reviewedBy: "user-1" }), bill("rejected", { status: "rejected" }), bill("open", { status: "held" })],
        decisions: [
          decision(1, "later", { resultingStatus: "held", guardrailBlocked: true, guardrailRule: "counterparty.new_payee" }),
          decision(2, "rejected", { action: "ap_hold", resultingStatus: "held", guardrailBlocked: true, guardrailRule: "invoice.duplicate_of_settled" }),
          decision(3, "open", { action: "ap_request_info", resultingStatus: "awaiting_info", reasoning: null }),
        ],
        personActions: [
          { seq: 4, ts: "2026-10-03T00:00:00.000Z", action: "approval_paid", invoiceId: "later" },
          { seq: 5, ts: "2026-10-03T00:00:00.000Z", action: "approval_rejected", invoiceId: "rejected" },
        ],
        payments: [payment("later")],
      })
    );
    const since = Object.fromEntries(report.stoppedList.map((row) => [row.payee, row.since]));
    expect(since).toEqual({ "Payee later": "paid", "Payee rejected": "rejected", "Payee open": "open" });
    expect(report.stoppedList.find((row) => row.payee === "Payee open")?.why).toBe("The agent's call: it asked for more information.");
  });

  it("counts a person stepping in, but not a payment a person agreed to in shadow mode", () => {
    const shadowStart = "2026-10-02T00:00:00.000Z";
    const actions: ReportPersonAction[] = [
      { seq: 2, ts: "2026-10-02T11:00:00.000Z", action: "approval_paid", invoiceId: "held" },
      { seq: 4, ts: "2026-10-02T11:00:00.000Z", action: "approval_paid", invoiceId: "agreed" },
    ];
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: shadowStart },
        bills: [bill("held"), bill("agreed"), bill("alone")],
        decisions: [
          decision(1, "held", { resultingStatus: "held", guardrailBlocked: true, guardrailRule: "counterparty.new_payee", shadow: true }),
          decision(3, "agreed", { resultingStatus: "held", heldBecause: "shadow_verdict", shadow: true }),
          decision(5, "alone", { shadow: false, ts: "2026-10-02T09:00:00.000Z" }),
        ],
        personActions: actions,
        verdicts: [
          { entrySeq: 1, verdict: "agree" },
          { entrySeq: 3, verdict: "agree" },
        ],
        payments: [payment("held"), payment("agreed"), payment("alone")],
      })
    );
    expect(report.people.steppedIn).toBe(1);
    expect(report.paid.untouched).toBe(1);
    const who = Object.fromEntries(report.paymentList.map((row) => [row.payee, row.decidedBy]));
    expect(who).toEqual({ "Payee held": "verdict", "Payee agreed": "verdict", "Payee alone": "agent" });
  });

  it("tags a payment as a shadow mirror when its decision was made in shadow mode, has a verdict, or came while shadow mode was on", () => {
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: "2026-10-05T00:00:00.000Z" },
        bills: [
          bill("flagged"),
          bill("verdict"),
          bill("after", { createdAt: "2026-10-06T00:00:00.000Z" }),
          bill("before"),
        ],
        decisions: [
          decision(1, "flagged", { shadow: true }),
          decision(2, "verdict"),
          decision(3, "after", { ts: "2026-10-06T00:01:00.000Z" }),
          decision(4, "before", { ts: "2026-10-02T10:01:00.000Z" }),
        ],
        verdicts: [{ entrySeq: 2, verdict: "agree" }],
        payments: [
          payment("flagged"),
          payment("verdict"),
          payment("after", { at: "2026-10-06T00:02:00.000Z" }),
          payment("before", { at: "2026-10-02T10:02:00.000Z" }),
        ],
      })
    );
    const mirror = Object.fromEntries(report.paymentList.map((row) => [row.payee, row.mirror]));
    expect(mirror).toEqual({ "Payee flagged": true, "Payee verdict": true, "Payee after": true, "Payee before": false });
    expect(report.paid.mirrored).toBe(3);
  });

  it("measures the discount captured from the transfer, and estimates the one on offer from the terms", () => {
    const terms = { pct: 2, deadline: "2026-10-05T00:00:00.000Z" };
    const report = buildReport(
      facts({
        bills: [
          bill("taken", { amount: 200, discount: terms }),
          bill("missed", { amount: 100, discount: terms }),
          bill("open", { amount: 50, discount: terms }),
          bill("plain", { amount: 70 }),
        ],
        decisions: [decision(1, "taken"), decision(2, "missed"), decision(3, "plain")],
        payments: [payment("taken", { amount: 196 }), payment("missed", { amount: 100 }), payment("plain", { amount: 70 })],
      })
    );
    expect(report.discounts.captured).toEqual({ count: 1, byCurrency: [{ currency: "USDC", amount: 4 }] });
    expect(report.discounts.onOffer).toEqual({ count: 3, byCurrency: [{ currency: "USDC", amount: 7 }] });
  });

  it("gives verdict figures in shadow mode, with the bills whose newest decision still waits for one", () => {
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: "2026-10-02T00:00:00.000Z" },
        bills: [bill("a"), bill("b"), bill("c")],
        decisions: [
          decision(1, "a", { shadow: true, heldBecause: "shadow_verdict", resultingStatus: "held" }),
          decision(2, "b", { shadow: true, heldBecause: "shadow_verdict", resultingStatus: "held" }),
          decision(3, "c", { shadow: true, heldBecause: "shadow_verdict", resultingStatus: "held" }),
        ],
        verdicts: [
          { entrySeq: 1, verdict: "agree" },
          { entrySeq: 2, verdict: "disagree" },
        ],
      })
    );
    expect(report.verdicts).toEqual({ agreed: 1, disagreed: 1, waiting: 1 });
  });

  it("has no verdict figures outside shadow mode when no verdict was ever given", () => {
    expect(buildReport(facts({ bills: [bill("a")], decisions: [decision(1, "a")] })).verdicts).toBeNull();
  });

  it("lists what is left before a live slice in shadow mode only", () => {
    expect(buildReport(facts()).readiness).toBeNull();
    const report = buildReport(
      facts({
        shadow: { currency: "USD", startedAt: "2026-10-02T00:00:00.000Z" },
        bills: [
          bill("a", { payee: { id: "m", name: "Mirror Co", mirror: true, sample: false } }),
          bill("b", { payee: { id: "m", name: "Mirror Co", mirror: true, sample: false } }),
          bill("c"),
        ],
        decisions: [decision(1, "a", { shadow: true }), decision(2, "b", { shadow: true }), decision(3, "c", { shadow: true, heldBecause: "shadow_verdict", resultingStatus: "held" })],
        verdicts: [
          { entrySeq: 1, verdict: "agree" },
          { entrySeq: 2, verdict: "agree" },
        ],
        payments: [payment("a"), payment("b")],
      })
    );
    expect(report.readiness).toEqual([
      { key: "verdicts", done: false, given: 2, target: 5 },
      { key: "waiting", done: false, waiting: 1 },
      { key: "addresses", done: false, mirrorPayees: 1 },
      { key: "mainnet", done: null },
    ]);
  });

  it("keeps the newest ten in each list, newest first", () => {
    const bills = Array.from({ length: 12 }, (_, index) => bill(`b${index}`, { createdAt: `2026-10-02T10:${String(index).padStart(2, "0")}:00.000Z` }));
    const report = buildReport(
      facts({
        bills,
        decisions: bills.map((row, index) => decision(index + 1, row.id, { ts: `2026-10-02T11:${String(index).padStart(2, "0")}:00.000Z` })),
        payments: bills.map((row, index) => payment(row.id, { at: `2026-10-02T12:${String(index).padStart(2, "0")}:00.000Z` })),
      })
    );
    expect(report.paymentList).toHaveLength(10);
    expect(report.paymentList[0].payee).toBe("Payee b11");
    expect(report.paymentList[9].payee).toBe("Payee b2");
  });

  it("says whether money was real from the network", () => {
    expect(buildReport(facts()).realMoney).toBe(false);
    expect(buildReport(facts({ network: "arc-mainnet" })).realMoney).toBe(true);
  });
});

describe("readReportFacts", () => {
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a52";
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

  function workspace() {
    return (request: RecordedRequest) => {
      if (request.path === "/rest/v1/shadow_modes") return { body: [{ currency: "USD", started_at: "2026-10-07T08:00:00Z", started_by: null }] };
      if (request.path === "/rest/v1/invoices") {
        return {
          body: [
            {
              id: "inv-1",
              created_at: "2026-10-07T09:00:00Z",
              due_date: "2026-10-20T00:00:00Z",
              amount: "196.000000",
              currency: "USDC",
              status: "paid",
              reviewed_by: null,
              paid_amount: "196.000000",
              early_pay_discount_pct: "2",
              discount_due_date: "2026-10-10T00:00:00Z",
              original_currency: "USD",
              original_amount: "196",
              counterparties: { id: "cp-1", name: "Hetzner", sample: false, mirror_wallet_id: "w-1" },
            },
          ],
        };
      }
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("limit") === "1") return { body: [{ ts: "2026-10-01T00:00:00Z" }] };
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("actor") === "eq.agent") {
        return {
          body: [
            {
              seq: "41",
              ts: "2026-10-07T09:01:00Z",
              action: "ap_pay",
              invoice_id: "inv-1",
              guardrail_blocked: false,
              guardrail_rule: null,
              held_because: "shadow_verdict",
              resulting_status: "held",
              shadow: true,
              reasoning: "Matches the order.",
            },
            { seq: "42", ts: "2026-10-07T09:02:00Z", action: "ap_hold", invoice_id: null, guardrail_blocked: null, guardrail_rule: null, held_because: null, resulting_status: null, shadow: null, reasoning: null },
          ],
        };
      }
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("actor") === "eq.human") {
        return { body: [{ seq: "43", ts: "2026-10-07T09:05:00Z", action: "approval_paid", invoice_id: "inv-1" }] };
      }
      if (request.path === "/rest/v1/decision_verdicts") return { body: [{ entry_seq: "41", verdict: "agree" }] };
      if (request.path === "/rest/v1/payment_intents") {
        return { body: [{ source_id: "inv-1", amount: "196.000000", token: "USDC", tx_hash: `0x${"b".repeat(64)}`, executed_at: null, confirmed_at: "2026-10-07T09:06:00Z", updated_at: "2026-10-07T09:07:00Z" }] };
      }
      return { body: [] };
    };
  }

  it("reads the payables, the agent's decisions, people's approvals, verdicts and confirmed live payments of the workspace", async () => {
    const fake = fakeSupabase(workspace());
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readReportFacts(db(), "arc-testnet"));

    expect(read.openedAt).toBe("2026-10-01T00:00:00Z");
    expect(read.shadow).toEqual({ currency: "USD", startedAt: "2026-10-07T08:00:00Z" });
    expect(read.bills).toEqual([
      {
        id: "inv-1",
        createdAt: "2026-10-07T09:00:00Z",
        dueDate: "2026-10-20T00:00:00Z",
        amount: 196,
        currency: "USDC",
        status: "paid",
        reviewedBy: null,
        paidAmount: 196,
        discount: { pct: 2, deadline: "2026-10-10T00:00:00Z" },
        bill: { amount: 196, currency: "USD" },
        payee: { id: "cp-1", name: "Hetzner", mirror: true, sample: false },
      },
    ]);
    expect(read.decisions).toEqual([
      {
        seq: 41,
        ts: "2026-10-07T09:01:00Z",
        action: "ap_pay",
        invoiceId: "inv-1",
        guardrailBlocked: false,
        guardrailRule: null,
        heldBecause: "shadow_verdict",
        resultingStatus: "held",
        shadow: true,
        reasoning: "Matches the order.",
      },
    ]);
    expect(read.personActions).toEqual([{ seq: 43, ts: "2026-10-07T09:05:00Z", action: "approval_paid", invoiceId: "inv-1" }]);
    expect(read.verdicts).toEqual([{ entrySeq: 41, verdict: "agree" }]);
    expect(read.payments).toEqual([{ invoiceId: "inv-1", amount: 196, token: "USDC", txHash: `0x${"b".repeat(64)}`, at: "2026-10-07T09:06:00Z" }]);

    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    const intents = fake.requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(Object.fromEntries(["source_type", "provider", "provider_mode", "status"].map((key) => [key, intents?.params.get(key)]))).toEqual({
      source_type: "eq.invoice",
      provider: "eq.circle",
      provider_mode: "eq.live",
      status: "eq.confirmed",
    });
    const agent = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("actor") === "eq.agent");
    expect(agent?.params.get("action")).toBe("in.(ap_pay,ap_schedule,ap_hold,ap_flag_fraud,ap_request_info)");
    expect(agent?.params.get("select")).toContain("held_because:detail->execution->>heldBecause");
    // Every read stays inside the workspace.
    for (const request of fake.requests) expect(carriesOrg(request, ORG), request.path).toBe(true);
  });
});
