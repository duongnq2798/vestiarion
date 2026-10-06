import { currentOrgConfig } from "./context";
import { networkOf, networkProfile, type NetworkProfile } from "./network";

/**
 * The profile of the workspace in scope (docs/superpowers/specs/2026-10-05-network-threading-design.md P1): what
 * `orgConfig` read from its row. Outside a workspace's scope it throws, as `currentOrgConfig` does; code that holds a
 * record reads the record's network instead.
 */
export function workspaceNetwork(): NetworkProfile {
  return networkProfile(networkOf(currentOrgConfig().network));
}
