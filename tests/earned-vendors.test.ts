import { describe, expect, it } from "vitest";
import { autonomyLadder, ladderVerdicts } from "@/lib/autonomy-ladder";
import {
  breaksEarning,
  EARNED_PAYMENTS_OFF,
  EARNED_PAYMENTS_ON,
  EARNED_STREAK_MAX,
  EARNED_WAITING_MAX,
  earnedPaymentsConfirm,
  earnedPaymentsSummary,
  earnedWaitingWords,
  EARNED_STREAK_MIN,
  earnedChanges,
  earnedLostEntry,
  earnedRuleFromRow,
  earnedRuleSummary,
  earnedStatusWords,
  earnedVendorEntry,
  earnedVendors,
  earnedVendorsSentence,
  shownEarned,
  type EarnedFacts,
  type EarnedStatus,
  type RecordedStatus,
} from "@/lib/earned-vendors";
import { VERDICTS_BEFORE_LIVE } from "@/lib/workspace-report";

/**
 * Earned vendors, the pure rules (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11-AL14, AL16, AL18): a
 * vendor earns the owner's rule with N agreed verdicts in a row on the agent's decisions to pay or schedule its bills,
 * counted again after a Disagree (timed by the verdict), a bill flagged for review, or a check in code on the vendor or
 * its bill, whether or not that decision has a verdict yet; never for a sample vendor, one screened high risk, one with
 * no payment limit, or a payee that is not a vendor. What changed since the newest signed status is what gets signed.
 * Step 3: how many of an earned vendor's payments the agent made on its own still wait for a verdict, at most 3 before
 * its next waits too (AL26), and the switch's words (AL21, AL28).
 */

type Payee = EarnedFacts["bills"][number]["payee"];

const NORTHWIND: Payee = { id: "cp-northwind", name: "Northwind Packaging", sample: false, role: "vendor", paymentLimit: 500 };
const LUMEN: Payee = { id: "cp-lumen", name: "Lumen Print Co.", sample: false, role: "vendor", paymentLimit: 200 };
const SAMPLE: Payee = { id: "cp-sample", name: "Sample Supplies", sample: true, role: "vendor", paymentLimit: 100 };

const DAY = 24 * 3_600_000;
const START = Date.parse("2026-10-01T09:00:00.000Z");
const at = (days: number) => new Date(START + days * DAY).toISOString();

/** A book built one decision at a time: each on its own bill of its vendor, a day after the one before unless told. */
function book() {
  const facts: { bills: Array<EarnedFacts["bills"][number]>; decisions: Array<EarnedFacts["decisions"][number]>; verdicts: Array<EarnedFacts["verdicts"][number]> } = {
    bills: [],
    decisions: [],
    verdicts: [],
  };
  let seq = 100;
  let day = 0;
  const decide = (
    payee: Payee,
    options: { action?: string; verdict?: "agree" | "disagree"; decidedOn?: number; rule?: string; status?: string; day?: number; amount?: number; onItsOwn?: boolean } = {}
  ) => {
    seq += 1;
    day = options.day ?? day + 1;
    const invoiceId = `inv-${seq}`;
    facts.bills.push({ id: invoiceId, amount: options.amount ?? 100, currency: "USDC", payee });
    facts.decisions.push({
      seq,
      ts: at(day),
      action: options.action ?? "ap_pay",
      invoiceId,
      guardrailBlocked: options.rule !== undefined,
      guardrailRule: options.rule ?? null,
      resultingStatus: options.status ?? "held",
      ...(options.onItsOwn ? { onItsOwn: true } : {}),
    });
    if (options.verdict) facts.verdicts.push({ entrySeq: seq, verdict: options.verdict, decidedAt: at(options.decidedOn ?? day) });
    return seq;
  };
  const agree = (payee: Payee, count: number, action = "ap_pay") => Array.from({ length: count }, () => decide(payee, { action, verdict: "agree" }));
  return { facts, decide, agree };
}

const statusOf = (statuses: EarnedStatus[], vendorId: string) => statuses.find((status) => status.vendorId === vendorId);

