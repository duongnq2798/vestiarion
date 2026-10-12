import type { OrgRole } from "../auth/roles";
import { can } from "../auth/roles";
import { withOrg } from "../dal/scope";
import { connectionFor, disconnectConnection, type Connection } from "./connections";
import { ProviderError, type AccountingProvider } from "./provider";
import { connectionTokenStore } from "./token-store";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "./tokens";

/**
 * A provider's Disconnect URL (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q12): where QuickBooks
 * sends a person after they disconnect the app on its side. A plain link anyone could open, so it records nothing on
 * its say-so: for each workspace where the signed-in person manages integrations, it asks the provider whether the
 * connection still works, and marks it revoked only when the provider refuses it. A working connection is left as it
 * is, and so is one the provider did not answer about; the next sync finds out.
 */

/** What the provider says of a connection now. */
export type ProviderCheck = "accepted" | "refused" | "unknown";

const refusedToken = (outcome: Exclude<AccessOutcome, { ok: true }>): ProviderCheck =>
  outcome.reason === "reconnect" || outcome.reason === "missing" ? "refused" : "unknown";

/**
 * Whether the provider still accepts a connection: a fresh access token through the serialized refresh (X5), then one
 * cheap read (the accounts payments can be booked to). A refused refresh, a 403, or a 401 the refresh does not cure is
 * a refusal; anything else is not known.
 */
export async function providerAccepts(
  connection: Connection,
  provider: AccountingProvider,
  deps: { tokens?: TokenStore; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ProviderCheck> {
  const store = deps.tokens ?? connectionTokenStore(connection.orgId, connection.id);
  const token = (refused?: string) => freshAccessToken({ store, refresh: provider.refresh, now: deps.now, sleep: deps.sleep, ...(refused ? { refused } : {}) });
  const read = async (accessToken: string): Promise<ProviderCheck | "unauthorized"> => {
    try {
      await provider.accounts({ accessToken, externalOrgId: connection.externalOrgId });
      return "accepted";
    } catch (error) {
      if (!(error instanceof ProviderError)) return "unknown";
      if (error.failure === "forbidden") return "refused";
      return error.failure === "unauthorized" ? "unauthorized" : "unknown";
    }
  };
  const first = await token();
  if (!first.ok) return refusedToken(first);
  const answer = await read(first.accessToken);
  if (answer !== "unauthorized") return answer;
  const again = await token(first.accessToken);
  if (!again.ok) return refusedToken(again);
  const second = await read(again.accessToken);
  return second === "unauthorized" ? "refused" : second;
}

export interface DisconnectedWorkspace {
  orgId: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export interface DisconnectedOutcome {
  slug: string;
  workspace: string;
  organisation: string | null;
  /** `disconnected`: the provider refused it, and it is marked so now. `still_connected`: the provider accepts it. */
  outcome: "disconnected" | "still_connected" | "unknown";
}

/**
 * Checks, and records where the provider confirms it, each connection the person could disconnect themselves: the
 * workspaces where they manage integrations, and only the provider's organisation it named, when it named one.
 */
export async function confirmDisconnected(
  input: { userId: string; workspaces: readonly DisconnectedWorkspace[]; externalOrgId: string | null; nowMs?: number },
  deps: { provider: AccountingProvider; accepts?: (connection: Connection) => Promise<ProviderCheck> }
): Promise<DisconnectedOutcome[]> {
  const accepts = deps.accepts ?? ((connection: Connection) => providerAccepts(connection, deps.provider));
  const outcomes: DisconnectedOutcome[] = [];
  for (const workspace of input.workspaces) {
    if (!can(workspace.role, "integrations.manage")) continue;
    const outcome = await withOrg(
      workspace.orgId,
      async (): Promise<DisconnectedOutcome | null> => {
        const connection = await connectionFor(deps.provider.id);
        if (!connection || connection.status === "revoked") return null;
        if (input.externalOrgId && connection.externalOrgId !== input.externalOrgId) return null;
        const base = { slug: workspace.slug, workspace: workspace.name, organisation: connection.externalOrgName };
        const check = await accepts(connection);
        if (check === "accepted") return { ...base, outcome: "still_connected" };
        if (check === "unknown") return { ...base, outcome: "unknown" };
        await disconnectConnection({ connection, by: input.userId, revoke: deps.provider.revoke, atProvider: true, nowMs: input.nowMs });
        return { ...base, outcome: "disconnected" };
      },
      { userId: input.userId }
    ).catch((error: unknown) => {
      // One workspace's failure is its own; the page says nothing about it rather than something untrue.
      console.error("connector: a disconnect was not confirmed", workspace.orgId, error instanceof Error ? error.message : "unknown error");
      return null;
    });
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}
