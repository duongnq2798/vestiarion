import { describe, expect, it } from "vitest";
import {
  breakdown,
  formatRatio,
  furthestStages,
  growthMetrics,
  leadFunnel,
  median,
  minutesToFirstDecision,
  ratio,
  reached,
  secondBillWithin7Days,
  stageIndex,
  workspaceSource,
  type LeadEvent,
  type LeadRow,
  type WorkspaceRow,
} from "@/lib/growth/metrics";
import type { Stage } from "@/lib/growth/fields";

/**
 * The founder dashboard's figures (src/lib/growth/metrics.ts): how far a lead got, every rate with its parts, the median,
 * and "not enough data" where a denominator is 0.
 */

const NOW = new Date("2026-10-10T12:00:00Z");

function lead(id: string, stage: Stage, extra: Partial<LeadRow> = {}): LeadRow {
  return { id, business_name: id, stage, review_status: "needs_review", source: "signal_outbound", segment: null, campaign_id: null, org_id: null, created_at: "2026-10-01T00:00:00Z", ...extra };
}

const move = (leadId: string, from: Stage | null, to: Stage, field = "stage"): LeadEvent => ({ lead_id: leadId, field, old_value: from, new_value: to, at: "2026-10-02T00:00:00Z" });

function workspace(extra: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    orgId: crypto.randomUUID(),
    slug: "acme",
    network: "arc-testnet",
    side: "customers",
    createdAt: "2026-10-01T10:00:00Z",
    mode: "sandbox",
    shadow: false,
    attribution: null,
    lead: null,
    firstRealBillAt: null,
    realBills: 0,
    realBillsWithin7dOfFirst: 0,
    firstDecisionAt: null,
    verdictsGiven: 0,
    verdictsAgreed: 0,
    livePayments: 0,
    liveUsdc: 0,
    members: 1,
    ...extra,
  };
}

describe("ratio and its words", () => {
  it("keeps the parts, and has no value when the denominator is 0", () => {
    expect(ratio(3, 10)).toEqual({ numerator: 3, denominator: 10, value: 0.3 });
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(formatRatio(ratio(3, 10))).toBe("3 / 10 · 30%");
    expect(formatRatio(ratio(0, 4))).toBe("0 / 4 · 0%");
    expect(formatRatio(ratio(0, 0))).toBe("Not enough data yet");
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the two middle ones, and null for none", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 2, 4, 8])).toBe(6);
  });
});

describe("how far a lead got", () => {
  it("orders the stages and leaves the side states out of the order", () => {
    expect(stageIndex("discovered")).toBe(0);
    expect(stageIndex("paying_customer")).toBe(14);
    expect(stageIndex("lost")).toBe(-1);
    expect(stageIndex("disqualified")).toBe(-1);
    expect(stageIndex(null)).toBe(-1);
  });

  it("takes the furthest of the current stage and every stage event, so a lost lead keeps what it reached", () => {
    const leads = [lead("a", "lost"), lead("b", "contacted"), lead("c", "disqualified"), lead("d", "verified")];
    const furthest = furthestStages(leads, [
      move("a", "discovered", "contacted"),
      move("a", "contacted", "replied"),
      move("a", "replied", "lost"),
      // Moved back: it still reached conversation.
      move("b", "conversation", "contacted"),
      move("c", null, "verified", "created"),
      move("c", "verified", "disqualified"),
      // Events of other fields, and of leads not in the list, are ignored.
      { lead_id: "d", field: "review_status", old_value: "needs_review", new_value: "approved_to_contact", at: "2026-10-02T00:00:00Z" },
      move("zz", null, "paying_customer"),
    ]);
    expect(reached(furthest, "a", "replied")).toBe(true);
    expect(reached(furthest, "a", "conversation")).toBe(false);
    expect(reached(furthest, "b", "conversation")).toBe(true);
    expect(reached(furthest, "c", "verified")).toBe(true);
    expect(reached(furthest, "c", "qualified")).toBe(false);
    expect(reached(furthest, "d", "verified")).toBe(true);
    expect(reached(furthest, "d", "qualified")).toBe(false);
    expect(furthest.has("zz")).toBe(false);
  });

  it("counts each funnel step as reached-or-beyond, and breaks it down by a key, the largest group first", () => {
    const leads = [
      lead("a", "paid_pilot", { source: "warm_intro" }),
      lead("b", "replied", { source: "signal_outbound" }),
      lead("c", "discovered", { source: "signal_outbound" }),
    ];
    const furthest = furthestStages(leads, []);
    expect(leadFunnel(leads, furthest)).toEqual({
      sourced: 3,
      qualified: 2,
      contacted: 2,
      replied: 2,
      conversation: 1,
      workspace_created: 1,
      real_invoice_reviewed: 1,
      paid_pilot: 1,
      paying_customer: 0,
    });
    const bySource = breakdown(leads, furthest, (row) => row.source);
    expect(bySource.map((row) => [row.key, row.funnel.sourced, row.funnel.replied])).toEqual([
      ["signal_outbound", 2, 1],
      ["warm_intro", 1, 1],
    ]);
    expect(breakdown(leads, furthest, (row) => row.campaign_id).map((row) => row.key)).toEqual(["none"]);
  });
});