describe("the rule's bounds (AL11)", () => {
  it("goes from the ladder's too-few-to-tell figure to 50", () => {
    expect(EARNED_STREAK_MIN).toBe(VERDICTS_BEFORE_LIVE);
    expect(EARNED_STREAK_MAX).toBe(50);
  });

  it("reads no row, missing columns and anything out of bounds as no rule, and the switch only beside a rule", () => {
    expect(earnedRuleFromRow(undefined)).toEqual({ streak: null, payments: false });
    expect(earnedRuleFromRow({})).toEqual({ streak: null, payments: false });
    expect(earnedRuleFromRow({ earned_vendor_streak: 8, earned_vendor_payments: false })).toEqual({ streak: 8, payments: false });
    expect(earnedRuleFromRow({ earned_vendor_streak: "12", earned_vendor_payments: true })).toEqual({ streak: 12, payments: true });
    for (const bad of [4, 51, 7.5, "x", null]) expect(earnedRuleFromRow({ earned_vendor_streak: bad as never }).streak).toBeNull();
    expect(earnedRuleFromRow({ earned_vendor_streak: null, earned_vendor_payments: true })).toEqual({ streak: null, payments: false });
  });
});

describe("what earns it (AL12)", () => {
  it("earns it with N agreed verdicts on pay and schedule decisions, and counts N-1", () => {
    const { facts, agree } = book();
    agree(NORTHWIND, 3);
    agree(NORTHWIND, 2, "ap_schedule");
    agree(LUMEN, 4);
    const statuses = earnedVendors(facts, 5);
    expect(statusOf(statuses, NORTHWIND.id)).toMatchObject({ state: "earned", agreed: 5, since: null });
    expect(statusOf(statuses, LUMEN.id)).toMatchObject({ state: "counting", agreed: 4, needed: 5, since: null });
  });

  it("starts the count again after a Disagree, timed by when it was given: a late Disagree on an old decision breaks it now", () => {
    const { facts, decide, agree } = book();
    const old = decide(NORTHWIND, { action: "ap_hold", verdict: "disagree", decidedOn: 9 });
    agree(NORTHWIND, 6);
    // Six agreed decisions, days 2 to 7, but the Disagree on the day-1 hold was given on day 9.
    const status = statusOf(earnedVendors(facts, 5), NORTHWIND.id);
    expect(status).toMatchObject({ state: "counting", agreed: 0, since: { kind: "disagreed", at: at(9), decisionSeq: old, rule: null } });
  });

  it("starts it again after a decision that ended flagged, even one a person agreed with", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 4);
    const flagged = decide(NORTHWIND, { action: "ap_flag_fraud", verdict: "agree", status: "flagged" });
    agree(NORTHWIND, 2);
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 2, since: { kind: "flagged", decisionSeq: flagged } });
    // Code's duplicate rule flags too: the outcome breaks it, whatever stopped it.
    const second = book();
    second.agree(NORTHWIND, 5);
    second.decide(NORTHWIND, { verdict: "agree", rule: "invoice.duplicate_of_settled", status: "flagged" });
    expect(statusOf(earnedVendors(second.facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "flagged", rule: "invoice.duplicate_of_settled" } });
  });

  const BREAKING = [
    "counterparty.high_risk",
    "counterparty.unscreened",
    "counterparty.client_payable",
    "counterparty.payment_limit",
    "counterparty.address_unconfirmed",
    "counterparty.cooling_off",
    "counterparty.no_address",
    "counterparty.new_payee",
    "invoice.pay_to_differs",
    "invoice.duplicate_of_settled",
    "invoice.match_incomplete",
    "invoice.vendor_document",
    "obligation.duplicate_reference",
  ];
  const NOT_BREAKING = [
    "workspace.two_approvals",
    "workspace.outflow_budget",
    "workspace.onchain_limit",
    "workspace.onchain_limit_route",
    "project.budget_exceeded",
    "fx.rate_unavailable",
    "fx.swap_cost_above_cap",
    "bridge.fee_above_cap",
    "treasury.insufficient_eurc",
    "payout.bank_needs_person",
    "treasury.cash_shortfall",
  ];

  it("names every check on the vendor or its bill as one that breaks it, and none of the workspace's own limits or rails", () => {
    for (const rule of BREAKING) expect(breaksEarning(rule), rule).toBe(true);
    for (const rule of NOT_BREAKING) expect(breaksEarning(rule), rule).toBe(false);
    expect(breaksEarning(null)).toBe(false);
  });

  it.each(BREAKING)("starts it again when %s stopped one of its bills", (rule) => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 5);
    const stopped = decide(NORTHWIND, { verdict: "agree", rule });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "code_stop", decisionSeq: stopped, rule } });
  });

  it.each(NOT_BREAKING)("keeps the count when %s held one of its bills, and counts the agreement on it", (rule) => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 4);
    decide(NORTHWIND, { verdict: "agree", rule });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", agreed: 5, since: null });
  });

  it("neither counts nor breaks on an agreed Hold or Ask for details, and skips a decision with no verdict", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 2);
    decide(NORTHWIND, { action: "ap_hold", verdict: "agree" });
    decide(NORTHWIND, { action: "ap_request_info", verdict: "agree" });
    decide(NORTHWIND);
    agree(NORTHWIND, 2);
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 4, since: null });
  });

  it("never counts a decision with no verdict yet, which starts the count again only if it ended flagged or a check stopped it", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 5);
    // A payment waiting for its verdict: not counted, and nothing broken.
    decide(NORTHWIND);
    decide(NORTHWIND, { action: "ap_schedule" });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", agreed: 5, since: null });
    // A bill a check on it stopped breaks it before anyone gives a verdict on that decision.
    const stopped = decide(NORTHWIND, { rule: "invoice.pay_to_differs" });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "code_stop", decisionSeq: stopped } });
    // So does a bill flagged for review.
    const second = book();
    second.agree(NORTHWIND, 5);
    const flagged = second.decide(NORTHWIND, { action: "ap_flag_fraud", status: "flagged" });
    expect(statusOf(earnedVendors(second.facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "flagged", decisionSeq: flagged } });
  });

  it("needs N decisions made after a break to earn it again", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 7);
    decide(NORTHWIND, { verdict: "disagree" });
    agree(NORTHWIND, 4);
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 4 });
    agree(NORTHWIND, 1);
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", agreed: 5, since: { kind: "disagreed" } });
  });

  it("keeps as evidence the counted decisions, newest first, from the oldest to the newest", () => {
    const { facts, decide, agree } = book();
    decide(NORTHWIND, { verdict: "disagree" });
    const seqs = agree(NORTHWIND, 6);
    const status = statusOf(earnedVendors(facts, 5), NORTHWIND.id);
    expect(status?.state).toBe("earned");
    if (status?.state !== "earned") return;
    expect(status.agreed).toBe(6);
    expect(status.counted.map((decision) => decision.seq)).toEqual([...seqs].reverse());
    expect(status.counted[0]).toEqual({ seq: seqs[5], at: at(7), action: "ap_pay", amount: 100, currency: "USDC" });
    expect(status.from).toBe(at(2));
    expect(status.to).toBe(at(7));
  });

  it("reads a Disagree with no time as given now, the strictest: it breaks every decision before it", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 5);
    decide(NORTHWIND, { action: "ap_hold", verdict: "disagree" });
    agree(NORTHWIND, 1);
    const verdict = facts.verdicts.find((row) => row.verdict === "disagree")!;
    delete verdict.decidedAt;
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "counting", agreed: 0, since: { kind: "disagreed" } });
  });
});

