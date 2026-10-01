import { describe, expect, it } from "vitest";
import { summarizeDecisions, summaryMarkdown, type RecordedDecision } from "@/lib/research/model-vs-policy";

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

  it("lists every disagreement with its ledger entry", () => {
    expect(markdown).toContain("| #505 | testnet-2 | PAY invoice from Centronex for 2 USDC | pay | hold | 0.5 | counterparty.payment_limit | held |");
  });
});
