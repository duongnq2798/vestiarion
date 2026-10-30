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
  // Several held payables approved with one confirmation, each as `payable.approve` approves one: the console's
  // Approvals page only, so no other surface lists it (docs/superpowers/specs/2026-10-30-approve-many-design.md AM13).
  "payable.approve_many": "approval.decide",
  "payable.reject": "approval.decide",
  "payable.return": "approval.decide",
  "payable.add_details": "records.write",
  // What the business paid outside Vestiarion is a record, entered as an invoice is (actual payments A4).
  "payable.record_actual": "records.write",
  "payable.import_actuals": "records.write",
  // So is filling them in from a bank statement (bank statement B8).
  "payable.import_statement": "records.write",
  // Applying money received to receivables, a fee and a reversal (allocations L10): the receivables bookkeeping, which
  // an accountant does as well as an owner or admin (accountant console A1).
  "receivable.apply_payment": "receivables.reconcile",
  "receivable.reverse_allocation": "receivables.reconcile",
  // Moving a scheduled bill to the payment plan's day: a decision on when the agent pays, never a payment (payment plan P10).
  "payment_plan.approve": "approval.decide",
  // Which bills the cash goes to first when it cannot cover them all: a decision on what is paid, as a plan's day is,
  // so owners, admins and approvers (order design O2). Code still pays only while the cash lasts, after every check.
  "cash_priority.set_order": "approval.decide",
  "milestone.pay": "approval.decide",
  "milestone.close": "approval.decide",
  "agent.pause": "agent.pause",
  "agent.resume": "agent.resume",
  "agent.run_cycle": "agent.run_cycle",
  "invoice.add": "records.write",
  /** A bill list, each of its rows then added through `invoice.add` (import design B12); the console only. */
  "invoice.import": "records.write",
  "milestone.add": "records.write",
  // Contractor work accepted from Asana: linking a milestone to its task, writing the criteria it is held to, and
  // accepting the work against them are what verifying a milestone by hand is, a record (Asana acceptance A4, A5, A8).
  "milestone.link_task": "records.write",
  "milestone.unlink_task": "records.write",
  "milestone.set_criteria": "records.write",
  "milestone.accept": "records.write",
  "milestone.check_task": "records.write",
  "payee_link.create": "records.write",
  // A deal on the receivables side, its versions, and the switch that releases its lines on their days: records, as a
  // receivable is (deal schedule D13). Releasing a line adds a receivable, so it needs what adding one needs today.
  "deal.create": "records.write",
  "deal.change": "records.write",
  "deal.release": "records.write",
  "deal.auto_release": "records.write",
  // A deal's planned costs, and linking one to the bill or milestone it became: records, as a deal is (deal cash
  // readiness K3).
  "deal.add_cost": "records.write",
  "deal.remove_cost": "records.write",
  "deal.link_cost": "records.write",
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
  // Writing receipts back to the CRM's deals, turned on or off, and Vestiarion's figures written over a field someone
  // changed there: the integration's own writes, an owner's or admin's (CRM receipts R3, R5).
  "crm.receipt_writes": "integrations.manage",
  "crm.receipt_overwrite": "integrations.manage",
  // Booking payments made on Arc in the accounting tool, after a person reviewed each (accounting write-back W6).
  "accounting.book_payments": "accounting.book",
  // A public link to the workspace report, and stopping one; the value question is the business's own figure about
  // itself, an owner's (shared report S3).
  "report.share": "report.share",
  "report.unshare": "report.share",
  "report.baseline": "org.administer",
  // A customer's statement link, and stopping one: records on the receivables side, as a pay link is (customer portal
  // P9). Answering or closing what a customer said through it is the receivables bookkeeping, an accountant's too
  // (accountant console A1).
  "customer_portal.share": "records.write",
  "customer_portal.unshare": "records.write",
  "customer_request.reply": "receivables.reconcile",
  "customer_request.close": "receivables.reconcile",
  // A supplier's payment status link, and stopping one: records on the payables side, as a customer's statement link is
  // on the receivables side (supplier status V6).
  "supplier_status.share": "records.write",
  "supplier_status.unshare": "records.write",
  // A customer's collection rules, and resolving what the collections stage asks a person (approve a reminder, hold
  // reminders until a day, no reminders, let them go again): they decide what the agent sends a customer, as turning
  // reminders on does, so owners and admins only, never the accountant's bookkeeping (collections context C4, C6).
  "collection_policy.set": "records.write",
  "collection_task.resolve": "records.write",
  // A project's budget and buffer are a control on what the agent sets aside, an owner's or admin's as the agent's
  // spending limit is; putting a bill, a milestone or a deal in a project is a record, entered as an invoice is
  // (project budgets P1-P3).
  "project.create": "agent.budget",
  "project.change": "agent.budget",
  "project.assign": "records.write",
  // The currency the report and plans total in, and a cash scenario saved as a version with the rates typed into it:
  // how the money is reported and planned, an owner's or admin's, never what is paid (currency provenance M4, M7).
  "workspace.reporting_currency": "reporting.manage",
  "cash_scenario.save": "reporting.manage",
  // A partner's commission plan, ending it, and the payable made from what a partner is due: records, as a deal and a
  // bill are, so owners and admins; an accountant reads them and creates no payable (commissions C13).
  "commission.set_plan": "records.write",
  "commission.end_plan": "records.write",
  "commission.create_payable": "records.write",
  // A draft the Chrome extension captured: captured, edited and sent for review through the extension, then added as a
  // bill or discarded in the console. Each is a records write, an owner's or admin's, as adding the bill is; adding it
  // runs `invoice.add` too (invoice capture design C1, C6, C16).
  "invoice_draft.capture": "records.write",
  "invoice_draft.edit": "records.write",
  "invoice_draft.send": "records.write",
  "invoice_draft.confirm": "records.write",
  "invoice_draft.discard": "records.write",
} as const satisfies Record<string, Permission>;

export type CommandName = keyof typeof COMMAND_PERMISSIONS;

/**
 * What each surface may run (R4). The console runs everything. Telegram adds invoices and decides nothing (Telegram
 * bot design R11). The API adds records and never decides (write API R3; part 2, W4). Slack decides a held payable, under a limit
 * each workspace sets and the chat's own rules (Slack design S8, S10), pauses the agent, and adds an invoice from a
 * message; resuming, and every other command, stays in the console. A pull request comment attaches a bounty, which is a
 * milestone, and nothing else (bounties B5). The Chrome extension captures, edits and sends a draft for review: never
 * an invoice, a decision or anything else, and the draft becomes a bill only in the console (invoice capture C16).
 */
export const SURFACE_COMMANDS: Record<SurfaceKind, readonly CommandName[]> = {
  console: Object.keys(COMMAND_PERMISSIONS) as CommandName[],
  telegram: ["invoice.add"],
  api: ["invoice.add", "milestone.add", "payee_link.create"],
  slack: ["payable.approve", "payable.reject", "payable.return", "agent.pause", "invoice.add"],
  github: ["milestone.add"],
  chrome: ["invoice_draft.capture", "invoice_draft.edit", "invoice_draft.send"],
};

/** A person's decisions on what the agent stopped: off on a chat whose workspace allows none there (Slack design S8). */
const DECISIONS: ReadonlySet<CommandName> = new Set(["payable.approve", "payable.approve_many", "payable.reject", "payable.return", "milestone.pay", "milestone.close"]);

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
