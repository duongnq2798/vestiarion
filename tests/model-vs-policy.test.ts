import { describe, expect, it } from "vitest";
import { peopleMarkdown, stopKind, summarizeDecisions, summarizePeople, summaryMarkdown, within, type PersonDecision, type RecordedDecision } from "@/lib/research/model-vs-policy";

/**
 * The research note's numbers (I1): every decision the agent's model made,
 * the written policy's answer to the same facts, and where code refused.
 */

const row = (overrides: Partial<RecordedDecision>): RecordedDecision => ({
  seq: 1,
  ts: "2026-09-30T10:00:00.000Z",
  domain: "ap",
  workspace: "testnet-2",
  mode: "deepseek",
  modelAction: "pay",
  policyAction: "pay",
  agreed: true,
  guardrailRule: null,
  guardrailBlocked: false,
  confidence: 0.9,
  summary: "PAY invoice from Centronex for 2 USDC",
  outcome: "paid",
  ...overrides,
});

const ROWS: RecordedDecision[] = [
  row({ seq: 91, ts: "2026-09-24T11:55:27.000Z", workspace: "founding", agreed: null, policyAction: null }),
  row({ seq: 100, domain: "treasury", modelAction: "hold", policyAction: "hold" }),
  row({ seq: 101, domain: "contractor", modelAction: "release", policyAction: "release" }),
  row({ seq: 343, modelAction: "flag_fraud", policyAction: "hold", agreed: false, confidence: 0.85, outcome: "paid" }),
  row({ seq: 426, modelAction: "flag_fraud", policyAction: "pay", agreed: false, confidence: 0.6, outcome: "flagged" }),
  row({ seq: 505, ts: "2026-10-01T02:32:05.000Z", modelAction: "pay", policyAction: "hold", agreed: false, guardrailRule: "counterparty.payment_limit", confidence: 0.5, outcome: "held" }),
  row({ seq: 510, mode: "heuristic", agreed: null }),
];

describe("a refusal or a difference the first summary missed", () => {
  // A milestone's refusal records guardrailBlocked and no rule; two answers that both move money can differ on the day.
  const summary = summarizeDecisions([
    row({ seq: 600, domain: "contractor", modelAction: "release", policyAction: "release", guardrailBlocked: true }),
    row({ seq: 601, modelAction: "schedule", policyAction: "pay", agreed: false, outcome: "scheduled" }),
  ]);

  it("counts a milestone that code refused, though its entry names no rule", () => {
    expect(summary.refusedByCode.map((decision) => decision.seq)).toEqual([600]);
  });

  it("keeps a difference where both answers move money, as a difference of when", () => {
    expect(summary.bothMove.map((decision) => decision.seq)).toEqual([601]);
    expect(summaryMarkdown(summary)).toContain("| #601 |");
  });
});

describe("summarizing the agent's recorded decisions", () => {
  const summary = summarizeDecisions(ROWS);

  it("counts the model's decisions apart from the rule-based fallback's", () => {
    expect(summary.modelDecisions).toBe(6);
    expect(summary.fallbackDecisions).toBe(1);
    expect(summary.byMode).toEqual({ deepseek: 6, heuristic: 1 });
  });

  it("measures agreement only where the policy's answer was recorded", () => {
    expect(summary.measured).toBe(5);
    expect(summary.unmeasured).toBe(1);
    expect(summary.agreed).toBe(2);
    expect(summary.disagreed).toBe(3);
    expect(summary.agreementPercent).toBe(40);
  });

  it("sorts each disagreement: money the policy would move and the model would not, the reverse, or a different stop", () => {
    expect(summary.stricter.map((decision) => decision.seq)).toEqual([426]);
    expect(summary.looser.map((decision) => decision.seq)).toEqual([505]);
    expect(summary.differentStop.map((decision) => decision.seq)).toEqual([343]);
  });

  it("counts the decisions code refused, and the span and the domains", () => {
    expect(summary.refusedByCode.map((decision) => decision.seq)).toEqual([505]);
    expect(summary.from).toBe("2026-09-24T11:55:27.000Z");
    expect(summary.to).toBe("2026-10-01T02:32:05.000Z");
    expect(summary.byDomain).toEqual({ ap: 4, treasury: 1, contractor: 1 });
    expect(summary.workspaces).toBe(2);
  });

  it("measures agreement domain by domain, since a domain of easy decisions can carry the total", () => {
    expect(summary.agreementByDomain).toEqual([
      { domain: "ap", measured: 3, agreed: 0 },
      { domain: "contractor", measured: 1, agreed: 1 },
      { domain: "treasury", measured: 1, agreed: 1 },
    ]);
  });

  it("compares the model's confidence where it agreed with the policy and where it did not", () => {
    // Agreed: 91 is unmeasured; 100 and 101 carry 0.9 each. Differed: 0.85, 0.6, 0.5.
    expect(summary.meanConfidence).toEqual({ agreed: 0.9, differed: 0.65 });
  });

  it("counts the pairs of actions the two chose when they differed", () => {
    expect(summary.pairs).toEqual([
      { model: "flag_fraud", policy: "hold", count: 1 },
      { model: "flag_fraud", policy: "pay", count: 1 },
      { model: "pay", policy: "hold", count: 1 },
    ]);
  });
});

