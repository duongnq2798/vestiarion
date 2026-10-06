import type { OrgRole } from "@/lib/auth/roles";
import type { Network } from "@/lib/network";

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
  /** The network it pays on, shown beside its mode so Arc testnet and Arc mainnet are told apart. */
  network: Network;
}
