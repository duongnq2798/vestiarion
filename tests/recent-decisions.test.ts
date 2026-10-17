import { beforeEach, describe, expect, it, vi } from "vitest";
import { decisionOutcome, recentDecisionView, type DecisionFacts } from "@/lib/latest-decision";

/**
 * The agent's earlier decisions in words (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md D2, D3):
 * what came of each in a word, the sentence, why, the network with real or test money, and the transaction only when
 * one went out; and the read of `recent_team_decisions()`, which shows nothing when it fails.
 */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({ rpc }),
}));

import { earlierThan, readRecentDecisions } from "@/lib/platform/recent-decisions";

const TX = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-10-11T12:00:00Z");

const paid: DecisionFacts = {
  seq: 2588,
  ts: "2026-10-11T04:00:00Z",
  action: "ap_pay",
  network: "arc-testnet",
  amount: 0.2,
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
};

const view = (facts: Partial<DecisionFacts>) => recentDecisionView({ ...paid, ...facts }, NOW);
const outcome = (facts: Partial<DecisionFacts>) => decisionOutcome({ ...paid, ...facts });

describe("recentDecisionView", () => {
  it("says a paid bill, what was checked before it went out, and links its transaction on the network's explorer", () => {
    expect(view({})).toMatchObject({
      seq: 2588,
      at: "2026-10-11T04:00:00Z",
      ago: "8 h ago",
      atUtc: "Oct 11, 2026, 04:00 UTC",
      network: "arc-testnet",
      networkLabel: "Arc testnet",
      realMoney: false,
      outcome: { kind: "paid", label: "Paid", tone: "proof" },
      headline: "Paid a 0.20 USDC bill.",
      detail: "Rules in code passed it. The written policy agreed.",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
    });
  });

  it("calls Arc mainnet real money, and links its own explorer", () => {
    const shown = view({ network: "arc-mainnet" });
    expect(shown).toMatchObject({ networkLabel: "Arc mainnet", realMoney: true });
    expect(shown.txUrl).toContain(TX);
    expect(shown.txUrl).not.toContain("testnet");
  });

  it("says code refused a payment the model proposed, and why, with no transaction", () => {
    const shown = view({ resultingStatus: "held", txRef: null, guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap", agreedWithReference: false });
    expect(shown.outcome).toEqual({ kind: "refused", label: "Refused by code", tone: "refused" });
    expect(shown.headline).toBe("Decided to pay a 0.20 USDC bill.");
    expect(shown.detail).toBe("Code refused it: the cross-chain fee was above its cap.");
    expect(shown.txUrl).toBeNull();
  });

  it("says why a hold held, by what the stage recorded", () => {
    const shown = view({ action: "ap_hold", resultingStatus: "held", txRef: null, heldBecause: "cash_shortfall" });
    expect(shown.outcome.kind).toBe("held");
    expect(shown.headline).toBe("Held a 0.20 USDC bill.");
    expect(shown.detail).toBe("The operating wallet was short of cash for it.");
    expect(view({ action: "ap_hold", resultingStatus: "held", txRef: null }).detail).toBe("The model held it for a person to look at.");
  });

  it("says a person's part in shadow mode: waiting, agreed, disagreed, and paid once their payment confirmed", () => {
    const shadow = { resultingStatus: "held", txRef: null, heldBecause: "shadow_verdict" };
    expect(outcome(shadow)).toMatchObject({ kind: "awaiting_person", label: "Awaiting a person" });
    expect(outcome({ ...shadow, verdict: "agree" })).toMatchObject({ kind: "person_agreed", label: "Person agreed" });
    expect(outcome({ ...shadow, verdict: "disagree" })).toMatchObject({ kind: "person_disagreed", label: "Person disagreed" });
    const paidLater = view({ ...shadow, verdict: "agree", paidTxHash: TX });
    expect(paidLater.outcome.kind).toBe("paid");
    expect(paidLater.headline).toBe("Paid a 0.20 USDC bill after a person agreed.");
    expect(paidLater.detail).toBe("In shadow mode, a person agrees before anything is paid.");
    expect(paidLater.txUrl).toContain(TX);
  });

  it("says a flag, a question and a schedule in their own words, and nothing about the bill since", () => {
    expect(view({ action: "ap_flag_fraud", resultingStatus: "flagged", txRef: null })).toMatchObject({
      outcome: { kind: "flagged", label: "Flagged" },
      headline: "Flagged a 0.20 USDC bill as possible fraud.",
      detail: null,
    });
    expect(view({ action: "ap_request_info", resultingStatus: "awaiting_info", txRef: null })).toMatchObject({
      outcome: { kind: "asked", label: "Asked for details" },
      headline: "Asked for a missing detail on a 0.20 USDC bill.",
      detail: null,
    });
    expect(view({ action: "ap_schedule", resultingStatus: "scheduled", txRef: null, payOn: "2026-10-14" })).toMatchObject({
      outcome: { kind: "scheduled", label: "Scheduled" },
      headline: "Scheduled a 0.20 USDC bill for Oct 14.",
      detail: "Rules in code passed it. The written policy agreed.",
      txUrl: null,
    });
  });

  it("never calls a schedule code refused, or something held, scheduled", () => {
    const refused = view({
      action: "ap_schedule",
      resultingStatus: "held",
      txRef: null,
      payOn: "2026-10-20",
      guardrailBlocked: true,
      guardrailRule: "counterparty.payment_limit",
    });
    expect(refused).toMatchObject({
      outcome: { kind: "refused", label: "Refused by code" },
      headline: "Decided to schedule a 0.20 USDC bill for Oct 20.",
      detail: "Code refused it: it is above the payee's payment limit.",
    });
    const held = view({ action: "ap_schedule", resultingStatus: "held", txRef: null, payOn: "2026-10-20", heldBecause: "cash_shortfall" });
    expect(held).toMatchObject({
      outcome: { kind: "held", label: "Held" },
      headline: "Decided to schedule a 0.20 USDC bill for Oct 20.",
      detail: "The operating wallet was short of cash for it.",
    });
  });

  it("says what came of a payment still confirming when it was recorded: paid once it confirmed, failed once it failed", () => {
    const sent = { resultingStatus: "matched", txRef: null };
    expect(view(sent)).toMatchObject({ outcome: { kind: "confirming", label: "Confirming" }, headline: "Submitted a 0.20 USDC bill; waiting for Circle to confirm it on Arc testnet." });
    expect(view({ ...sent, paidTxHash: TX })).toMatchObject({ outcome: { kind: "paid" }, headline: "Paid a 0.20 USDC bill." });
    const failed = view({ ...sent, paymentFailed: true });
    expect(failed).toMatchObject({ outcome: { kind: "failed", label: "Transfer failed", tone: "refused" }, headline: "Submitted a 0.20 USDC bill; the transfer failed." });
    expect(failed.txUrl).toBeNull();
  });

  it("says only what the entry recorded about the checks", () => {
    expect(view({ decisionMode: "heuristic", agreedWithReference: null }).detail).toBe("Rules in code passed it. No model answered, so the written policy decided.");
    // The rules in code come first: they decide. A written policy that differed is said to be kept only to compare.
    expect(view({ agreedWithReference: false }).detail).toBe("Rules in code passed it. The written policy, kept only to compare, would have decided otherwise.");
    expect(view({ agreedWithReference: null, guardrailBlocked: null }).detail).toBeNull();
    expect(view({ action: "ap_pay", resultingStatus: "held", txRef: null }).detail).toBeNull();
  });

  it("never links a reference that is not a transaction hash", () => {
    expect(view({ txRef: "sim:2f4c" }).txUrl).toBeNull();
  });
});

describe("earlierThan", () => {
  it("lists only decisions older than the latest one shown above, at most three", () => {
    const rows = [9, 8, 7, 6, 5, 4, 3, 2].map((seq) => view({ seq }));
    expect(earlierThan(rows, 8).map((row) => row.seq)).toEqual([7, 6, 5]);
    expect(earlierThan(rows, 3).map((row) => row.seq)).toEqual([2]);
    expect(earlierThan(rows, 2)).toEqual([]);
  });

  it("gives the last place to the newest refusal by code when none of the newest was refused", () => {
    const refused = { action: "ap_hold", resultingStatus: "held", txRef: null, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit" };
    const rows = [9, 8, 7, 6, 5, 4].map((seq) => view(seq === 5 || seq === 4 ? { seq, ...refused } : { seq }));
    expect(earlierThan(rows, 9).map((row) => row.seq)).toEqual([8, 7, 5]);
    // A refusal already among the newest keeps them as they are.
    const early = [9, 8, 7, 6, 5].map((seq) => view(seq === 7 ? { seq, ...refused } : { seq }));
    expect(earlierThan(early, 9).map((row) => row.seq)).toEqual([8, 7, 6]);
    // With no refusal read, the newest stand.
    expect(earlierThan([9, 8, 7, 6, 5].map((seq) => view({ seq })), 9).map((row) => row.seq)).toEqual([8, 7, 6]);
  });
});

// Each test reads at its own minute, past the previous one's memo.
let minute = 0;
const at = () => NOW + (minute += 5) * 60_000;

const FOUND = { decisions: [{ ...paid, seq: "2588", amount: "0.2" }], pastWeek: { "arc-mainnet": 4, "arc-testnet": "57" } };

beforeEach(() => {
  rpc.mockReset();
});

describe("readRecentDecisions", () => {
  it("reads the team's earlier decisions and the week's counts, each network apart", async () => {
    rpc.mockResolvedValue({ data: FOUND, error: null });
    const found = await readRecentDecisions(at());
    expect(rpc).toHaveBeenCalledWith("recent_team_decisions", { p_limit: 12 });
    expect(found?.pastWeek).toEqual({ mainnet: 4, testnet: 57 });
    expect(found?.decisions).toHaveLength(1);
    expect(found?.decisions[0]).toMatchObject({ seq: 2588, headline: "Paid a 0.20 USDC bill.", outcome: { kind: "paid" } });
  });

  it("reads at most once a minute", async () => {
    rpc.mockResolvedValue({ data: FOUND, error: null });
    const now = at();
    await readRecentDecisions(now);
    await readRecentDecisions(now + 30_000);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the function is not there yet or the read fails, and tries again next time", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function public.recent_team_decisions" } });
    const now = at();
    expect(await readRecentDecisions(now)).toBeNull();
    rpc.mockResolvedValue({ data: FOUND, error: null });
    expect(await readRecentDecisions(now + 1_000)).not.toBeNull();
    quiet.mockRestore();
  });

  it("shows nothing when a row is not what it should be", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: { decisions: [{ ...paid, network: "base-sepolia" }], pastWeek: { "arc-mainnet": 0, "arc-testnet": 0 } }, error: null });
    expect(await readRecentDecisions(at())).toBeNull();
    quiet.mockRestore();
  });
});
