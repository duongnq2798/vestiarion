import { describe, expect, it } from "vitest";
import { latestDecisionView, timeAgo, type LatestDecisionFacts } from "@/lib/latest-decision";

/**
 * The landing's latest decision in words (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R2): what
 * happened, why a hold held, and who decided, from the entry's recorded facts alone. Nothing it says names anyone.
 */

const TX = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-10-08T12:00:00Z");

const LINK = { body_hash: "b".repeat(64), signature: "s".repeat(128), prev_hash: "p".repeat(64), hash: "h".repeat(64), signing_key_id: "0123456789abcdef" };

const paid: LatestDecisionFacts = {
  seq: 1899,
  ts: "2026-10-08T10:00:00Z",
  action: "ap_pay",
  network: "arc-testnet",
  amount: 0.35,
  currency: "USDC",
  decisionMode: "deepseek",
  agreedWithReference: true,
  guardrailBlocked: false,
  guardrailRule: null,
  heldBecause: null,
  resultingStatus: "paid",
  txRef: TX,
  payOn: null,
  verdict: null,
  paidTxHash: null,
  link: LINK,
};

const view = (facts: Partial<LatestDecisionFacts>) => latestDecisionView({ ...paid, ...facts }, NOW);
const fact = (facts: Partial<LatestDecisionFacts>, label: string) => view(facts).facts.find((item) => item.label === label)?.value ?? null;

describe("latestDecisionView", () => {
  it("says a paid bill plainly, with its transaction on the network's explorer", () => {
    const shown = view({});
    expect(shown).toMatchObject({
      seq: 1899,
      headline: "Paid a 0.35 USDC bill.",
      why: null,
      network: "Arc testnet",
      ago: "2 h ago",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
      link: LINK,
    });
    expect(shown.facts).toEqual([
      { label: "Proposed by", value: "DeepSeek model", tone: "neutral" },
      { label: "Written policy", value: "Agreed", tone: "proof" },
      { label: "Code checks", value: "Passed", tone: "proof" },
    ]);
  });

  it("names Arc mainnet's explorer for a mainnet workspace's payment", () => {
    expect(view({ network: "arc-mainnet" })).toMatchObject({ network: "Arc mainnet", txUrl: `https://explorer.arc.io/tx/${TX}` });
  });

  it("never calls a payment the network is still confirming paid, nor links a reference that is not a transaction", () => {
    expect(view({ resultingStatus: "matched", txRef: "circle-transfer-1" })).toMatchObject({ headline: "Sent a 0.35 USDC bill; Arc testnet is confirming it.", txUrl: null });
  });

  it("says a payment held for a person's verdict in shadow mode, and the verdict once given", () => {
    const waiting = { resultingStatus: "held", heldBecause: "shadow_verdict", txRef: null };
    expect(view(waiting)).toMatchObject({ headline: "Decided to pay a 0.35 USDC bill.", why: "It waits for a person's verdict, in shadow mode.", txUrl: null });
    expect(fact(waiting, "Person")).toBe("Deciding");
    expect(fact({ ...waiting, verdict: "agree" }, "Person")).toBe("Agreed");
    expect(fact({ ...waiting, verdict: "disagree" }, "Person")).toBe("Disagreed");
  });

  it("says a payment a person agreed to in shadow mode was paid, with the transaction that paid it", () => {
    const agreed = { resultingStatus: "held", heldBecause: "shadow_verdict", txRef: null, verdict: "agree" as const };
    expect(view({ ...agreed, paidTxHash: TX })).toMatchObject({
      headline: "Paid a 0.35 USDC bill after a person agreed.",
      why: "In shadow mode, a person agrees before anything is paid.",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
    });
    // Agreed, but its payment has not confirmed: never called paid, nothing to link, and never "still waits".
    expect(view(agreed)).toMatchObject({ headline: "Decided to pay a 0.35 USDC bill.", why: "A person agreed, in shadow mode; its payment has not confirmed yet.", txUrl: null });
    expect(view({ ...agreed, verdict: "disagree" })).toMatchObject({ headline: "Decided to pay a 0.35 USDC bill.", why: "In shadow mode, a person disagreed, so it was not paid." });
  });

  it("says a payment a person approved after the agent held it, with its transaction", () => {
    expect(view({ resultingStatus: "held", heldBecause: "cash_shortfall", txRef: null, paidTxHash: TX })).toMatchObject({
      headline: "Paid a 0.35 USDC bill after a person approved it.",
      why: "The operating wallet was short of cash for it.",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
    });
  });

  it("says what code refused, in words that name no one", () => {
    const refused = view({ action: "ap_hold", resultingStatus: "held", txRef: null, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit" });
    expect(refused.headline).toBe("Held a 0.35 USDC bill.");
    expect(refused.why).toBe("Code refused it: it is above the payee's payment limit.");
    expect(refused.facts).toContainEqual({ label: "Code checks", value: "Refused it", tone: "refused" });
    expect(view({ action: "ap_hold", guardrailBlocked: true, guardrailRule: "some.new_rule" }).why).toBe("Code refused it: a hard limit in code.");
  });

  it("says why a hold held when no rule did", () => {
    expect(view({ action: "ap_hold", heldBecause: "cash_shortfall" }).why).toBe("The operating wallet was short of cash for it.");
    expect(view({ action: "ap_hold", heldBecause: "agent_paused" }).why).toBe("The agent was paused.");
    expect(view({ action: "ap_hold", heldBecause: "outflow_budget" }).why).toBe("It would have passed the workspace's spending limit.");
    expect(view({ action: "ap_hold" }).why).toBe("The model held it for a person to look at.");
  });

  it("says the other decisions in their own words", () => {
    expect(view({ action: "ap_schedule", payOn: "2026-10-10", txRef: null }).headline).toBe("Scheduled a 0.35 USDC bill for Oct 10.");
    expect(view({ action: "ap_request_info", txRef: null }).headline).toBe("Asked for a missing detail on a 0.35 USDC bill.");
    expect(view({ action: "ap_flag_fraud", txRef: null }).headline).toBe("Flagged a 0.35 USDC bill as possible fraud.");
    expect(view({ action: "milestone_release", amount: 0.3 }).headline).toBe("Paid a 0.30 USDC contractor milestone.");
    expect(view({ action: "milestone_hold", amount: 0.3, txRef: null }).headline).toBe("Held a 0.30 USDC contractor milestone.");
    expect(view({ amount: null }).headline).toBe("Paid a bill.");
  });

  it("says the written policy decided when no model did, and when the model departed from it", () => {
    expect(view({ decisionMode: "heuristic", agreedWithReference: null }).facts).toEqual([
      { label: "Proposed by", value: "Written policy", tone: "neutral" },
      { label: "Code checks", value: "Passed", tone: "proof" },
    ]);
    expect(fact({ agreedWithReference: false }, "Written policy")).toBe("Disagreed");
    expect(fact({ decisionMode: "anthropic" }, "Proposed by")).toBe("Anthropic model");
  });
});

describe("timeAgo", () => {
  it("says how long ago, roughly", () => {
    expect(timeAgo("2026-10-08T11:59:40Z", NOW)).toBe("just now");
    expect(timeAgo("2026-10-08T11:35:00Z", NOW)).toBe("25 min ago");
    expect(timeAgo("2026-10-08T09:00:00Z", NOW)).toBe("3 h ago");
    expect(timeAgo("2026-10-05T12:00:00Z", NOW)).toBe("3 days ago");
    expect(timeAgo("2026-10-07T11:00:00Z", NOW)).toBe("25 h ago");
  });
});
