import "server-only";
import { cache } from "react";
import { supabase, unwrap } from "@/lib/supabase";
import { isValidSlug } from "./org-paths";
import type { OrgRole } from "./roles";

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
}

type MembershipRow = {
  role: OrgRole;
  orgs: { id: string; slug: string; name: string; mode: "sandbox" | "live" };
};

const SELECT = "role, orgs!inner(id, slug, name, mode)";

function toMembership(row: MembershipRow): OrgMembership {
  return { orgId: row.orgs.id, slug: row.orgs.slug, name: row.orgs.name, mode: row.orgs.mode, role: row.role };
}

/**
 * Through the service role: organizations and memberships are platform data,
 * the one thing that must be readable before a tenant is known.
 */
export const membershipsOf = cache(async (userId: string): Promise<OrgMembership[]> => {
  const rows = unwrap(await supabase().from("memberships").select(SELECT).eq("user_id", userId)) as unknown as MembershipRow[];
  return rows.map(toMembership).sort((a, b) => a.name.localeCompare(b.name));
});

export const membershipFor = cache(async (userId: string, slug: string): Promise<OrgMembership | null> => {
  // A slug that could not exist never reaches the database.
  if (!isValidSlug(slug)) return null;
  const rows = unwrap(
    await supabase().from("memberships").select(SELECT).eq("user_id", userId).eq("orgs.slug", slug).limit(1)
  ) as unknown as MembershipRow[];
  return rows[0] ? toMembership(rows[0]) : null;
});
