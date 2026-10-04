import type { CycleEvent, CycleEventKind } from "../agent/cycle-soon";
import { isOrgRole, type OrgRole } from "../auth/roles";
import { platformDb } from "../dal";
import type { Provenance } from "../provenance";

/**
 * Who acts, and through which surface (integrations design §8). An actor is one member of one workspace: the console's
 * signed-in person, a member whose chat account is linked to them, or the person who issued an API key. A surface
 * other than the console builds its actor with `memberActor`, which reads the role and the workspace's mode for this
 * action (R7): nothing a link, a key or a button carries is believed about either.
 */

export type Surface =
  | { kind: "console" }
  | { kind: "telegram"; linkId: string }
  /** The install's limit on deciding payments from Slack, as read for this action; null when deciding there is off (Slack design S8). */
  | { kind: "slack"; linkId: string; decisionsLimitUsdc: number | null }
  | { kind: "api"; apiKeyId: string }
  /** A comment on a pull request in an installation the workspace connected, by the GitHub user who wrote it (bounties B5). */
  | { kind: "github"; installationId: number; login: string };

export type SurfaceKind = Surface["kind"];

export interface Actor {
  orgId: string;
  userId: string;
  role: OrgRole;
  mode: "sandbox" | "live";
  surface: Surface;
}

/** As much of a successful `authorize` as an actor needs. */
export interface ConsoleAccess {
  user: { id: string };
  membership: { orgId: string; role: OrgRole; mode: "sandbox" | "live" };
}

/** The console's signed-in person: `authorize` has just read their role from their membership. */
export function consoleActor(access: ConsoleAccess): Actor {
  return {
    orgId: access.membership.orgId,
    userId: access.user.id,
    role: access.membership.role,
    mode: access.membership.mode,
    surface: { kind: "console" },
  };
}

/**
 * A member acting through another surface, with their role and the workspace's mode read now. Null when they are no
 * longer a member, so a link or a key that outlived its membership acts for nobody.
 */
export async function memberActor(orgId: string, userId: string, surface: Exclude<Surface, { kind: "console" }>): Promise<Actor | null> {
  const membership = await platformDb().from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle<{ role: unknown }>();
  if (membership.error) throw new Error(membership.error.message);
  const role = membership.data?.role;
  if (!isOrgRole(role)) return null;
  const org = await platformDb().from("orgs").select("mode").eq("id", orgId).maybeSingle<{ mode: unknown }>();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) return null;
  return { orgId, userId, role, mode: org.data.mode === "live" ? "live" : "sandbox", surface };
}

/** What a domain function records about where the actor acted from (R3): nothing for the console. */
export function provenanceOf(actor: Actor): { provenance?: Provenance } {
  const surface = actor.surface;
  switch (surface.kind) {
    case "console":
      return {};
    case "telegram":
    case "slack":
      return { provenance: { via: surface.kind, linkId: surface.linkId } };
    case "api":
      return { provenance: { via: "api", apiKeyId: surface.apiKeyId } };
    case "github":
      return { provenance: { via: "github", installationId: surface.installationId, login: surface.login } };
  }
}

/** The actor as `sendNoticesSoon` takes it. */
export function accessOf(actor: Actor): { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } } {
  return { user: { id: actor.userId }, membership: { orgId: actor.orgId, mode: actor.mode } };
}

/** The event an action raises for the agent, as `runCycleSoon` takes it. */
export function cycleEventOf(actor: Actor, kind: CycleEventKind): CycleEvent {
  return { orgId: actor.orgId, userId: actor.userId, sandbox: actor.mode === "sandbox", kind };
}
