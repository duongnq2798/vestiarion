import { can, type Permission } from "../auth/roles";
import { currentOrgId } from "../context";
import type { Actor, SurfaceKind } from "./actor";
import { surfaceName } from "./chat-decisions";
import { refused, type Refused } from "./outcome";

/**
 * Every command, with the permission it needs (integrations design R1). One exported function in
 * `src/lib/commands/` per entry, whose first statement is `gate(actor, "<name>")`.
 */
export const COMMAND_PERMISSIONS = {
  "payable.approve": "approval.decide",
  "payable.reject": "approval.decide",
  "payable.return": "approval.decide",
  "payable.add_details": "records.write",
  // What the business paid outside Vestiarion is a record, entered as an invoice is (actual payments A4).
  "payable.record_actual": "records.write",
  "payable.import_actuals": "records.write",
  // So is filling them in from a bank statement (bank statement B8).
  "payable.import_statement": "records.write",
  // Applying money received to receivables, a fee and a reversal: records, entered as an invoice is (allocations L10).
  "receivable.apply_payment": "records.write",
  "receivable.reverse_allocation": "records.write",
  // Moving a scheduled bill to the payment plan's day: a decision on when the agent pays, never a payment (payment plan P10).
  "payment_plan.approve": "approval.decide",
  "milestone.pay": "approval.decide",
  "milestone.close": "approval.decide",
  "agent.pause": "agent.pause",
  "agent.resume": "agent.resume",
  "agent.run_cycle": "agent.run_cycle",
  "invoice.add": "records.write",
  /** A bill list, each of its rows then added through `invoice.add` (import design B12); the console only. */
  "invoice.import": "records.write",
  "milestone.add": "records.write",
  "payee_link.create": "records.write",
  // A deal on the receivables side, its versions, and the switch that releases its lines on their days: records, as a
  // receivable is (deal schedule D13). Releasing a line adds a receivable, so it needs what adding one needs today.
  "deal.create": "records.write",
  "deal.change": "records.write",
  "deal.release": "records.write",
  "deal.auto_release": "records.write",
  "inbox.add": "records.write",
  "inbox.finish": "records.write",
  "inbox.dismiss": "records.write",
  // Bills an accounting tool brought in (Xero connector X3, X11): added through the bill list's check, or dismissed.
  "accounting.add_bills": "records.write",
  "accounting.dismiss_bills": "records.write",
  // A CRM's won deal planned as a deal, its changes kept as seen, a customer's billing email filled from it: records,
  // as a deal is (HubSpot connector H3).
  "crm.plan_deal": "records.write",
  "crm.keep_change": "records.write",
  "crm.fill_email": "records.write",
  // Booking payments made on Arc in the accounting tool, after a person reviewed each (accounting write-back W6).
  "accounting.book_payments": "accounting.book",
  // A public link to the workspace report, and stopping one; the value question is the business's own figure about
  // itself, an owner's (shared report S3).
  "report.share": "report.share",
  "report.unshare": "report.share",
  "report.baseline": "org.administer",
} as const satisfies Record<string, Permission>;

export type CommandName = keyof typeof COMMAND_PERMISSIONS;

/**
 * What each surface may run (R4). The console runs everything. Telegram adds invoices and decides nothing (Telegram
 * bot design R11). The API adds records and never decides (write API R3; part 2, W4). Slack decides a held payable, under a limit
 * each workspace sets and the chat's own rules (Slack design S8, S10), pauses the agent, and adds an invoice from a
 * message; resuming, and every other command, stays in the console. A pull request comment attaches a bounty, which is a
 * milestone, and nothing else (bounties B5).
 */
export const SURFACE_COMMANDS: Record<SurfaceKind, readonly CommandName[]> = {
  console: Object.keys(COMMAND_PERMISSIONS) as CommandName[],
  telegram: ["invoice.add"],
  api: ["invoice.add", "milestone.add", "payee_link.create"],
  slack: ["payable.approve", "payable.reject", "payable.return", "agent.pause", "invoice.add"],
  github: ["milestone.add"],
};

/** A person's decisions on what the agent stopped: off on a chat whose workspace allows none there (Slack design S8). */
const DECISIONS: ReadonlySet<CommandName> = new Set(["payable.approve", "payable.reject", "payable.return", "milestone.pay", "milestone.close"]);

/** A surface ran a command for an actor outside the scope it entered: a bug in that surface, never a refusal. */
export class ActorScopeError extends Error {
  constructor() {
    super("A command ran outside its actor's workspace");
    this.name = "ActorScopeError";
  }
}

/**
 * The first statement of every command. The workspace in scope must be the actor's (R2), or it throws. Then the
 * actor's role must hold the command's permission, and the surface must be one that may run it; either refusal is
 * returned before anything is read or written.
 */
export function gate(actor: Actor, command: CommandName): Refused | null {
  if (currentOrgId() !== actor.orgId) throw new ActorScopeError();
  if (!can(actor.role, COMMAND_PERMISSIONS[command])) {
    return refused("forbidden", `Your role in this workspace (${actor.role}) cannot do that.`);
  }
  if (!SURFACE_COMMANDS[actor.surface.kind].includes(command)) {
    return refused("surface", "That is done in the Vestiarion console, not from here.");
  }
  if (DECISIONS.has(command) && "decisionsLimitUsdc" in actor.surface && actor.surface.decisionsLimitUsdc === null) {
    return refused(
      "decisions_off",
      `Deciding payments from ${surfaceName(actor.surface.kind)} is off for this workspace. Decide it in Vestiarion, or ask an owner to allow it in Settings.`
    );
  }
  return null;
}
