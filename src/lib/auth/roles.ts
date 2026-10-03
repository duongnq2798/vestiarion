export const ORG_ROLES = ["owner", "admin", "approver", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Spec §7 as data. Pause and resume are asymmetric on purpose: anyone who can
 * approve money leaving can stop it; starting it again is deliberate. An
 * approver cannot create records, separating maker from checker.
 */
export const PERMISSIONS = {
  "workspace.read": ["owner", "admin", "approver", "viewer"],
  "agent.pause": ["owner", "admin", "approver"],
  "approval.decide": ["owner", "admin", "approver"],
  "records.write": ["owner", "admin"],
  "agent.run_cycle": ["owner", "admin"],
  "agent.resume": ["owner", "admin"],
  // The agent's spending limit: loosening it is as deliberate as resuming the agent.
  "agent.budget": ["owner", "admin"],
  "members.manage": ["owner", "admin"],
  "api_keys.manage": ["owner", "admin"],
  "webhooks.manage": ["owner", "admin"],
  // Moving treasury cash between the workspace's own wallets, such as into its Gateway balance.
  "treasury.manage": ["owner", "admin"],
  // Connecting the workspace to Slack, which sends the agent's decisions to a channel, or removing it (Slack design S3).
  "integrations.manage": ["owner", "admin"],
  "org.administer": ["owner"],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: OrgRole | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly OrgRole[]).includes(role);
}

const RANK: Record<OrgRole, number> = { viewer: 0, approver: 1, admin: 2, owner: 3 };

/**
 * An owner may assign any role. An admin may assign approver and viewer only,
 * and nobody else assigns roles at all (spec §7: no one grants a role above
 * their own, and admin and owner changes are the owner's).
 */
export function canAssignRole(actor: OrgRole | null | undefined, target: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return RANK[target] < RANK.admin;
  return false;
}
