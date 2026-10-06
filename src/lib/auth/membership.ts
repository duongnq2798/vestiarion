import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { platformDb, unwrap } from "@/lib/dal";
import { touchOrgActivity } from "@/lib/platform/activity";
import { isValidSlug } from "./org-paths";
import { networkOf, type Network } from "@/lib/network";
import type { OrgRole } from "./roles";
import { verifySession, type SessionUser } from "./session";

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
  /** The network it pays on (0075), chosen when it was created (mainnet go-live M2). */
  network: Network;
}

type MembershipRow = {
  role: OrgRole;
  orgs: { id: string; slug: string; name: string; mode: "sandbox" | "live"; network?: string | null };
};

const SELECT = "role, orgs!inner(id, slug, name, mode, network)";

function toMembership(row: MembershipRow): OrgMembership {
  return { orgId: row.orgs.id, slug: row.orgs.slug, name: row.orgs.name, mode: row.orgs.mode, role: row.role, network: networkOf(row.orgs.network) };
}

/**
 * Through the service role: organizations and memberships are platform data,
 * the one thing that must be readable before a tenant is known.
 */
export const membershipsOf = cache(async (userId: string): Promise<OrgMembership[]> => {
  const rows = unwrap(await platformDb().from("memberships").select(SELECT).eq("user_id", userId)) as unknown as MembershipRow[];
  return rows.map(toMembership).sort((a, b) => a.name.localeCompare(b.name));
});

export const membershipFor = cache(async (userId: string, slug: string): Promise<OrgMembership | null> => {
  // A slug that could not exist never reaches the database.
  if (!isValidSlug(slug)) return null;
  const rows = unwrap(
    await platformDb().from("memberships").select(SELECT).eq("user_id", userId).eq("orgs.slug", slug).limit(1)
  ) as unknown as MembershipRow[];
  return rows[0] ? toMembership(rows[0]) : null;
});

/**
 * The actual gate. In this Next version a layout does not control whether its
 * child segments render or appear in the RSC payload — the router renders
 * route segments independently, so hiding or swapping them in a layout does
 * not stop them from running (see the shipped
 * `01-app/02-guides/authentication.md`, "Layouts and auth checks"). Every
 * page under `/o/[slug]` must therefore call this itself, before it loads any
 * tenant data — the layout's own check is defence in depth, not the gate. A
 * non-member and a slug that does not exist both end in the same `notFound()`,
 * so neither discloses whether another business exists.
 */
export const requireMembership = cache(
  async (slug: string): Promise<{ user: SessionUser; membership: OrgMembership }> => {
    const user = await verifySession(`/o/${slug}/console`);
    const membership = await membershipFor(user.id, slug);
    if (!membership) notFound();
    await touchOrgActivity(membership.orgId);
    return { user, membership };
  }
);