describe("who can earn it (AL13)", () => {
  it("leaves sample vendors out, and says why a payee with no payment limit or another role cannot", () => {
    const { facts, agree } = book();
    agree(SAMPLE, 6);
    agree({ ...NORTHWIND, paymentLimit: null }, 6);
    agree({ ...LUMEN, paymentLimit: 0 }, 1);
    agree({ id: "cp-taller", name: "Taller Norte", sample: false, role: "contractor", paymentLimit: 300 }, 6);
    const statuses = earnedVendors(facts, 5);
    expect(statusOf(statuses, SAMPLE.id)).toBeUndefined();
    expect(statusOf(statuses, NORTHWIND.id)).toMatchObject({ state: "cannot", because: "no_payment_limit", given: 6 });
    expect(statusOf(statuses, LUMEN.id)).toMatchObject({ state: "cannot", because: "no_payment_limit" });
    expect(statusOf(statuses, "cp-taller")).toMatchObject({ state: "cannot", because: "not_a_vendor" });
  });

  it("says a vendor screened high risk cannot for that, never for want of a limit the owner did set", () => {
    const { facts, agree } = book();
    // Screening keeps a high-risk payee's limit at 0, whatever its owner set (paymentLimitForRisk).
    agree({ ...NORTHWIND, riskLevel: "high", paymentLimit: 0 }, 6);
    agree({ ...LUMEN, riskLevel: "medium", paymentLimit: 50 }, 5);
    const statuses = earnedVendors(facts, 5);
    expect(statusOf(statuses, NORTHWIND.id)).toMatchObject({ state: "cannot", because: "high_risk", given: 6 });
    expect(statusOf(statuses, LUMEN.id)).toMatchObject({ state: "earned", agreed: 5 });
  });

  it("lists the vendors in the ladder's own order: most verdicts first, then by name (autonomy ladder AL5)", () => {
    const { facts, decide, agree } = book();
    agree(LUMEN, 3);
    agree(NORTHWIND, 3);
    decide({ id: "cp-atlas", name: "Atlas Compute", sample: false, role: "vendor", paymentLimit: 90 }, { verdict: "agree" });
    decide({ id: "cp-quiet", name: "Quiet Co.", sample: false, role: "vendor", paymentLimit: 90 });
    const ladder = autonomyLadder(ladderVerdicts({ bills: facts.bills.map((bill) => ({ ...bill, payee: { ...bill.payee, mirror: false } })) as never, decisions: facts.decisions as never, verdicts: facts.verdicts }));
    const order = earnedVendors(facts, 5).map((status) => status.vendorId);
    expect(order.slice(0, 3)).toEqual(ladder.byVendor.map((row) => row.key));
    // A vendor with a decision and no verdict comes last, with nothing given.
    expect(order[3]).toBe("cp-quiet");
    expect(statusOf(earnedVendors(facts, 5), "cp-quiet")).toMatchObject({ state: "counting", agreed: 0, given: 0 });
  });
});

