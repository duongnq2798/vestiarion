import { describe, expect, it } from "vitest";
import {
  BALANCE_FRESH_MS,
  PLAN_DAYS,
  planFreshness,
  planPayments,
  type PaymentPlanInput,
  type PlanBill,
  type PlanLine,
  type PlanMilestone,
} from "@/lib/payment-plan";

/**
 * The payment plan (docs/superpowers/specs/2026-10-11-payment-plan-design.md), as a pure function over hand-made
 * rows. Today is Oct 11, 2026 (UTC); the window runs to Oct 24.
 */

const NOW = Date.UTC(2026, 9, 11, 9, 0);
const ISO_DAY = (day: string) => `${day}T12:00:00.000Z`;
const MIDNIGHT = (day: string) => `${day}T00:00:00.000Z`;

const bill = (fields: Partial<PlanBill> = {}): PlanBill => ({
  id: "b-1",
  counterpartyId: "c-1",
  payee: "Northwind Supply",
  payeeAddress: "0xabc",
  amount: 100,
  currency: "USDC",
  dueDate: ISO_DAY("2026-10-20"),
  status: "scheduled",
  scheduledFor: MIDNIGHT("2026-10-20"),
  discount: null,
  paymentLimit: null,
  riskLevel: "clear",
  createdBy: "u-maker",
  ...fields,
});

const milestone = (fields: Partial<PlanMilestone> = {}): PlanMilestone => ({
  id: "m-1",
  counterpartyId: "c-9",
  payee: "Ada Lovelace",
  title: "Design review",
  amount: 50,
  status: "verified",
  escrowState: null,
  paymentLimit: null,
  riskLevel: "clear",
  ...fields,
});

const input = (fields: Partial<PaymentPlanInput> = {}): PaymentPlanInput => ({
  now: NOW,
  operatingUsdc: 1000,
  reserveUsdc: 0,
  reserveApy: 0,
  cushion: 0,
  bills: [],
  milestones: [],
  limits: { budget: null, twoApprovalsAbove: null },
  balance: { kind: "simulated" },
  unread: [],
  ...fields,
});

