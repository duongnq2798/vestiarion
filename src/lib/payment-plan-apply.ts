import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import type { PlanLine } from "./payment-plan";

/**
 * A person's approval of one payment plan line (docs/superpowers/specs/2026-10-11-payment-plan-design.md P9): the day
 * a scheduled bill is decided again on moves to the plan's day. Nothing is paid here, and nothing is approved but that
 * day: on it, the agent's AP stage decides the bill again with every check it always runs (payment timing P3).
 *
 * The write is a compare-and-set on what the line showed: still scheduled, on the day shown, for the amount, the
 * payee and the due date shown. A decision, a person's or another move in between wins, and nothing is recorded. The
 * signed entry after it is best effort, as every person's decision's is: the move has happened, and is reported done.
 * Who may approve it, and whether the plan is still the one shown, are the command's checks
 * (src/lib/commands/payment-plan.ts). Runs inside an organization scope.
 */

/** The ledger action for a move from the payment plan. */
export const PAYMENT_RESCHEDULED = "payment_rescheduled";

const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const nextDayStart = (day: string) => new Date(Date.parse(dayStart(day)) + 86_400_000).toISOString();

export async function moveScheduledPayment(input: { actorId: string; line: PlanLine; planFingerprint: string; soleApprover: boolean }): Promise<boolean> {
  const { line } = input;
  if (!line.move || line.kind !== "bill" || line.dueOn === null) return false;
  const { from, to } = line.move;

  const changed = unwrap(
    await db()
      .from("invoices")
      .update({ scheduled_for: dayStart(to) })
      .eq("id", line.id)
      .eq("direction", "payable")
      .eq("status", "scheduled")
      .eq("counterparty_id", line.counterpartyId)
      .eq("amount", line.amount)
      .gte("scheduled_for", dayStart(from))
      .lt("scheduled_for", nextDayStart(from))
      .gte("due_date", dayStart(line.dueOn))
      .lt("due_date", nextDayStart(line.dueOn))
      .select("id")
  ) as Array<{ id: string }>;
  if (changed.length === 0) return false;

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: PAYMENT_RESCHEDULED,
    summary: `Moved the payment to ${line.payee} for ${line.amount} USDC from ${from} to ${to}, from the payment plan`,
    // No `observed`: a person's move is not a decision; the bill's card keeps reading the agent's own (complete held invoice R6).
    detail: {
      by: input.actorId,
      invoiceId: line.id,
      counterpartyId: line.counterpartyId,
      from,
      to,
      dueOn: line.dueOn,
      amount: line.amount,
      pays: line.pays,
      discount: line.discount ? { pct: line.discount.pct, value: line.discount.value, until: line.discount.until } : null,
      balanceAfter: line.balanceAfter,
      planFingerprint: input.planFingerprint,
      lineFingerprint: line.fingerprint,
      ...(input.soleApprover ? { soleApprover: true } : {}),
    },
  });
  return true;
}