describe("what gets signed (AL16)", () => {
  const recorded = (entries: Record<string, RecordedStatus["state"]>, at = "2026-10-05T00:00:00.000Z") =>
    new Map(Object.entries(entries).map(([vendorId, state], index) => [vendorId, { state, seq: 900 + index, at }]));

  it("signs nothing when the record and the facts agree, so a second run in a row signs nothing", () => {
    const { facts, agree } = book();
    agree(NORTHWIND, 5);
    agree(LUMEN, 2);
    const statuses = earnedVendors(facts, 5);
    expect(earnedChanges(statuses, recorded({ [NORTHWIND.id]: "earned" }), 5)).toEqual([]);
    expect(earnedChanges(statuses, recorded({ [NORTHWIND.id]: "earned", [LUMEN.id]: "lost" }), 5)).toEqual([]);
  });

  it("signs a vendor earned now that the record does not have earned", () => {
    const { facts, agree } = book();
    agree(NORTHWIND, 5);
    const statuses = earnedVendors(facts, 5);
    for (const record of [recorded({}), recorded({ [NORTHWIND.id]: "lost" })]) {
      const [change] = earnedChanges(statuses, record, 5);
      expect(change).toMatchObject({ vendorId: NORTHWIND.id, to: "earned", status: { state: "earned", agreed: 5 } });
    }
  });

  it("signs the loss with what broke it, when that came after it was recorded", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 5);
    const disagreed = decide(NORTHWIND, { verdict: "disagree" });
    const [change] = earnedChanges(earnedVendors(facts, 5), recorded({ [NORTHWIND.id]: "earned" }), 5);
    expect(change).toMatchObject({ vendorId: NORTHWIND.id, to: "lost", because: "disagreed", since: { decisionSeq: disagreed } });
  });

  it("signs a loss the rule made as rule_changed: a break from before it was recorded is not why", () => {
    const { facts, decide, agree } = book();
    decide(NORTHWIND, { verdict: "disagree" });
    agree(NORTHWIND, 6);
    // Recorded earned on day 8, after the break of day 1; the rule then rose from 5 to 8.
    const [change] = earnedChanges(earnedVendors(facts, 8), recorded({ [NORTHWIND.id]: "earned" }, at(8)), 8);
    expect(change).toMatchObject({ to: "lost", because: "rule_changed", since: null });
  });

  it("signs a vendor that can no longer earn it as lost, saying why", () => {
    const { facts, agree } = book();
    agree({ ...NORTHWIND, paymentLimit: null }, 5);
    agree({ ...LUMEN, riskLevel: "high", paymentLimit: 0 }, 5);
    const changes = earnedChanges(earnedVendors(facts, 5), recorded({ [NORTHWIND.id]: "earned", [LUMEN.id]: "earned" }), 5);
    expect(changes).toEqual([
      { vendorId: LUMEN.id, to: "lost", because: "high_risk", since: null },
      { vendorId: NORTHWIND.id, to: "lost", because: "no_payment_limit", since: null },
    ]);
  });

  it("with no rule, signs every vendor recorded earned as lost, rule_off, and nothing else", () => {
    const changes = earnedChanges([], recorded({ [NORTHWIND.id]: "earned", [LUMEN.id]: "lost" }), null);
    expect(changes).toEqual([{ vendorId: NORTHWIND.id, to: "lost", because: "rule_off", since: null }]);
  });
});