const line = (plan: { lines: PlanLine[] }, id: string): PlanLine => {
  const found = plan.lines.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no line ${id}`);
  return found;
};
const flagCodes = (planLine: PlanLine) => planLine.flags.map((flag) => flag.code);

describe("the window", () => {
  it("runs fourteen UTC days, today included", () => {
    const plan = planPayments(input());
    expect(PLAN_DAYS).toBe(14);
    expect(plan.today).toBe("2026-10-11");
    expect(plan.through).toBe("2026-10-24");
  });

  it("leaves out a bill due after the window unless its discount deadline falls in it", () => {
    const plan = planPayments(
      input({
        bills: [
          bill({ id: "later", dueDate: ISO_DAY("2026-11-02"), scheduledFor: MIDNIGHT("2026-11-02") }),
          bill({ id: "deal", dueDate: ISO_DAY("2026-11-02"), scheduledFor: MIDNIGHT("2026-11-02"), discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } }),
        ],
      })
    );
    expect(plan.lines.map((planLine) => planLine.id)).toEqual(["deal"]);
    expect(line(plan, "deal").on).toBe("2026-10-14");
  });

  it("never offers a move out of the 14 days: a bill the agent scheduled inside them, due after them, keeps its day", () => {
    const plan = planPayments(input({ operatingUsdc: 5000, bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-30"), scheduledFor: MIDNIGHT("2026-10-20") })] }));
    const only = line(plan, "b-1");
    expect(only).toMatchObject({ on: "2026-10-20", inWindow: true, pays: 1000, move: null, approvable: false, balanceAfter: 4000 });
    expect(only.reason).toBe("Pays on Oct 20, 2026, as the agent scheduled it, ahead of its due date, Oct 30, 2026: the plan never moves a payment later than the agent chose.");
    expect(plan.days).toEqual([{ day: "2026-10-20", out: 1000, balance: 4000, balanceNow: 4000 }]);
  });

  it("keeps a discount day the agent chose inside the 14 days when the due date falls after them, whatever the limit or the other bills", () => {
    // 2/10 net 30, and the agent may pay 500 a day on its own: neither 980 on Oct 21 nor 1,000 on Nov 10 is its alone.
    const alpha = (fields: Partial<PlanBill>) =>
      bill({ id: "alpha", payee: "Alpha Freight", amount: 1000, dueDate: ISO_DAY("2026-11-10"), scheduledFor: MIDNIGHT("2026-10-21"), discount: { pct: 2, deadline: ISO_DAY("2026-10-21") }, ...fields });
    const limited = planPayments(input({ operatingUsdc: 5000, limits: { budget: { dailyUsdc: 500, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null }, bills: [alpha({})] }));
    expect(line(limited, "alpha")).toMatchObject({ on: "2026-10-21", pays: 980, move: null, approvable: false, agentPays: false });
    expect(line(limited, "alpha").discount).toMatchObject({ taken: true, value: 20 });
    expect(flagCodes(line(limited, "alpha"))).toEqual(["over_agent_limit"]);

    // The cash covers Alpha or Xeno, not both: moved after the window, Alpha would lose its discount and still be short.
    const short = planPayments(
      input({
        operatingUsdc: 1000,
        bills: [
          alpha({ dueDate: ISO_DAY("2026-11-05"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 2, deadline: ISO_DAY("2026-10-20") } }),
          bill({ id: "xeno", payee: "Xeno Labs", counterpartyId: "c-2", amount: 100, dueDate: ISO_DAY("2026-10-22"), status: "pending", scheduledFor: null }),
        ],
      })
    );
    expect(line(short, "alpha")).toMatchObject({ on: "2026-10-20", pays: 980, move: null });
    expect(flagCodes(line(short, "xeno"))).toEqual(["short"]);
    expect(short.stillOwed).toBe(100);
    expect(short.moves).toBe(0);
  });
});

describe("each bill's day (P4)", () => {
  it("pays a bill with no discount on its due date, and offers no move when the agent chose that day", () => {
    const plan = planPayments(input({ bills: [bill()] }));
    const only = line(plan, "b-1");
    expect(only.on).toBe("2026-10-20");
    expect(only.move).toBeNull();
    expect(only.approvable).toBe(false);
    expect(only.reason).toBe("No early-payment discount: pays on its due date, Oct 20, 2026.");
  });

  it("puts what is already on its way first today, then overdue bills oldest first, then the one due today", () => {
    const plan = planPayments(
      input({
        bills: [
          bill({ id: "due-today", status: "pending", scheduledFor: null, dueDate: ISO_DAY("2026-10-11") }),
          bill({ id: "overdue-new", status: "pending", scheduledFor: null, dueDate: ISO_DAY("2026-10-09") }),
          bill({ id: "overdue-old", status: "pending", scheduledFor: null, dueDate: ISO_DAY("2026-10-02") }),
          bill({ id: "sent", status: "matched", scheduledFor: null, dueDate: ISO_DAY("2026-10-15") }),
        ],
      })
    );
    expect(plan.lines.map((planLine) => [planLine.id, planLine.on])).toEqual([
      ["sent", "2026-10-11"],
      ["overdue-old", "2026-10-11"],
      ["overdue-new", "2026-10-11"],
      ["due-today", "2026-10-11"],
    ]);
    expect(line(plan, "overdue-old").reason).toBe("Overdue since Oct 2, 2026: first in line today.");
    expect(line(plan, "due-today").reason).toBe("Due today.");
    expect(line(plan, "sent").state).toBe("on_its_way");
  });

  it("takes a discount on its deadline when the balance stays above the cushion, and offers the move", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 2000,
        cushion: 100,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })],
      })
    );
    const only = line(plan, "b-1");
    expect(only.on).toBe("2026-10-15");
    expect(only.pays).toBe(980);
    expect(only.discount).toEqual({ pct: 2, value: 20, until: "2026-10-15", taken: true });
    expect(only.move).toEqual({ from: "2026-10-22", to: "2026-10-15" });
    expect(only.approvable).toBe(true);
    expect(only.reason).toBe("Pays on Oct 15, 2026, the discount's last day, to take the 2% early-payment discount (20.00 USDC); the balance stays above the cushion.");
    expect(plan.discountsPlanned).toBe(20);
    expect(plan.moves).toBe(1);
  });

  it("does not propose paying early when that takes the balance under the cushion before the due date, and says on which day", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 1100,
        cushion: 200,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })],
      })
    );
    const only = line(plan, "b-1");
    expect(only.on).toBe("2026-10-22");
    expect(only.pays).toBe(1000);
    expect(only.discount).toMatchObject({ taken: false, value: 20 });
    expect(only.reason).toBe(
      "Pays on its due date, Oct 22, 2026: paying on Oct 15, 2026 for the 2% discount (20.00 USDC) would take the balance under the cushion on Oct 15, 2026."
    );
    // An obligation is never delayed to protect the cushion: on its due day it is paid, and says what it leaves.
    expect(flagCodes(only)).toEqual(["below_cushion"]);
    expect(only.move).toBeNull();
    expect(plan.discountsPlanned).toBe(0);
  });

  it("keeps the discount day the agent chose when only the cushion stands against it: a payment is never moved later to protect the cushion", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 1100,
        cushion: 200,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })],
      })
    );
    const only = line(plan, "b-1");
    expect(only.on).toBe("2026-10-15");
    expect(only.pays).toBe(980);
    expect(only.discount).toEqual({ pct: 2, value: 20, until: "2026-10-15", taken: true });
    expect(only.reason).toBe(
      "Pays on Oct 15, 2026, the discount's last day, as the agent scheduled it, to take the 2% early-payment discount (20.00 USDC). The balance goes under the cushion on Oct 15, 2026; the plan never moves a payment later only to protect the cushion."
    );
    expect(flagCodes(only)).toEqual(["below_cushion"]);
    expect(only.move).toBeNull();
    expect(only.approvable).toBe(false);
    expect(plan.moves).toBe(0);
    expect(plan.discountsPlanned).toBe(20);
  });

  it("weighs the agent's own discount days first, and proposes no other that takes the balance further under the cushion", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 1100,
        cushion: 200,
        bills: [
          bill({ id: "agent", amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } }),
          // Its deadline comes first, but it is weighed against the agent's own choice.
          bill({ id: "deal", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 50, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 2, deadline: ISO_DAY("2026-10-13") } }),
        ],
      })
    );
    expect(line(plan, "agent")).toMatchObject({ on: "2026-10-15", move: null });
    expect(line(plan, "deal")).toMatchObject({ on: "2026-10-20", move: null });
    expect(line(plan, "deal").reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 13, 2026 for the 2% discount (1.00 USDC) would take the balance further under the cushion on Oct 15, 2026."
    );
  });

  it("weighs the cushion only until the due date, where the discount starts leaving more cash, never less", () => {
    // Without the discount the balance ends at 100 on Oct 21; with it, at 110. Both are under the 135 cushion, but only
    // because of Beta: from Oct 13 to Oct 15, the days the discount costs cash, the balance stays at 510.
    const plan = (alphaOn: string) =>
      planPayments(
        input({
          operatingUsdc: 1000,
          cushion: 135,
          bills: [
            bill({ id: "alpha", payee: "Alpha Freight", amount: 500, dueDate: ISO_DAY("2026-10-16"), scheduledFor: MIDNIGHT(alphaOn), discount: { pct: 2, deadline: ISO_DAY("2026-10-13") } }),
            bill({ id: "beta", payee: "Beta Hosting", counterpartyId: "c-2", amount: 400, dueDate: ISO_DAY("2026-10-21"), scheduledFor: MIDNIGHT("2026-10-21") }),
          ],
        })
      );
    const proposed = plan("2026-10-16");
    expect(line(proposed, "alpha")).toMatchObject({ on: "2026-10-13", pays: 490, move: { from: "2026-10-16", to: "2026-10-13" }, approvable: true });
    expect(line(proposed, "alpha").reason).toBe(
      "Pays on Oct 13, 2026, the discount's last day, to take the 2% early-payment discount (10.00 USDC); the balance stays above the cushion until Oct 21, 2026."
    );
    expect(proposed.days).toEqual([
      { day: "2026-10-13", out: 490, balance: 510, balanceNow: 1000 },
      { day: "2026-10-16", out: 0, balance: 510, balanceNow: 500 },
      { day: "2026-10-21", out: 400, balance: 110, balanceNow: 100 },
    ]);
    // The agent chose the deadline itself: the plan keeps it, offering no move that would lose the discount.
    const kept = plan("2026-10-13");
    expect(line(kept, "alpha")).toMatchObject({ on: "2026-10-13", pays: 490, move: null, approvable: false });
    expect(line(kept, "alpha").discount).toMatchObject({ taken: true, value: 10 });
    expect(kept.moves).toBe(0);
  });

  it("does not take a discount that would leave another bill short", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 1500,
        bills: [
          bill({ id: "rent", amount: 1000, dueDate: ISO_DAY("2026-10-16"), scheduledFor: MIDNIGHT("2026-10-16") }),
          bill({ id: "deal", amount: 1000, dueDate: ISO_DAY("2026-10-23"), scheduledFor: MIDNIGHT("2026-10-23"), discount: { pct: 10, deadline: ISO_DAY("2026-10-13") } }),
        ],
      })
    );
    expect(line(plan, "rent").flags).toEqual([]);
    expect(line(plan, "deal").on).toBe("2026-10-23");
    expect(line(plan, "deal").reason).toContain("would leave Northwind Supply short on Oct 16, 2026");
  });

  it("does not take a discount that would put it, or another payment, above what the agent may pay on its own that day", () => {
    const limits = { budget: { dailyUsdc: 500, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null };
    // The rent fits the day's 500; the deal paid that day too would not.
    const itself = planPayments(
      input({
        limits,
        bills: [
          bill({ id: "rent", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 400, dueDate: ISO_DAY("2026-10-13"), scheduledFor: MIDNIGHT("2026-10-13") }),
          bill({ id: "deal", amount: 300, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 5, deadline: ISO_DAY("2026-10-13") } }),
        ],
      })
    );
    expect(line(itself, "deal").on).toBe("2026-10-20");
    expect(line(itself, "deal").reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 13, 2026 for the 5% discount (15.00 USDC) would be above what the agent may pay on its own on Oct 13, 2026."
    );
    expect(line(itself, "deal").flags).toEqual([]);
    expect(line(itself, "rent").agentPays).toBe(true);

    // Two discounts ending the same day: the larger is taken; the smaller, paid first that day for its earlier due date,
    // would leave the larger above the limit.
    const other = planPayments(
      input({
        limits,
        bills: [
          bill({ id: "big", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 400, dueDate: ISO_DAY("2026-10-24"), scheduledFor: MIDNIGHT("2026-10-24"), discount: { pct: 5, deadline: ISO_DAY("2026-10-13") } }),
          bill({ id: "small", amount: 300, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 1, deadline: ISO_DAY("2026-10-13") } }),
        ],
      })
    );
    expect(line(other, "big").on).toBe("2026-10-13");
    expect(line(other, "big").agentPays).toBe(true);
    expect(line(other, "small").on).toBe("2026-10-20");
    expect(line(other, "small").reason).toContain("would leave Harbor Office Supply above what the agent may pay on its own on Oct 13, 2026");
  });

  it("takes a discount whose deadline is today, today", () => {
    const plan = planPayments(
      input({ bills: [bill({ amount: 100, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 1, deadline: ISO_DAY("2026-10-11") } })] })
    );
    expect(line(plan, "b-1").on).toBe("2026-10-11");
    expect(line(plan, "b-1").move).toEqual({ from: "2026-10-20", to: "2026-10-11" });
    expect(line(plan, "b-1").reason).toBe("Pays today, the discount's last day, to take the 1% early-payment discount (1.00 USDC); the balance stays above the cushion.");
  });

  it("keeps the due date when the reserve's yield until then is worth more than the discount, as the agent decides", () => {
    // 1,000 USDC at 5% a year for the 9 days from Oct 13 to Oct 22 is 1.232877 USDC; the 0.1% discount is 1 USDC.
    const plan = planPayments(
      input({
        reserveApy: 0.05,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22"), discount: { pct: 0.1, deadline: ISO_DAY("2026-10-13") } })],
      })
    );
    const only = line(plan, "b-1");
    expect(only.on).toBe("2026-10-22");
    expect(only.move).toBeNull();
    expect(only.discount).toMatchObject({ taken: false, value: 1 });
    expect(only.reason).toBe(
      "Pays on its due date, Oct 22, 2026: the reserve's yield until then (1.232877 USDC) is worth more than the 0.1% early-payment discount (1.00 USDC), as the agent decides."
    );
    expect(plan.discountsPlanned).toBe(0);
  });

  it("tries a discount worth at least the yield, and never moves a bill later only to earn yield", () => {
    const deal = (scheduledFor: string, pct: number) =>
      planPayments(
        input({
          reserveApy: 0.05,
          bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT(scheduledFor), discount: { pct, deadline: ISO_DAY("2026-10-13") } })],
        })
      );
    // 2% (20 USDC) beats 1.23 USDC of yield: the plan proposes the deadline.
    expect(line(deal("2026-10-22", 2), "b-1").move).toEqual({ from: "2026-10-22", to: "2026-10-13" });
    // The agent already chose the deadline for a smaller discount: the plan keeps it, never moving it later for yield.
    const kept = line(deal("2026-10-13", 0.1), "b-1");
    expect(kept.on).toBe("2026-10-13");
    expect(kept.move).toBeNull();
    expect(kept.discount).toMatchObject({ taken: true, value: 1 });
  });

  it("keeps a day the agent chose before the discount's last day, never moving it later for no gain", () => {
    const plan = (operatingUsdc: number, cushion: number) =>
      planPayments(
        input({ operatingUsdc, cushion, bills: [bill({ amount: 1000, scheduledFor: MIDNIGHT("2026-10-13"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })] })
      );
    const ample = line(plan(5000, 0), "b-1");
    expect(ample).toMatchObject({ on: "2026-10-13", pays: 980, move: null, approvable: false });
    expect(ample.discount).toEqual({ pct: 2, value: 20, until: "2026-10-15", taken: true });
    expect(ample.reason).toBe(
      "Pays on Oct 13, 2026, as the agent scheduled it, to take the 2% early-payment discount (20.00 USDC), which lasts until Oct 15, 2026; the balance stays above the cushion."
    );
    const tight = line(plan(1100, 200), "b-1");
    expect(tight).toMatchObject({ on: "2026-10-13", move: null, approvable: false });
    expect(tight.reason).toBe(
      "Pays on Oct 13, 2026, as the agent scheduled it, to take the 2% early-payment discount (20.00 USDC), which lasts until Oct 15, 2026. The balance goes under the cushion on Oct 13, 2026; the plan never moves a payment later only to protect the cushion."
    );
    // A discount lasting past the 14 days: the agent's day inside them is kept, never moved out of the window.
    const outside = line(
      planPayments(input({ operatingUsdc: 5000, bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-30"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 2, deadline: ISO_DAY("2026-10-26") } })] })),
      "b-1"
    );
    expect(outside).toMatchObject({ on: "2026-10-20", inWindow: true, pays: 980, move: null });
  });

  it("keeps a day the agent chose before the due date when there is no discount to take", () => {
    const only = line(planPayments(input({ bills: [bill({ scheduledFor: MIDNIGHT("2026-10-15") })] })), "b-1");
    expect(only).toMatchObject({ on: "2026-10-15", move: null, approvable: false });
    expect(only.reason).toBe("Pays on Oct 15, 2026, as the agent scheduled it, ahead of its due date, Oct 20, 2026: the plan never moves a payment later than the agent chose.");
  });

  it("pays early for a discount when that is what lets the cash cover the bill at all, cushion or not", () => {
    // 990 covers 980 on Oct 15, not 1,000 on Oct 20.
    for (const fields of [{ status: "pending", scheduledFor: null }, { scheduledFor: MIDNIGHT("2026-10-20") }]) {
      const plan = planPayments(input({ operatingUsdc: 990, cushion: 150, bills: [bill({ amount: 1000, discount: { pct: 2, deadline: ISO_DAY("2026-10-15") }, ...fields })] }));
      const only = line(plan, "b-1");
      expect(only).toMatchObject({ on: "2026-10-15", pays: 980, balanceAfter: 10 });
      expect(only.discount).toMatchObject({ taken: true, value: 20 });
      expect(flagCodes(only)).toEqual(["below_cushion"]);
      expect(only.reason).toBe(
        "Pays on Oct 15, 2026, the discount's last day, to take the 2% early-payment discount (20.00 USDC): on its due date, Oct 20, 2026, the cash would not cover it."
      );
      expect(plan.stillOwed).toBe(0);
      expect(plan.stillOwedNow).toBe(1000);
    }
    // Scheduled by the agent after the deadline, before the due date: that is the day the cash would not cover.
    const agentDay = line(
      planPayments(input({ operatingUsdc: 990, cushion: 150, bills: [bill({ amount: 1000, scheduledFor: MIDNIGHT("2026-10-17"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })] })),
      "b-1"
    );
    expect(agentDay).toMatchObject({ on: "2026-10-15", move: { from: "2026-10-17", to: "2026-10-15" }, approvable: true });
    expect(agentDay.reason).toBe(
      "Pays on Oct 15, 2026, the discount's last day, to take the 2% early-payment discount (20.00 USDC): on Oct 17, 2026, as the agent scheduled it, the cash would not cover it."
    );
  });

  it("never pays a bill early when that leaves another short, not even one the cash cannot cover on its due date", () => {
    // Without the discount Xeno takes 100 and the deal's 1,000 is short; with it the deal would take 980 and leave Xeno
    // short, a bill the cash covers now: the plan does not trade one for the other.
    const plan = planPayments(
      input({
        operatingUsdc: 1000,
        bills: [
          bill({ id: "deal", amount: 1000, discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } }),
          bill({ id: "xeno", payee: "Xeno Labs", counterpartyId: "c-2", amount: 100, dueDate: ISO_DAY("2026-10-18"), scheduledFor: MIDNIGHT("2026-10-18") }),
        ],
      })
    );
    expect(line(plan, "deal")).toMatchObject({ on: "2026-10-20", move: null });
    expect(line(plan, "deal").reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 15, 2026 for the 2% discount (20.00 USDC) would leave Xeno Labs short on Oct 18, 2026."
    );
    expect(flagCodes(line(plan, "deal"))).toEqual(["short"]);
    expect(flagCodes(line(plan, "xeno"))).toEqual([]);
    expect(plan.stillOwed).toBe(1000);
  });

  it("does not take a discount the cash cannot cover on its last day, and counts a bill short on its day at the full amount", () => {
    const plan = planPayments(input({ operatingUsdc: 500, bills: [bill({ amount: 1000, discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })] }));
    const only = line(plan, "b-1");
    expect(only).toMatchObject({ on: "2026-10-20", pays: 1000, move: null });
    expect(only.discount).toMatchObject({ taken: false, value: 20 });
    expect(only.reason).toBe("Pays on its due date, Oct 20, 2026: paying on Oct 15, 2026 for the 2% discount (20.00 USDC) would be short of cash on Oct 15, 2026.");
    expect(flagCodes(only)).toEqual(["short"]);
    expect(plan.stillOwed).toBe(1000);

    // The agent's own discount day is kept, short: once the day passes unpaid, the bill owes its full amount.
    const kept = planPayments(input({ operatingUsdc: 500, bills: [bill({ amount: 1000, scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })] }));
    const agent = line(kept, "b-1");
    expect(agent).toMatchObject({ on: "2026-10-15", pays: 980, move: null });
    expect(agent.discount).toMatchObject({ taken: false });
    expect(flagCodes(agent)).toEqual(["short"]);
    expect(kept.stillOwed).toBe(1000);
    expect(kept.discountsPlanned).toBe(0);
  });

  it("offers no move whose checks hold only with another move approved too", () => {
    const limits = { budget: { dailyUsdc: 1000, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null };
    // Alpha leaves Oct 15 for its discount on Oct 12; Beta's discount fits Oct 15's room only once Alpha has left it.
    const plan = planPayments(
      input({
        operatingUsdc: 5000,
        limits,
        bills: [
          bill({ id: "alpha", payee: "Alpha Freight", amount: 800, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-12") } }),
          bill({ id: "beta", payee: "Beta Hosting", counterpartyId: "c-2", amount: 500, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-20"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } }),
        ],
      })
    );
    expect(line(plan, "alpha")).toMatchObject({ on: "2026-10-12", move: { from: "2026-10-15", to: "2026-10-12" }, approvable: true });
    expect(line(plan, "beta")).toMatchObject({ on: "2026-10-20", move: null });
    expect(line(plan, "beta").reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 15, 2026 for the 2% discount (10.00 USDC) would be above what the agent may pay on its own on Oct 15, 2026, as the bills are scheduled now."
    );

    // The agent scheduled Xeno after its due date: brought back to it only if that day's room holds without Yara's move.
    const late = planPayments(
      input({
        operatingUsdc: 5000,
        limits,
        bills: [
          bill({ id: "xeno", payee: "Xeno Labs", amount: 600, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-18") }),
          bill({ id: "yara", payee: "Yara Print", counterpartyId: "c-2", amount: 500, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-13") } }),
        ],
      })
    );
    expect(line(late, "yara")).toMatchObject({ on: "2026-10-13", move: { from: "2026-10-15", to: "2026-10-13" }, approvable: true });
    expect(line(late, "xeno")).toMatchObject({ on: "2026-10-18", move: null });
    expect(line(late, "xeno").reason).toBe(
      "Pays on Oct 18, 2026, as the agent scheduled it: paying on its due date, Oct 15, 2026, would be above what the agent may pay on its own on Oct 15, 2026, as the bills are scheduled now."
    );

    // Nor is it brought back when that leaves another bill short that the cash covers now.
    const short = planPayments(
      input({
        operatingUsdc: 1000,
        bills: [
          bill({ id: "xeno", payee: "Xeno Labs", amount: 600, dueDate: ISO_DAY("2026-10-13"), scheduledFor: MIDNIGHT("2026-10-20") }),
          bill({ id: "zeta", payee: "Zeta Freight", counterpartyId: "c-2", amount: 500, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-15") }),
        ],
      })
    );
    expect(line(short, "xeno")).toMatchObject({ on: "2026-10-20", move: null });
    expect(line(short, "xeno").reason).toBe(
      "Pays on Oct 20, 2026, as the agent scheduled it: paying on its due date, Oct 13, 2026, would leave Zeta Freight short on Oct 15, 2026, as the bills are scheduled now."
    );
    expect(flagCodes(line(short, "zeta"))).toEqual([]);
  });

  it("brings bills back to their due dates one at a time, so two that each fit alone are not both moved when together they do not", () => {
    // The agent may pay 1,000 a day on its own: either 600 fits Oct 15 alone, both do not.
    const limits = { budget: { dailyUsdc: 1000, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null };
    const plan = planPayments(
      input({
        operatingUsdc: 5000,
        limits,
        bills: [
          bill({ id: "xeno", payee: "Xeno Labs", amount: 600, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-18") }),
          bill({ id: "yara", payee: "Yara Print", counterpartyId: "c-2", amount: 600, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-19") }),
        ],
      })
    );
    expect(line(plan, "xeno")).toMatchObject({ on: "2026-10-15", move: { from: "2026-10-18", to: "2026-10-15" }, approvable: true, flags: [] });
    expect(line(plan, "yara")).toMatchObject({ on: "2026-10-19", move: null, agentPays: true, flags: [] });
    expect(line(plan, "yara").reason).toBe(
      "Pays on Oct 19, 2026, as the agent scheduled it: paying on its due date, Oct 15, 2026, would be above what the agent may pay on its own on Oct 15, 2026."
    );
  });

  it("offers no move whose bill fits the agent's limit on its new day only once another move is approved", () => {
    // Already above the limit on the agent's day (Oct 16, after Coastal's 500), Beta fits Oct 15 only once Alpha has
    // left it for Oct 12: approved alone, it would wait for a person on its discount's last day.
    const limits = { budget: { dailyUsdc: 1000, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null };
    const plan = planPayments(
      input({
        operatingUsdc: 5000,
        limits,
        bills: [
          bill({ id: "alpha", payee: "Alpha Freight", amount: 600, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-12") } }),
          bill({ id: "beta", payee: "Beta Hosting", counterpartyId: "c-2", amount: 700, dueDate: ISO_DAY("2026-10-20"), scheduledFor: MIDNIGHT("2026-10-16"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } }),
          bill({ id: "coastal", payee: "Coastal Freight", counterpartyId: "c-3", amount: 500, dueDate: ISO_DAY("2026-10-16"), scheduledFor: MIDNIGHT("2026-10-16") }),
        ],
      })
    );
    expect(line(plan, "alpha")).toMatchObject({ on: "2026-10-12", move: { from: "2026-10-15", to: "2026-10-12" }, approvable: true });
    expect(line(plan, "beta")).toMatchObject({ on: "2026-10-16", pays: 700, move: null, approvable: false });
    expect(flagCodes(line(plan, "beta"))).toEqual(["over_agent_limit"]);
    expect(line(plan, "beta").reason).toBe(
      "Pays on Oct 16, 2026, as the agent scheduled it: paying on Oct 15, 2026 for the 2% discount (14.00 USDC) would be above what the agent may pay on its own on Oct 15, 2026, as the bills are scheduled now."
    );
  });

  it("pays on its due date when the discount lasts until then too", () => {
    const plan = planPayments(input({ bills: [bill({ discount: { pct: 3, deadline: ISO_DAY("2026-10-20") } })] }));
    expect(line(plan, "b-1").on).toBe("2026-10-20");
    expect(line(plan, "b-1").pays).toBe(97);
    expect(line(plan, "b-1").discount).toMatchObject({ taken: true, value: 3 });
    expect(line(plan, "b-1").reason).toBe("Pays on its due date, Oct 20, 2026, which is also the discount's last day (3%, 3.00 USDC).");
  });

  it("never pays a bill after its due date, nor before today", () => {
    const plan = planPayments(
      input({
        bills: [
          bill({ id: "a", dueDate: ISO_DAY("2026-10-05"), status: "pending", scheduledFor: null }),
          bill({ id: "b", dueDate: ISO_DAY("2026-10-18"), scheduledFor: MIDNIGHT("2026-10-24") }),
          bill({ id: "c", dueDate: ISO_DAY("2026-10-19"), discount: { pct: 5, deadline: ISO_DAY("2026-10-12") }, scheduledFor: MIDNIGHT("2026-10-19") }),
        ],
      })
    );
    for (const planLine of plan.lines) {
      const latest = planLine.dueOn! > plan.today ? planLine.dueOn! : plan.today;
      expect(planLine.on! >= plan.today, planLine.id).toBe(true);
      expect(planLine.on! <= latest, planLine.id).toBe(true);
    }
    expect(line(plan, "b").move).toEqual({ from: "2026-10-24", to: "2026-10-18" });
  });
});

describe("cash (P5)", () => {
  it("never spends cash that is not there: a bill it cannot cover is short, not taken off, and counted as still owed", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 60,
        reserveUsdc: 40,
        bills: [
          bill({ id: "a", amount: 80, dueDate: ISO_DAY("2026-10-12"), scheduledFor: MIDNIGHT("2026-10-12") }),
          bill({ id: "b", amount: 50, dueDate: ISO_DAY("2026-10-13"), scheduledFor: MIDNIGHT("2026-10-13") }),
        ],
      })
    );
    expect(plan.cash).toBe(100);
    expect(line(plan, "a").balanceAfter).toBe(20);
    expect(line(plan, "b").flags[0]).toEqual({ code: "short", blocks: true, text: "Short by 30.00 USDC on Oct 13, 2026: the agent holds it until there is cash." });
    expect(line(plan, "b").balanceAfter).toBe(20);
    expect(plan.stillOwed).toBe(50);
    expect(plan.days.map((planDay) => [planDay.day, planDay.out, planDay.balance])).toEqual([
      ["2026-10-12", 80, 20],
      ["2026-10-13", 0, 20],
    ]);
  });

  it("shows the balance as scheduled now beside the balance with the plan", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 2000,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })],
      })
    );
    expect(plan.days).toEqual([
      { day: "2026-10-15", out: 980, balance: 1020, balanceNow: 2000 },
      { day: "2026-10-22", out: 0, balance: 1020, balanceNow: 1000 },
    ]);
    expect(plan.lowest).toEqual({ day: "2026-10-15", balance: 1020 });
    expect(plan.lowestNow).toEqual({ day: "2026-10-22", balance: 1000 });
  });

  it("a fixture plan never spends more than the cash, nor pays the agent past its limit", () => {
    const plan = planPayments(
      input({
        operatingUsdc: 700,
        reserveUsdc: 300,
        cushion: 120,
        limits: { budget: { dailyUsdc: 400, weeklyUsdc: 900, spentToday: 50, spentThisWeek: 200 }, twoApprovalsAbove: 600 },
        bills: [
          bill({ id: "overdue", amount: 220, dueDate: ISO_DAY("2026-10-08"), status: "pending", scheduledFor: null }),
          bill({ id: "today", amount: 180, dueDate: ISO_DAY("2026-10-11"), scheduledFor: MIDNIGHT("2026-10-11") }),
          bill({ id: "big", amount: 650, dueDate: ISO_DAY("2026-10-14"), scheduledFor: MIDNIGHT("2026-10-14") }),
          bill({ id: "deal", amount: 300, dueDate: ISO_DAY("2026-10-21"), scheduledFor: MIDNIGHT("2026-10-21"), discount: { pct: 2, deadline: ISO_DAY("2026-10-13") } }),
          bill({ id: "held", amount: 90, dueDate: ISO_DAY("2026-10-12"), status: "held", scheduledFor: null }),
          bill({ id: "late", amount: 400, dueDate: ISO_DAY("2026-10-23"), scheduledFor: MIDNIGHT("2026-10-23") }),
        ],
        milestones: [milestone({ amount: 60 })],
      })
    );
    let balance = plan.cash;
    const agentByDay = new Map<string, number>();
    for (const planLine of plan.lines.filter((candidate) => candidate.on !== null && candidate.inWindow && candidate.state !== "not_counted")) {
      if (flagCodes(planLine).includes("short")) continue;
      balance -= planLine.pays;
      expect(balance).toBeGreaterThanOrEqual(-0.000001);
      expect(planLine.balanceAfter).toBeCloseTo(balance, 6);
      if (planLine.agentPays) agentByDay.set(planLine.on!, (agentByDay.get(planLine.on!) ?? 0) + planLine.pays);
    }
    for (const planDay of plan.days) expect(planDay.balance).toBeGreaterThanOrEqual(0);
    // Above the figure for two approvals: never the agent's to pay.
    expect(line(plan, "big").agentPays).toBe(false);
    expect(flagCodes(line(plan, "big"))).toContain("two_approvals");
    // Today the agent had 350 of its 400 left: the milestone (60) and the bills that fit.
    expect(agentByDay.get("2026-10-11") ?? 0).toBeLessThanOrEqual(350);
    expect([...agentByDay.values()].reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(700);
  });
});

describe("each obligation once (P6)", () => {
  it("lists a bill the agent flagged without counting it", () => {
    const plan = planPayments(input({ operatingUsdc: 100, bills: [bill({ id: "dup", status: "flagged", scheduledFor: null, amount: 90 })] }));
    expect(line(plan, "dup")).toMatchObject({ state: "not_counted", on: null, balanceAfter: null });
    expect(line(plan, "dup").reason).toBe("Flagged for review by the agent: not counted unless a person approves it.");
    expect(plan.days).toEqual([]);
  });

  it("lists a milestone whose escrow holds its USDC without counting it again", () => {
    const plan = planPayments(input({ milestones: [milestone({ escrowState: "funded" })] }));
    expect(line(plan, "m-1")).toMatchObject({ state: "not_counted", on: null });
    expect(line(plan, "m-1").reason).toBe("Its USDC is held in escrow already: not counted again.");
  });

  it("counts a payment on its way once, today", () => {
    const plan = planPayments(input({ bills: [bill({ status: "matched", scheduledFor: null })] }));
    expect(plan.lines).toHaveLength(1);
    expect(line(plan, "b-1")).toMatchObject({ state: "on_its_way", on: "2026-10-11", balanceAfter: 900 });
  });

  it("marks a bill and a milestone with the same payee and amount, counts both, and moves neither", () => {
    const plan = planPayments(
      input({
        bills: [bill({ counterpartyId: "c-9", payee: "Ada Lovelace", amount: 50, discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } })],
        milestones: [milestone({ amount: 50 })],
      })
    );
    const both = [line(plan, "b-1"), line(plan, "m-1")];
    for (const planLine of both) expect(flagCodes(planLine)).toContain("same_as_milestone");
    expect(line(plan, "b-1").move).not.toBeNull();
    expect(line(plan, "b-1").approvable).toBe(false);
    expect(plan.days.at(-1)?.balance).toBeCloseTo(1000 - 50 - 49, 6);
  });

  it("names EURC bills apart and never adds them to USDC", () => {
    const plan = planPayments(input({ bills: [bill({ id: "eu", currency: "EURC", amount: 70 }), bill({ id: "eu2", currency: "EURC", amount: 30, status: "held", scheduledFor: null })] }));
    expect(plan.lines).toEqual([]);
    expect(plan.eurc).toEqual({ count: 2, amount: 100 });
  });
});

describe("each line's checks (P7)", () => {
  it("marks a bill above the payee's payment limit, above the figure for two approvals, or to a high-risk payee", () => {
    const plan = planPayments(
      input({
        limits: { budget: null, twoApprovalsAbove: 500 },
        bills: [
          bill({ id: "limit", paymentLimit: 80, discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } }),
          bill({ id: "two", amount: 600, dueDate: ISO_DAY("2026-10-21"), scheduledFor: MIDNIGHT("2026-10-21") }),
          bill({ id: "risk", riskLevel: "high", dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22") }),
        ],
      })
    );
    expect(line(plan, "limit").flags).toContainEqual({ code: "payment_limit", blocks: true, text: "Above Northwind Supply's payment limit of 80.00 USDC: a person approves it." });
    expect(line(plan, "limit").approvable).toBe(false);
    expect(line(plan, "two").flags).toContainEqual({ code: "two_approvals", blocks: true, text: "Above 500.00 USDC: two people approve it in Approvals." });
    expect(line(plan, "risk").flags).toContainEqual({ code: "high_risk", blocks: true, text: "Northwind Supply is screened high risk: it is not paid until Compliance clears it." });
    for (const id of ["limit", "two", "risk"]) expect(line(plan, id).agentPays).toBe(false);
  });

  it("marks a payment the agent's daily limit has no room for, and still counts its cash", () => {
    const plan = planPayments(
      input({
        limits: { budget: { dailyUsdc: 150, weeklyUsdc: null, spentToday: 100, spentThisWeek: 100 }, twoApprovalsAbove: null },
        bills: [
          // The smaller first, within a day (P5): 40 fits the 50 left, then 45 does not fit the 10 after it.
          bill({ id: "fits", amount: 40, dueDate: ISO_DAY("2026-10-11"), scheduledFor: MIDNIGHT("2026-10-11") }),
          bill({ id: "over", amount: 45, dueDate: ISO_DAY("2026-10-11"), scheduledFor: MIDNIGHT("2026-10-11") }),
          bill({ id: "tomorrow", amount: 140, dueDate: ISO_DAY("2026-10-12"), scheduledFor: MIDNIGHT("2026-10-12") }),
        ],
      })
    );
    expect(line(plan, "fits").agentPays).toBe(true);
    expect(line(plan, "over").flags).toContainEqual({
      code: "over_agent_limit",
      blocks: true,
      text: "Above what the agent may pay on its own on Oct 11, 2026: it waits for a person's approval.",
    });
    expect(line(plan, "over").agentPays).toBe(false);
    expect(line(plan, "over").balanceAfter).toBe(915);
    // A new day, a new daily room.
    expect(line(plan, "tomorrow").agentPays).toBe(true);
  });

  it("counts the last 7 days' spending against each of the first 7 days of the window, and none of it after", () => {
    const plan = planPayments(
      input({
        limits: { budget: { dailyUsdc: null, weeklyUsdc: 300, spentToday: 0, spentThisWeek: 250 }, twoApprovalsAbove: null },
        bills: [
          bill({ id: "day3", amount: 100, dueDate: ISO_DAY("2026-10-14"), scheduledFor: MIDNIGHT("2026-10-14") }),
          bill({ id: "day8", amount: 100, dueDate: ISO_DAY("2026-10-19"), scheduledFor: MIDNIGHT("2026-10-19") }),
        ],
      })
    );
    expect(flagCodes(line(plan, "day3"))).toContain("over_agent_limit");
    expect(flagCodes(line(plan, "day8"))).not.toContain("over_agent_limit");
  });

  it("lets a verified milestone use the agent's room today, and a pending one only the cash", () => {
    const plan = planPayments(
      input({
        limits: { budget: { dailyUsdc: 100, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null },
        milestones: [milestone({ id: "verified", amount: 60 }), milestone({ id: "pending", status: "pending", amount: 60, counterpartyId: "c-8" })],
        bills: [bill({ amount: 50, dueDate: ISO_DAY("2026-10-11"), scheduledFor: MIDNIGHT("2026-10-11") })],
      })
    );
    expect(line(plan, "verified").agentPays).toBe(true);
    expect(line(plan, "pending").agentPays).toBe(false);
    expect(line(plan, "pending").reason).toBe("Paid once its work is verified; counted today.");
    expect(flagCodes(line(plan, "b-1"))).toContain("over_agent_limit");
  });

  it("weighs the agent's limit against the billed amount, as its guardrail does, and counts what leaves against the room", () => {
    const daily = (dailyUsdc: number) => ({ budget: { dailyUsdc, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: null });
    const discount = { pct: 2, deadline: ISO_DAY("2026-10-15") };
    // The guardrail weighs the 1,000 billed, not the 980 paid: 990 a day holds it for a person on either day, so the
    // plan takes no discount the agent would not pay on its own, and keeps the bill's day.
    const plan = planPayments(input({ operatingUsdc: 5000, limits: daily(990), bills: [bill({ amount: 1000, discount })] }));
    const only = line(plan, "b-1");
    expect(only).toMatchObject({ on: "2026-10-20", pays: 1000, agentPays: false, move: null, approvable: false });
    expect(flagCodes(only)).toEqual(["over_agent_limit"]);
    expect(only.reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 15, 2026 for the 2% discount (20.00 USDC) would be above what the agent may pay on its own on Oct 15, 2026."
    );
    // With 15 paid that day too, the 1,000 billed no longer fits a 1,000 day, though 980 would; on its due date it does.
    const crowded = planPayments(
      input({
        operatingUsdc: 5000,
        limits: daily(1000),
        bills: [
          bill({ id: "deal", amount: 1000, discount }),
          bill({ id: "fee", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 15, dueDate: ISO_DAY("2026-10-15"), scheduledFor: MIDNIGHT("2026-10-15") }),
        ],
      })
    );
    expect(line(crowded, "deal")).toMatchObject({ on: "2026-10-20", move: null, agentPays: true });
    expect(line(crowded, "deal").reason).toBe(
      "Pays on its due date, Oct 20, 2026: paying on Oct 15, 2026 for the 2% discount (20.00 USDC) would be above what the agent may pay on its own on Oct 15, 2026."
    );
    // Within the limit, the 980 that leaves is what uses the day's room: 20 is left for the next payment.
    const room = planPayments(
      input({
        operatingUsdc: 5000,
        limits: daily(1000),
        bills: [
          bill({ id: "deal", amount: 1000, scheduledFor: MIDNIGHT("2026-10-15"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } }),
          bill({ id: "small", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 20, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-15") }),
        ],
      })
    );
    expect(line(room, "deal").agentPays).toBe(true);
    expect(line(room, "small").agentPays).toBe(true);
  });

  it("gives a verified milestone the agent's checks: one it may not release on its own uses none of its room", () => {
    const limits = { budget: { dailyUsdc: 6000, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0 }, twoApprovalsAbove: 5000 };
    const plan = planPayments(
      input({
        operatingUsdc: 20000,
        limits,
        milestones: [
          milestone({ id: "big", amount: 5500 }),
          milestone({ id: "capped", counterpartyId: "c-8", payee: "Grace Hopper", amount: 300, paymentLimit: 200 }),
          milestone({ id: "risky", counterpartyId: "c-7", payee: "Mallory Labs", amount: 100, riskLevel: "high" }),
        ],
        bills: [
          bill({ id: "today", amount: 1000, dueDate: ISO_DAY("2026-10-11"), status: "pending", scheduledFor: null }),
          bill({ id: "deal", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 1000, discount: { pct: 2, deadline: ISO_DAY("2026-10-11") } }),
        ],
      })
    );
    const big = line(plan, "big");
    expect(big).toMatchObject({ state: "waiting", agentPays: false });
    expect(big.flags).toContainEqual({ code: "two_approvals", blocks: true, text: "Above 5,000.00 USDC: two people approve it on Contractors." });
    expect(big.reason).toBe("Verified, but not the agent's to release on its own: counted today.");
    expect(line(plan, "capped").flags).toContainEqual({ code: "payment_limit", blocks: true, text: "Above Grace Hopper's payment limit of 200.00 USDC: a person approves it." });
    expect(flagCodes(line(plan, "risky"))).toContain("high_risk");
    for (const id of ["capped", "risky"]) expect(line(plan, id)).toMatchObject({ state: "waiting", agentPays: false });
    // The bills alone use the agent's 6,000 today.
    expect(line(plan, "today")).toMatchObject({ agentPays: true, flags: [] });
    expect(line(plan, "deal")).toMatchObject({ on: "2026-10-11", move: { from: "2026-10-20", to: "2026-10-11" }, approvable: true, agentPays: true });
  });
});

describe("waiting for a person (P8)", () => {
  it("lists a held bill on its due day, counted, with nothing to move", () => {
    const plan = planPayments(input({ bills: [bill({ status: "held", scheduledFor: null, dueDate: ISO_DAY("2026-10-15") })] }));
    expect(line(plan, "b-1")).toMatchObject({ state: "waiting", on: "2026-10-15", move: null, approvable: false, balanceAfter: 900 });
    expect(line(plan, "b-1").reason).toBe("Waits for a person in Approvals; counted on its due date.");
  });

  it("gives an undecided bill a day but no move: the agent decides it first", () => {
    const plan = planPayments(input({ bills: [bill({ status: "pending", scheduledFor: null, discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } })] }));
    expect(line(plan, "b-1")).toMatchObject({ state: "planned", on: "2026-10-14", move: null, approvable: false });
  });

  it("offers no move for a bill the agent decides again at its next cycle, and counts it on the day the agent's rule gives", () => {
    const plan = planPayments(input({ bills: [bill({ scheduledFor: MIDNIGHT("2026-10-11"), discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } })] }));
    expect(line(plan, "b-1")).toMatchObject({ on: "2026-10-14", pays: 98, move: null, approvable: false });
    expect(line(plan, "b-1").reason).toBe(
      "Pays on Oct 14, 2026, the discount's last day, to take the 2% early-payment discount (2.00 USDC), as the agent decides at its next cycle."
    );
    // As scheduled now and with this plan alike: nobody can move it.
    expect(plan.days).toEqual([{ day: "2026-10-14", out: 98, balance: 902, balanceNow: 902 }]);
  });

  it("puts a bill whose scheduled day has come where the agent's next cycle will, whatever the cushion", () => {
    // 09:00 on Oct 11, before any cycle today: the agent scheduled Alpha for today, the discount's last day.
    const today = planPayments(
      input({
        operatingUsdc: 1100,
        cushion: 200,
        bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-16"), scheduledFor: MIDNIGHT("2026-10-11"), discount: { pct: 2, deadline: ISO_DAY("2026-10-11") } })],
      })
    );
    const only = line(today, "b-1");
    expect(only).toMatchObject({ on: "2026-10-11", pays: 980, move: null, approvable: false, balanceAfter: 120 });
    expect(only.discount).toMatchObject({ taken: true, value: 20 });
    expect(only.reason).toBe("Pays today, the discount's last day, to take the 2% early-payment discount (20.00 USDC), as the agent decides at its next cycle.");
    expect(flagCodes(only)).toEqual(["below_cushion"]);
    expect(today.days).toEqual([{ day: "2026-10-11", out: 980, balance: 120, balanceNow: 120 }]);
    expect(today.lowest).toEqual({ day: "2026-10-11", balance: 120 });
    expect(today.lowestNow).toEqual({ day: "2026-10-11", balance: 120 });
    expect(today.discountsPlanned).toBe(20);

    // A day that passed with no cycle: its discount ended, so the agent's next decision is the due date.
    const missed = line(
      planPayments(input({ bills: [bill({ dueDate: ISO_DAY("2026-10-16"), scheduledFor: MIDNIGHT("2026-10-09"), discount: { pct: 2, deadline: ISO_DAY("2026-10-09") } })] })),
      "b-1"
    );
    expect(missed).toMatchObject({ on: "2026-10-16", pays: 100, move: null });
    expect(missed.reason).toBe("Pays on its due date, Oct 16, 2026; its 2% discount ended Oct 9, 2026.");

    // A discount the reserve's yield outweighs: the agent's next decision is the due date, as the plan says.
    const yielded = line(
      planPayments(
        input({
          reserveApy: 0.05,
          bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-11"), discount: { pct: 0.1, deadline: ISO_DAY("2026-10-13") } })],
        })
      ),
      "b-1"
    );
    expect(yielded).toMatchObject({ on: "2026-10-22", pays: 1000, move: null });
    expect(yielded.reason).toContain("the reserve's yield until then");
  });
});

describe("fingerprints (P11)", () => {
  const base = () =>
    input({
      operatingUsdc: 2000,
      bills: [bill({ amount: 1000, dueDate: ISO_DAY("2026-10-22"), scheduledFor: MIDNIGHT("2026-10-22"), discount: { pct: 2, deadline: ISO_DAY("2026-10-15") } })],
    });

  it("are the same for the same facts", () => {
    expect(planPayments(base()).fingerprint).toBe(planPayments(base()).fingerprint);
    expect(planPayments({ ...base(), now: NOW + 3_600_000 }).fingerprint).toBe(planPayments(base()).fingerprint);
  });

  it("change with the amount, the payee, its address, the due date and the balance", () => {
    const first = planPayments(base());
    const variants: Array<[string, PaymentPlanInput]> = [
      ["amount", { ...base(), bills: [{ ...base().bills[0], amount: 1001 }] }],
      ["payee", { ...base(), bills: [{ ...base().bills[0], counterpartyId: "c-2" }] }],
      ["address", { ...base(), bills: [{ ...base().bills[0], payeeAddress: "0xdef" }] }],
      ["due date", { ...base(), bills: [{ ...base().bills[0], dueDate: ISO_DAY("2026-10-23") }] }],
    ];
    for (const [what, changed] of variants) {
      const plan = planPayments(changed);
      expect(plan.lines[0].fingerprint, what).not.toBe(first.lines[0].fingerprint);
      expect(plan.fingerprint, what).not.toBe(first.fingerprint);
    }
    const richer = planPayments({ ...base(), operatingUsdc: 2001 });
    expect(richer.lines[0].fingerprint).toBe(first.lines[0].fingerprint);
    expect(richer.fingerprint).not.toBe(first.fingerprint);
    // The reserve's yield decides which discounts are worth taking: a new rate is a new plan.
    expect(planPayments({ ...base(), reserveApy: 0.05 }).fingerprint).not.toBe(first.fingerprint);
  });

  it("change with the payee's payment limit or screening, a milestone's contractor's too, so an Approve they stop is not left on screen", () => {
    const first = planPayments(base());
    for (const fields of [{ paymentLimit: 500 }, { riskLevel: "high" }]) {
      const plan = planPayments({ ...base(), bills: [{ ...base().bills[0], ...fields }] });
      expect(plan.lines[0].fingerprint, JSON.stringify(fields)).not.toBe(first.lines[0].fingerprint);
      expect(plan.fingerprint, JSON.stringify(fields)).not.toBe(first.fingerprint);
    }
    // A verified milestone the agent may release on its own uses its room, which the bills' checks count on.
    const withMilestone = (fields: Partial<PlanMilestone>) => planPayments({ ...base(), milestones: [milestone(fields)] });
    expect(withMilestone({ riskLevel: "high" }).fingerprint).not.toBe(withMilestone({}).fingerprint);
    expect(withMilestone({ paymentLimit: 10 }).fingerprint).not.toBe(withMilestone({}).fingerprint);
  });

  it("does not change when the balance is only read again", () => {
    const at = (syncedAt: string) => planPayments({ ...base(), balance: { kind: "chain", syncedAt } });
    expect(at(new Date(NOW - 60_000).toISOString()).fingerprint).toBe(at(new Date(NOW - 120_000).toISOString()).fingerprint);
  });
});

describe("fresh data (P12)", () => {
  it("treats a sandbox's own balance as current", () => {
    expect(planFreshness({ kind: "simulated" }, [], NOW)).toEqual({ state: "simulated", syncedAt: null, minutes: null, blocked: null });
  });

  it("is fresh within 10 minutes of the chain's read", () => {
    const syncedAt = new Date(NOW - 3 * 60_000).toISOString();
    expect(planFreshness({ kind: "chain", syncedAt }, [], NOW)).toEqual({ state: "fresh", syncedAt, minutes: 3, blocked: null });
    expect(BALANCE_FRESH_MS).toBe(10 * 60_000);
  });

  it("is stale after 10 minutes, and turns approving off with the reason", () => {
    const syncedAt = new Date(NOW - 25 * 60_000).toISOString();
    expect(planFreshness({ kind: "chain", syncedAt }, [], NOW)).toEqual({
      state: "stale",
      syncedAt,
      minutes: 25,
      blocked: "The balance was read from the chain 25 minutes ago. Refresh it to approve the plan.",
    });
    expect(planFreshness({ kind: "chain", syncedAt: new Date(NOW - 3 * 3_600_000).toISOString() }, [], NOW).blocked).toBe(
      "The balance was read from the chain 3 hours ago. Refresh it to approve the plan."
    );
  });

  it("turns approving off when the balance was never read, or a source could not be", () => {
    expect(planFreshness({ kind: "chain", syncedAt: null }, [], NOW)).toMatchObject({
      state: "unread",
      blocked: "The balance has not been read from the chain yet. Refresh it to approve the plan.",
    });
    expect(planFreshness({ kind: "simulated" }, ["the agent's spending limit"], NOW).blocked).toBe(
      "The agent's spending limit could not be read, so the plan's checks are incomplete. Approving waits until it can be read."
    );
  });

  it("is carried on the plan, which stays whole", () => {
    const plan = planPayments(input({ balance: { kind: "chain", syncedAt: null }, bills: [bill({ discount: { pct: 2, deadline: ISO_DAY("2026-10-14") } })] }));
    expect(plan.freshness.state).toBe("unread");
    expect(plan.blocked).toContain("Refresh it");
    expect(plan.lines).toHaveLength(1);
    expect(line(plan, "b-1").approvable).toBe(true);
  });
});
