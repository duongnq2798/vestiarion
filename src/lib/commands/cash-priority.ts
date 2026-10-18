import { PriorityOrderRefusal, setPersonOrder } from "../agent/cash-priority-plan";
import { readCashBalances } from "../agent/cash-priority-view";
import { runCycleSoon } from "../agent/cycle-soon";
import { hasRunningCycle } from "../agent/cycle-running";
import { db } from "../dal";
import { readShadowMode } from "../shadow-mode";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * A person's order for which bills the cash goes to first (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md
 * O2-O4): owners, admins and approvers (`approval.decide`), from the console. Refused while a cycle runs, which reads the
 * order, and in shadow mode. The bills are read again and must be the ones shown; the order is signed as the person's,
 * and a cycle starts so the bills it moves are decided now. Nothing here pays.
 */
export async function setCashPriorityOrder(actor: Actor, input: { fingerprint: string; order: string[] }): Promise<CommandOutcome> {
  const refusal = gate(actor, "cash_priority.set_order");
  if (refusal) return refusal;
  try {
    if (await hasRunningCycle()) return refused("cycle_running", "A cycle is running. Try again in a minute, once it has finished.");
    if (await readShadowMode(db())) return refused("shadow", "In shadow mode the agent pays nothing for real, so there is no order to set.");
    const { operating, reserve } = await readCashBalances(db());
    const set = await setPersonOrder({
      db: db(),
      now: new Date(),
      actorId: actor.userId,
      fingerprint: input.fingerprint,
      order: input.order,
      operatingBalance: operating,
      reserveBalance: reserve,
    });
    runCycleSoon(cycleEventOf(actor, "priority_order_set"));
    const pays = set.keep.length > 0 ? `The agent pays ${set.named(set.keep)} first` : "The cash covers none of them yet";
    const waits = set.wait.length > 0 ? `; ${set.named(set.wait)} ${set.wait.length === 1 ? "waits" : "wait"}` : "";
    return done(`Saved. ${pays}${waits}. It decides them now, each with every check.`);
  } catch (error) {
    // Bills that changed, or a cash that now covers them all: the order shown is out of date, so the page shows it again.
    if (error instanceof PriorityOrderRefusal) return refused(error.code, error.message, error.code === "order" ? {} : { changed: true });
    console.error("setting the cash priority order failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
