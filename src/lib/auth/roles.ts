/**
 * Highest first; `viewer`, the role an invitation starts on, stays last. `accountant` (accountant console A1) is an
 * outside accountant or bookkeeper: it reads everything, books payments in the accounting tool and does the receivables
 * bookkeeping, and decides no payment.
 */
export const ORG_ROLES = ["owner", "admin", "approver", "accountant", "viewer"] as const;
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
  "workspace.read": ["owner", "admin", "approver", "accountant", "viewer"],
  "agent.pause": ["owner", "admin", "approver"],
  "approval.decide": ["owner", "admin", "approver"],
  "records.write": ["owner", "admin"],
  // The receivables bookkeeping: applying money received to receivables or reversing that, and answering or closing what
  // a customer said through their statement link (accountant console A1). Owners and admins held it as records.write
  // before; the accountant gets it without adding bills or receivables.
  "receivables.reconcile": ["owner", "admin", "accountant"],
  "agent.run_cycle": ["owner", "admin"],
  "agent.resume": ["owner", "admin"],
  // The agent's spending limit: loosening it is as deliberate as resuming the agent.
  "agent.budget": ["owner", "admin"],
  // The figure above which a payment needs two approvals: a control over everyone who approves, admins included.
  "approval.policy": ["owner"],
  "members.manage": ["owner", "admin"],
  "api_keys.manage": ["owner", "admin"],
  "webhooks.manage": ["owner", "admin"],
  // Moving treasury cash between the workspace's own wallets, such as into its Gateway balance.
  "treasury.manage": ["owner", "admin"],
  // Connecting the workspace to Slack, which sends the agent's decisions to a channel, or removing it (Slack design S3); to
  // GitHub; and to Xero or QuickBooks, whose bills it reads, with the account payments will be booked to (Xero
  // connector X3, QuickBooks connector Q1).
  "integrations.manage": ["owner", "admin"],
  // Writing a payment made on Arc into the business's own books, after reviewing exactly what is written (accounting
  // write-back W6): its own act, apart from adding records and from deciding payments, so the accountant holds it
  // without either (accountant console A1).
  "accounting.book": ["owner", "admin", "accountant"],
  // Putting the workspace's report outside it by a public link, or stopping one: a control over every member's data,
  // as API keys and webhooks are (shared report S3).
  "report.share": ["owner", "admin"],
  "org.administer": ["owner"],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/** What each role may do, in a sentence, where a role is chosen (the invitation form) and in the docs. */
export const ROLE_SUMMARIES: Record<OrgRole, string> = {
  owner: "Everything an admin does, and connects Circle, sets the two-approval figure and can delete the workspace.",
  admin: "Adds bills and receivables, runs and resumes the agent, and manages members, API keys, webhooks, integrations and treasury.",
  approver: "Decides the payments the agent held, and pauses the agent. Adds no records.",
  accountant:
    "Reads everything, books payments in Xero, applies money received and answers customers. Decides no payment, and changes no treasury, limit, integration or member.",
  viewer: "Reads the workspace.",
};

export function can(role: OrgRole | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly OrgRole[]).includes(role);
}

// The accountant ranks with the approver: each holds a duty the other does not, and both sit below an admin.
const RANK: Record<OrgRole, number> = { viewer: 0, accountant: 1, approver: 1, admin: 2, owner: 3 };

/**
 * An owner may assign any role. An admin may assign approver, accountant and viewer only,
 * and nobody else assigns roles at all (spec §7: no one grants a role above
 * their own, and admin and owner changes are the owner's).
 */
export function canAssignRole(actor: OrgRole | null | undefined, target: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return RANK[target] < RANK.admin;
  return false;
}
