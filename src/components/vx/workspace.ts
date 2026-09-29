import type { OrgRole } from "@/lib/auth/roles";

/**
 * What the workspace frame shows of one membership. Built from platform data
 * the layout already holds after `requireMembership` — never from an
 * organization's own rows.
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
}
