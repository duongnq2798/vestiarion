import { planPayments, type PaymentPlan, type PlanBill } from "@/lib/payment-plan";
import type { PlanOutcomes } from "@/lib/payment-plan-outcomes";

/**
 * The payment plan guide's screenshots (docs/superpowers/specs/2026-10-11-payment-plan-design.md): a live workspace on
 * Monday, Oct 12, 2026, planned by the real planner. Made up: no workspace has these bills.
 *
 * The whole section is too tall for one picture, so each shot shows a part of the same plan: the top of it with the
 * two days the plan would move, the cash effect with the last 30 days, and the top of it again with a balance read 40
 * minutes before.
 */

const NOW = Date.UTC(2026, 9, 12, 9, 0);
const MAKER = "00000000-0000-4000-8000-0000000000a1";
/** The person looking: an approver who entered none of these bills. */
export const PAYMENT_PLAN_VIEWER = "00000000-0000-4000-8000-0000000000a2";

const noon = (day: string) => `${day}T12:00:00.000Z`;
const midnight = (day: string) => `${day}T00:00:00.000Z`;

const bill = (fields: Partial<PlanBill> & Pick<PlanBill, "id" | "payee" | "amount" | "dueDate">): PlanBill => ({
  counterpartyId: `cp-${fields.id}`,
  payeeAddress: `0x${"5eed".repeat(10)}`,
  currency: "USDC",
  status: "scheduled",
  scheduledFor: midnight(fields.dueDate.slice(0, 10)),
  discount: null,
  paymentLimit: 2000,
  riskLevel: "clear",
  createdBy: MAKER,
  ...fields,
});

/** The plan, with the balance read 2 minutes before, or 40 when `stale`; `short`, with too little cash for every bill. */
export function paymentPlanShot(options: { stale?: boolean; short?: boolean } = {}): PaymentPlan {
  return planPayments({
    now: NOW,
    operatingUsdc: options.short ? 1100 : 2400,
    reserveUsdc: options.short ? 0 : 1500,
    reserveApy: 0.045,
    cushion: 350,
    bills: [
      bill({ id: "00000000-0000-4000-8000-000000000b01", payee: "Atlas Couriers", amount: 180, dueDate: noon("2026-10-09"), status: "pending", scheduledFor: null }),
      bill({ id: "00000000-0000-4000-8000-000000000b02", payee: "Harbor Office Supply", amount: 640, dueDate: noon("2026-10-20"), discount: { pct: 1, deadline: noon("2026-10-14") } }),
      bill({ id: "00000000-0000-4000-8000-000000000b03", payee: "Northwind Hosting", amount: 1200, dueDate: noon("2026-10-23"), discount: { pct: 2, deadline: noon("2026-10-15") } }),
      bill({ id: "00000000-0000-4000-8000-000000000b04", payee: "Kestrel Print", amount: 300, dueDate: noon("2026-10-16"), status: "held", scheduledFor: null }),
    ],
    milestones: [],
    limits: { budget: { dailyUsdc: 2000, weeklyUsdc: 6000, spentToday: 0, spentThisWeek: 1150 }, twoApprovalsAbove: 5000 },
    balance: { kind: "chain", syncedAt: new Date(NOW - (options.stale ? 40 : 2) * 60_000).toISOString() },
    unread: [],
  });
}

/** The part of a plan a picture shows: only these payees' lines, and no cash effect under them. */
export function planPart(plan: PaymentPlan, payees: readonly string[]): PaymentPlan {
  return { ...plan, lines: plan.lines.filter((line) => payees.includes(line.payee)), days: [] };
}

export const PAYMENT_PLAN_OUTCOMES: PlanOutcomes = { paid: 9, paidOnTime: 8, overdueNow: 1, discountsTaken: 18.4, moves: 2 };
