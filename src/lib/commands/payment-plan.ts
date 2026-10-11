import { runCycleSoon } from "../agent/cycle-soon";
import { hasRunningCycle } from "../agent/cycle-running";
import { isSoleApprover } from "../agent/sole-approver";
import { utcDay } from "../copy";
import { moveObjection, planPayments, type PlanLine } from "../payment-plan";
import { moveScheduledPayment } from "../payment-plan-apply";
import { readPaymentPlanInput } from "../payment-plan-read";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Approving payment plan lines (docs/superpowers/specs/2026-10-11-payment-plan-design.md P9–P13): one line, or every
 * line a person was shown as approvable. The plan is read again and must be the one shown (P11), with a fresh balance
 * (P12) and no cycle running (P13); then each line passes its own checks, the maker-checker rule among them (P10), and
 * its move is weighed against the schedule as it stands with the moves this press made before it, so the moves made
 * hold together whichever lines pass (P9). Only a line that passes moves. One press never lets a line skip a check, and
 * nothing here pays: the agent decides each moved bill again, with every check, on its new day.
 */

export interface PlanLineResult {
  invoiceId: string;
  payee: string;
  ok: boolean;
  message: string;
}

export const PLAN_CHANGED = "The plan changed since it was shown. Look at the new plan, then approve again.";
const SELF_CREATED = "You created this bill, so someone else must approve its day.";
const LINE_CHANGED = "This bill changed since the plan was shown. Look at the new plan.";
const MOVE_LOST = "This bill changed a moment ago. Look at the new plan.";

const onDay = (day: string, today: string) => (day === today ? "today" : `on ${utcDay(`${day}T00:00:00.000Z`)}`);
const toDay = (day: string, today: string) => (day === today ? "today" : utcDay(`${day}T00:00:00.000Z`));

/** Why a line may not be moved by this person, or null when it may (P10). */
function lineRefusal(line: PlanLine | undefined, fingerprint: string, actorId: string, soleApprover: boolean): string | null {
  if (!line) return "It is no longer in the plan.";
  if (line.fingerprint !== fingerprint) return LINE_CHANGED;
  if (!line.move) return "There is nothing to move on this bill.";
  if (!line.approvable) return line.flags.find((flag) => flag.blocks)?.text ?? "Its checks do not pass.";
  if (line.createdBy === actorId && !soleApprover) return SELF_CREATED;
  return null;
}

export async function approvePlanLines(
  actor: Actor,
  input: { planFingerprint: string; lines: Array<{ invoiceId: string; fingerprint: string }> }
): Promise<CommandOutcome<{ results: PlanLineResult[] }>> {
  const refusal = gate(actor, "payment_plan.approve");
  if (refusal) return refusal;
  if (input.lines.length === 0) return refused("nothing", "There is no line to approve.");
  try {
    // The AP stage writes a bill it decides without a compare-and-set: no move while it may be deciding (P13).
    if (await hasRunningCycle()) return refused("cycle_running", "A cycle is running. Try again in a minute, once it has finished.");
    const rows = await readPaymentPlanInput();
    const plan = planPayments(rows);
    // `changed` on each refusal that says the plan shown is out of date: the console then shows it as it is now, with
    // approving off and Refresh balance when the balance is stale, instead of the same buttons refused again.
    if (plan.blocked) return refused("stale", plan.blocked, { changed: true });
    if (plan.fingerprint !== input.planFingerprint) return refused("plan_changed", PLAN_CHANGED, { changed: true });

    const byId = new Map(plan.lines.map((line) => [line.id, line]));
    const requested = [...new Map(input.lines.map((line) => [line.invoiceId, line])).values()];
    // Asked only when it matters: the person created one of the bills (sole approver R3 fails closed).
    const soleApprover = requested.some((line) => byId.get(line.invoiceId)?.createdBy === actor.userId) ? await isSoleApprover(actor.userId) : false;

    // In the plan's order, whatever order they came in: a move to an earlier day is weighed before one that may need
    // the room or the cash it frees.
    const rank = new Map(plan.lines.map((line, index) => [line.id, index]));
    const inPlanOrder = [...requested].sort((a, b) => (rank.get(a.invoiceId) ?? plan.lines.length) - (rank.get(b.invoiceId) ?? plan.lines.length));
    const outcomes = new Map<string, PlanLineResult>();
    /** What this press moved, by bill, to its new day: each later line is weighed with these moves made (P9). */
    const movedTo = new Map<string, string>();
    let changed = false;
    let failed = false;
    for (const { invoiceId, fingerprint } of inPlanOrder) {
      const line = byId.get(invoiceId);
      const answer = (ok: boolean, message: string) => outcomes.set(invoiceId, { invoiceId, payee: line?.payee ?? "A bill", ok, message });
      const why = lineRefusal(line, fingerprint, actor.userId, soleApprover);
      if (!line || line.fingerprint !== fingerprint) changed = true;
      if (why || !line?.move) {
        answer(false, why ?? "There is nothing to move on this bill.");
        continue;
      }
      // A write that failed may have landed or not, so no later move can be weighed against the schedule as it stands.
      if (failed) {
        answer(false, TRY_AGAIN);
        continue;
      }
      const against = moveObjection(rows, movedTo, line.id, line.move.to);
      if (against !== null) {
        changed = true;
        answer(false, movedTo.size === 0 ? `It ${against}, as the bills are scheduled now.` : `Together with the moves just made, it ${against}.`);
        continue;
      }
      let moved: boolean;
      try {
        moved = await moveScheduledPayment({ actorId: actor.userId, line, planFingerprint: plan.fingerprint, soleApprover: line.createdBy === actor.userId });
      } catch (error) {
        console.error("payment plan approval failed", error instanceof Error ? error.message : error);
        failed = true;
        changed = true;
        answer(false, TRY_AGAIN);
        continue;
      }
      if (!moved) {
        changed = true;
        answer(false, MOVE_LOST);
        continue;
      }
      movedTo.set(line.id, line.move.to);
      answer(true, `Moves to ${toDay(line.move.to, plan.today)}.`);
    }

    // A bill moved to today is decided at a cycle raised now, so a discount ending today is not missed (P9), whatever
    // happened to the lines after it.
    if ([...movedTo.values()].includes(plan.today)) runCycleSoon(cycleEventOf(actor, "plan_approved"));

    const results = requested.map(({ invoiceId }) => outcomes.get(invoiceId)!);
    const moved = results.filter((result) => result.ok);
    const notMoved = results.filter((result) => !result.ok);
    if (moved.length === 0) {
      const message = `Nothing was moved. ${notMoved.map((result) => `${result.payee}: ${result.message}`).join(" ")}`;
      return refused(failed ? "failed" : "not_moved", message, changed ? { changed: true } : {});
    }
    const first = byId.get(moved[0].invoiceId)!;
    const head =
      moved.length === 1
        ? `Moved: ${first.payee} pays ${onDay(first.move!.to, plan.today)}. The agent checks it again on that day before it pays.`
        : `Moved ${moved.length} payments. The agent checks each again on its day before it pays.`;
    const tail = notMoved.length > 0 ? ` Not moved: ${notMoved.map((result) => `${result.payee} (${result.message})`).join("; ")}.` : "";
    return done(`${head}${tail}`, { results });
  } catch (error) {
    // Before any line moved: the read, the cycle check or the sole-approver answer.
    console.error("payment plan approval failed", error instanceof Error ? error.message : error);
    return refused("failed", TRY_AGAIN);
  }
}