describe("the words (AL15, AL17, AL18)", () => {
  it("says the setting in one sentence, off and on", () => {
    expect(earnedVendorsSentence(null)).toBe("Off: no vendor is counted as earned.");
    expect(earnedVendorsSentence(8)).toBe(
      "On: a vendor is earned after 8 agreed verdicts in a row on the agent's decisions to pay or schedule its bills. A disagreement, a bill flagged for review, or a check in code stopping one of its bills starts the count again."
    );
  });

  it("signs a rule change, an earned vendor and a loss with a summary and their fields", () => {
    expect(earnedRuleSummary(8)).toBe("Earned vendors: 8 agreed verdicts in a row");
    expect(earnedRuleSummary(null)).toBe("Earned vendors turned off");

    const { facts, decide, agree } = book();
    const disagreed = decide(NORTHWIND, { verdict: "disagree" });
    const seqs = agree(NORTHWIND, 5);
    const status = statusOf(earnedVendors(facts, 5), NORTHWIND.id)!;
    expect(earnedVendorEntry(status as Extract<EarnedStatus, { state: "earned" }>, 5, "verdict")).toEqual({
      actor: "system",
      domain: "compliance",
      action: "vendor_earned",
      summary: "Northwind Packaging is an earned vendor: 5 agreed verdicts in a row on the agent's decisions to pay it",
      detail: {
        counterpartyId: NORTHWIND.id,
        streak: 5,
        agreed: 5,
        evidence: [...seqs].reverse(),
        from: at(2),
        to: at(6),
        since: { kind: "disagreed", at: at(1), decisionSeq: disagreed, rule: null },
        trigger: "verdict",
      },
    });

    expect(earnedLostEntry({ vendorId: NORTHWIND.id, name: NORTHWIND.name, streak: 5, because: "code_stop", since: { kind: "code_stop", at: at(3), decisionSeq: 7, rule: "invoice.pay_to_differs" }, trigger: "cycle" })).toEqual({
      actor: "system",
      domain: "compliance",
      action: "vendor_earned_lost",
      summary: "Northwind Packaging is no longer an earned vendor: a check in code stopped one of its bills",
      detail: { counterpartyId: NORTHWIND.id, streak: 5, because: "code_stop", decisionSeq: 7, rule: "invoice.pay_to_differs", trigger: "cycle" },
    });
    const words = (because: Parameters<typeof earnedLostEntry>[0]["because"]) =>
      earnedLostEntry({ vendorId: "x", name: "Lumen Print Co.", streak: null, because, since: null, trigger: "rule" }).summary;
    expect(words("disagreed")).toBe("Lumen Print Co. is no longer an earned vendor: a person disagreed with a decision on one of its bills");
    expect(words("flagged")).toBe("Lumen Print Co. is no longer an earned vendor: one of its bills was flagged for review");
    expect(words("rule_changed")).toBe("Lumen Print Co. is no longer an earned vendor: the rule changed");
    expect(words("rule_off")).toBe("Lumen Print Co. is no longer an earned vendor: the rule is off");
    expect(words("no_payment_limit")).toBe("Lumen Print Co. is no longer an earned vendor: it has no payment limit");
    expect(words("high_risk")).toBe("Lumen Print Co. is no longer an earned vendor: it is screened high risk");
    expect(words("not_a_vendor")).toBe("Lumen Print Co. is no longer an earned vendor: it is not a vendor");
  });

  it("caps the evidence an entry carries at 50 decisions", () => {
    const { facts, agree } = book();
    agree(NORTHWIND, 60);
    const status = statusOf(earnedVendors(facts, 50), NORTHWIND.id) as Extract<EarnedStatus, { state: "earned" }>;
    const entry = earnedVendorEntry(status, 50, "cycle");
    expect(entry.detail.agreed).toBe(60);
    expect((entry.detail.evidence as number[]).length).toBe(50);
  });

  it("says each vendor's status as the report shows it, earned only once it is recorded", () => {
    const { facts, decide, agree } = book();
    agree(NORTHWIND, 5);
    decide(LUMEN, { verdict: "disagree" });
    agree(LUMEN, 2);
    decide({ ...LUMEN, id: "cp-flag", name: "Flagged Co." }, { action: "ap_flag_fraud", status: "flagged", verdict: "agree" });
    decide({ ...LUMEN, id: "cp-stop", name: "Stopped Co." }, { rule: "invoice.pay_to_differs" });
    decide({ ...LUMEN, id: "cp-none", name: "No Limit Co.", paymentLimit: null }, { verdict: "agree" });
    decide({ ...LUMEN, id: "cp-new", name: "Fresh Co." }, { verdict: "agree" });
    const statuses = earnedVendors(facts, 5);
    const words = (id: string, recordedEarned = false) => earnedStatusWords(statusOf(statuses, id)!, recordedEarned);
    expect(words(NORTHWIND.id, true)).toBe(`Earned: 5 agreed in a row, Oct 2, 2026 to Oct 6, 2026`);
    // Signed by the sync after a verdict, or as the agent's cycle starts on bills to decide: not by every cycle (AL16).
    expect(words(NORTHWIND.id)).toBe("Earned under your rule. It is recorded at your next verdict, or when the agent next decides a bill.");
    expect(words(LUMEN.id)).toBe("2 of 5 agreed in a row since you disagreed on Oct 7, 2026");
    expect(words("cp-flag")).toBe("0 of 5 agreed in a row since a bill was flagged for review on Oct 10, 2026");
    expect(words("cp-stop")).toBe(
      "0 of 5 agreed in a row since a check in code stopped a bill on Oct 11, 2026: the invoice asks to be paid to a different address from the one on file"
    );
    expect(words("cp-none")).toBe("Cannot earn it: no payment limit. Set one on Counterparties.");
    expect(words("cp-new")).toBe("1 of 5 agreed in a row");
    expect(earnedStatusWords({ vendorId: "c", name: "C", given: 1, state: "cannot", because: "not_a_vendor" }, false)).toBe("Cannot earn it: only a vendor can.");
    expect(earnedStatusWords({ vendorId: "h", name: "H", given: 6, state: "cannot", because: "high_risk" }, false)).toBe("Cannot earn it: screened high risk.");
  });

  it("marks in the live slice picker only a vendor earned now and recorded earned (AL19)", () => {
    const { facts, agree } = book();
    agree(NORTHWIND, 5);
    agree(LUMEN, 5);
    const statuses = earnedVendors(facts, 5);
    expect([...shownEarned({ streak: 5, statuses, recorded: new Set([NORTHWIND.id, "cp-gone"]) })]).toEqual([NORTHWIND.id]);
    expect(shownEarned({ streak: null, statuses: [], recorded: new Set([NORTHWIND.id]) }).size).toBe(0);
  });
});

