export const ORG_ROLES = ["owner", "admin", "approver", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Plan 1's entire permission model. Plan 3 replaces this with the full role
 * table from spec §7; until then the only safe rule with a single user is that
 * only an owner changes anything.
 */
export function canMutate(role: OrgRole | null | undefined): boolean {
  return role === "owner";
}