describe("a workspace's row", () => {
  it("counts the minutes to the first decision", () => {
    expect(minutesToFirstDecision(workspace())).toBeNull();
    expect(minutesToFirstDecision(workspace({ firstDecisionAt: "2026-10-01T10:45:30Z" }))).toBe(46);
  });

  it("says yes, no or too early for a second real bill within 7 days", () => {
    expect(secondBillWithin7Days(workspace({ realBillsWithin7dOfFirst: 2 }), NOW)).toBe("yes");
    expect(secondBillWithin7Days(workspace({ createdAt: "2026-10-05T00:00:00Z" }), NOW)).toBe("too_early");
    expect(secondBillWithin7Days(workspace({ firstRealBillAt: "2026-10-06T00:00:00Z", realBillsWithin7dOfFirst: 1 }), NOW)).toBe("too_early");
    expect(secondBillWithin7Days(workspace({ firstRealBillAt: "2026-10-01T11:00:00Z", realBillsWithin7dOfFirst: 1 }), NOW)).toBe("no");
    expect(secondBillWithin7Days(workspace(), NOW)).toBe("no");
  });

  it("names its source from the first touch, else the linked lead", () => {
    const touch = { utmSource: "linkedin", utmMedium: null, utmCampaign: "agency-oct", ref: null, referrerHost: "www.linkedin.com", landingPath: "/" };
    expect(workspaceSource(workspace({ attribution: touch }))).toBe("linkedin · campaign agency-oct");
    expect(workspaceSource(workspace({ lead: { id: "l", source: "warm_intro", campaignId: null } }))).toBe("lead: warm intro");
    expect(workspaceSource(workspace({ attribution: { ...touch, utmSource: null, utmCampaign: null }, lead: null }))).toBe("from www.linkedin.com");
    expect(workspaceSource(workspace())).toBeNull();
  });
});