describe("payments made on its own that wait for a verdict (AL26)", () => {
  it("counts an earned vendor's payments the agent made on its own with no verdict yet, and pauses it at 3", () => {
    const { facts, agree, decide } = book();
    agree(NORTHWIND, 5);
    const first = decide(NORTHWIND, { status: "paid", onItsOwn: true });
    decide(NORTHWIND, { status: "matched", onItsOwn: true });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", waiting: 2, paused: false });
    decide(NORTHWIND, { status: "paid", onItsOwn: true });
    expect(EARNED_WAITING_MAX).toBe(3);
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", waiting: 3, paused: true });
    // An agreed verdict on one of them ends its wait, and counts: the vendor is no longer paused.
    facts.verdicts.push({ entrySeq: first, verdict: "agree", decidedAt: at(20) });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ state: "earned", agreed: 6, waiting: 2, paused: false });
  });

  it("does not count a payment held for a verdict, one that went nowhere, or one made before shadow mode last started", () => {
    const { facts, agree, decide } = book();
    agree(NORTHWIND, 5);
    decide(NORTHWIND, { status: "held" });
    decide(NORTHWIND, { status: "held", onItsOwn: true });
    decide(NORTHWIND, { status: "paid", onItsOwn: true, day: 10 });
    decide(NORTHWIND, { status: "paid", onItsOwn: true, day: 12 });
    expect(statusOf(earnedVendors(facts, 5), NORTHWIND.id)).toMatchObject({ waiting: 2 });
    // A verdict can no longer be given on a decision made before shadow mode was last turned on: it waits for none.
    expect(statusOf(earnedVendors({ ...facts, shadow: { startedAt: at(11) } }, 5), NORTHWIND.id)).toMatchObject({ waiting: 1 });
    expect(statusOf(earnedVendors({ ...facts, shadow: null }, 5), NORTHWIND.id)).toMatchObject({ waiting: 0 });
  });

  it("says how many wait, and that the next waits for you once 3 do", () => {
    const { facts, agree, decide } = book();
    agree(NORTHWIND, 5);
    const status = () => statusOf(earnedVendors(facts, 5), NORTHWIND.id)!;
    expect(earnedWaitingWords(status())).toBeNull();
    decide(NORTHWIND, { status: "paid", onItsOwn: true });
    expect(earnedWaitingWords(status())).toBe("1 of its payments made on its own waits for your verdict.");
    decide(NORTHWIND, { status: "paid", onItsOwn: true });
    expect(earnedWaitingWords(status())).toBe("2 of its payments made on its own wait for your verdict.");
    decide(NORTHWIND, { status: "paid", onItsOwn: true });
    expect(earnedWaitingWords(status())).toBe("3 of its payments made on its own wait for your verdict, so its next waits for you.");
  });
});

describe("the owner's switch, in words (AL21, AL28)", () => {
  it("says what the switch does, off and on, and what turning it on means, in test USDC or simulated", () => {
    expect(EARNED_PAYMENTS_OFF).toBe("Earned vendors' payments wait for your verdict, as every payment in shadow mode does.");
    expect(EARNED_PAYMENTS_ON).toBe("The agent pays earned vendors on its own, within every limit and check, and you give your verdict after.");
    expect(earnedPaymentsConfirm(false)).toBe(
      "In shadow mode, a payment to a vendor that earned it under your rule is made without waiting for your verdict, in test USDC on Arc testnet. Every limit and check still applies, and it counts against the agent's spending limit. You give your verdict after, and one disagreement takes the vendor's status away. At most 3 of a vendor's payments wait for your verdict at once."
    );
    expect(earnedPaymentsConfirm(true)).toContain("is made without waiting for your verdict, simulated: nothing is sent on chain.");
    expect(earnedPaymentsSummary(true)).toBe("The agent pays earned vendors on its own in shadow mode");
    expect(earnedPaymentsSummary(false)).toBe("Earned vendors' payments wait for a verdict again");
  });
});