describe("the summary as Markdown", () => {
  const markdown = summaryMarkdown(summarizeDecisions(ROWS));

  it("states the headline numbers", () => {
    expect(markdown).toContain("| Decisions by the model | 6 |");
    expect(markdown).toContain("| With the policy's answer recorded | 5 |");
    expect(markdown).toContain("| Same action as the policy | 2 (40%) |");
    expect(markdown).toContain("| Refused by code | 1 |");
    expect(markdown).toContain("| ap | 3 | 0 (0%) |");
    expect(markdown).toContain("The model's mean confidence: 0.9 where it chose the policy's action, 0.65 where it did not.");
  });

  it("names the providers and the workspaces the figures come from", () => {
    expect(markdown).toContain("By provider: deepseek 6, heuristic 1.");
    expect(markdown).toContain("Workspaces: founding, testnet-2.");
  });

  it("lists every disagreement with its ledger entry", () => {
    expect(markdown).toContain("| #505 | testnet-2 | PAY invoice from Centronex for 2 USDC | pay | hold | 0.5 | counterparty.payment_limit | held |");
  });
});

describe("what people did with what the agent left them (I2)", () => {
  const person = (overrides: Partial<PersonDecision>): PersonDecision => ({
    seq: 900,
    ts: "2026-10-02T09:00:00.000Z",
    workspace: "testnet-2",
    action: "approval_paid",
    agentAction: "hold",
    policyAction: "hold",
    refusedByCode: false,
    dismissed: 0,
    ...overrides,
  });

  it("says why each one waited: a stop the policy makes too, one only the model made, code's refusal, or a payment that did not go through", () => {
    expect(stopKind(person({}))).toBe("policy_stop");
    expect(stopKind(person({ agentAction: "flag_fraud", policyAction: "pay" }))).toBe("model_stop");
    expect(stopKind(person({ agentAction: "pay", policyAction: "hold", refusedByCode: true }))).toBe("code_refused");
    expect(stopKind(person({ agentAction: "release", policyAction: "release" }))).toBe("not_completed");
    expect(stopKind(person({ agentAction: null, policyAction: null }))).toBe("no_decision");
  });

  it("counts what people did with each, the model's own stops they upheld, screening reviews and limit proposals", () => {
    const summary = summarizePeople([
      person({ seq: 585, agentAction: "flag_fraud", policyAction: "pay" }),
      person({ seq: 586, agentAction: "flag_fraud", policyAction: "pay", action: "approval_rejected" }),
      person({ seq: 673, action: "approval_rejected" }),
      person({ seq: 503, action: "approval_returned" }),
      person({ seq: 717, agentAction: "pay", refusedByCode: true }),
      person({ seq: 800, action: "milestone_closed", agentAction: "release", policyAction: "release" }),
      person({ seq: 902, action: "screening_match_dismissed", agentAction: null, policyAction: null, dismissed: 15 }),
      person({ seq: 811, action: "screening_match_dismissed", agentAction: null, policyAction: null, dismissed: 1 }),
      person({ seq: 740, action: "policy_proposal_accepted", agentAction: null, policyAction: null }),
    ]);
    expect(summary.decidedTotal).toBe(6);
    expect(summary.decided.model_stop).toEqual({ paid: 1, upheld: 1, returned: 0 });
    expect(summary.decided.policy_stop).toEqual({ paid: 0, upheld: 1, returned: 1 });
    expect(summary.decided.code_refused.paid).toBe(1);
    expect(summary.decided.not_completed.upheld).toBe(1);
    expect(summary.modelStopsUpheld).toEqual({ upheld: 1, of: 2 });
    expect(summary.screening).toEqual({ reviews: 2, matchesDismissed: 16 });
    expect(summary.proposals).toEqual({ accepted: 1, dismissed: 0 });
    expect(peopleMarkdown(summary)).toContain("| The model stopped it; the policy would have paid | 1 | 1 | 0 |");
  });

  it("measures one window at a time: from inclusive, to exclusive", () => {
    const rows = [{ ts: "2026-10-01T05:47:59.000Z" }, { ts: "2026-10-01T05:48:00.000Z" }, { ts: "2026-10-02T00:00:00.000Z" }];
    expect(within(rows, "2026-10-01T05:48:00.000Z")).toHaveLength(2);
    expect(within(rows, undefined, "2026-10-01T05:48:00.000Z")).toHaveLength(1);
    expect(within(rows)).toHaveLength(3);
  });
});
