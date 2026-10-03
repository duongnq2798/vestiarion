import { canAssignRole, type OrgRole } from "./auth/roles";

/**
 * What the Members page says about the API keys a membership takes with it
 * (docs/superpowers/specs/2026-10-03-member-api-keys-design.md R9). A key
 * works only while its creator is a member (migration 0069), so leaving, or
 * being removed, revokes the keys the person created in this workspace; the
 * confirmation names them first.
 */

/** "a"; "a" and "b"; "a", "b" and "c". Each name is quoted, as Settings quotes a key's name. */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function keysClause(names: readonly string[], who: "they" | "you"): string {
  if (names.length === 0) return "";
  const subject = names.length === 1 ? `the API key ${who} created stops working` : `the API keys ${who} created stop working`;
  return `, and ${subject}: ${quotedList(names)}`;
}

export function removeMemberDescription(keyNames: readonly string[]): string {
  return `They lose access to this workspace at once${keysClause(keyNames, "they")}. The removal is recorded in the audit log, and you can invite them again later.`;
}

export function leaveWorkspaceDescription(keyNames: readonly string[]): string {
  return `You lose access at once${keysClause(keyNames, "you")}. An owner or admin can invite you back.`;
}

/**
 * The key names the Members page hands the browser: the viewer's own, for
 * Leave, and those of each member the viewer may remove. A viewer or an
 * approver, who removes no one, gets their own only.
 */
export function keyNamesForViewer(input: {
  members: ReadonlyArray<{ userId: string; role: OrgRole }>;
  viewerId: string;
  viewerRole: OrgRole;
  byCreator: Readonly<Record<string, string[]>>;
}): Record<string, string[]> {
  const names: Record<string, string[]> = {};
  for (const member of input.members) {
    if (member.userId === input.viewerId || canAssignRole(input.viewerRole, member.role)) {
      names[member.userId] = input.byCreator[member.userId] ?? [];
    }
  }
  return names;
}