describe("growthMetrics", () => {
  it("says not enough data, never 0%, when there is nothing to divide by", () => {
    const metrics = growthMetrics({ leads: [], events: [], workspaces: [], spend: [], revenue: [], now: NOW });
    expect(metrics.leadsSourced).toBe(0);
    for (const rate of [metrics.responseRate, metrics.conversationRate, metrics.signupConversion, metrics.activation, metrics.repeat7d, metrics.paidPilotConversion]) {
      expect(rate.value).toBeNull();
    }
    expect(metrics.medianMinutesToFirstDecision).toEqual({ value: null, workspaces: 0 });
    expect(metrics.costPerActivated.value).toBeNull();
    expect(metrics.revenue).toEqual([]);
  });

  it("works out every figure from leads, workspaces, spend and revenue", () => {
    const leads = [
      lead("a", "paying_customer"),
      lead("b", "conversation"),
      lead("c", "lost"),
      lead("d", "contacted"),
      lead("e", "qualified"),
      lead("f", "discovered"),
    ];
    const events = [move("c", "replied", "lost"), move("c", "workspace_created", "replied")];
    const workspaces = [
      // Decided after 30 minutes, a second bill within 7 days, first bill 9 days old.
      workspace({ firstDecisionAt: "2026-10-01T10:30:00Z", firstRealBillAt: "2026-10-01T10:20:00Z", realBills: 2, realBillsWithin7dOfFirst: 2 }),
      // Decided after 90 minutes, one bill, 9 days old: no repeat.
      workspace({ firstDecisionAt: "2026-10-01T11:30:00Z", firstRealBillAt: "2026-10-01T11:00:00Z", realBills: 1, realBillsWithin7dOfFirst: 1 }),
      // A second bill within 7 days, but its first bill is only 3 days old: out of both sides of the repeat rate.
      workspace({ network: "arc-mainnet", createdAt: "2026-10-07T10:00:00Z", firstDecisionAt: "2026-10-07T10:10:00Z", firstRealBillAt: "2026-10-07T10:00:00Z", realBills: 2, realBillsWithin7dOfFirst: 2 }),
      // Opened, nothing else.
      workspace({ network: "arc-mainnet" }),
      // Ours never counts.
      workspace({ side: "ours", firstDecisionAt: "2026-10-01T10:01:00Z", firstRealBillAt: "2026-10-01T10:00:00Z", realBillsWithin7dOfFirst: 3 }),
    ];
    const metrics = growthMetrics({
      leads,
      events,
      workspaces,
      spend: [
        { campaign_id: null, spent_on: "2026-10-01", usd: 0.1, founder_hours: 1.5 },
        { campaign_id: "x", spent_on: "2026-10-02", usd: 0.2, founder_hours: 2 },
      ],
      revenue: [
        { kind: "payment_received", amount: 100, currency: "usd", occurred_on: "2026-10-05" },
        { kind: "payment_received", amount: 50.5, currency: "USD", occurred_on: "2026-10-06" },
        { kind: "payment_received", amount: 20, currency: "EUR", occurred_on: "2026-10-06" },
        // Never revenue.
        { kind: "invoice_issued", amount: 999, currency: "USD", occurred_on: "2026-10-06" },
        { kind: "pilot_agreed", amount: 500, currency: "USD", occurred_on: "2026-10-06" },
      ],
      now: NOW,
    });

    expect(metrics.leadsSourced).toBe(6);
    expect(metrics.qualified).toBe(5);
    expect(metrics.contacted).toBe(4);
    // Replied: a, b, c (c reached workspace_created before it was lost).
    expect(metrics.responseRate).toEqual(ratio(3, 4));
    expect(metrics.conversationRate).toEqual(ratio(3, 4));
    expect(metrics.signupConversion).toEqual(ratio(2, 4));
    expect(metrics.paidPilotConversion).toEqual(ratio(1, 3));
    expect(metrics.activation).toEqual(ratio(3, 4));
    expect(metrics.activationByNetwork).toEqual([
      { network: "arc-mainnet", rate: ratio(1, 2) },
      { network: "arc-testnet", rate: ratio(2, 2) },
    ]);
    expect(metrics.medianMinutesToFirstDecision).toEqual({ value: 30, workspaces: 3 });
    expect(metrics.repeat7d).toEqual(ratio(1, 2));
    expect(metrics.revenue).toEqual([
      { currency: "EUR", amount: 20, payments: 1 },
      { currency: "USD", amount: 150.5, payments: 2 },
    ]);
    expect(metrics.cashSpendUsd).toBe(0.3);
    expect(metrics.founderHours).toBe(3.5);
    // Leads reaching real_invoice_reviewed: only a.
    expect(metrics.costPerActivated).toEqual({ spendUsd: 0.3, activated: 1, value: 0.3 });
  });
});
