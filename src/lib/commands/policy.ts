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
  "milestone.pay": "approval.decide",
  "milestone.close": "approval.decide",
  "agent.pause": "agent.pause",
  "agent.resume": "agent.resume",
  "agent.run_cycle": "agent.run_cycle",
  "invoice.add": "records.write",
} as const satisfies Record<string, Permission>;

export type CommandName = keyof typeof COMMAND_PERMISSIONS;

/**
 * What each surface may run (R4). The console runs everything. Telegram adds invoices and decides nothing (Telegram
 * bot design R11). The API adds records and never decides (write API R3). Slack decides a held payable, under a limit
 * each workspace sets and the chat's own rules (Slack design S8, S10), and pauses the agent; resuming, and every other
 * command, stays in the console.
 */
export const SURFACE_COMMANDS: Record<SurfaceKind, readonly CommandName[]> = {
  console: Object.keys(COMMAND_PERMISSIONS) as CommandName[],
  telegram: ["invoice.add"],
  api: ["invoice.add"],
  slack: ["payable.approve", "payable.reject", "payable.return", "agent.pause", "invoice.add"],
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
