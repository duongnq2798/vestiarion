import { describeConfig, type VestiarionConfig } from "@/lib/config";
import { currentConfig } from "@/lib/context";
import { chainModes, hasNoProvider } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { stats } from "@/lib/queries";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";

export const dynamic = "force-dynamic";

/**
 * What this workspace is, and what it can actually do.
 *
 * The first call any client should make. A bot needs to know whether payments
 * are live before it tells someone an invoice was settled, and an MCP server
 * needs to report capability rather than guess at it.
 *
 * `describeConfig` is used rather than the config itself because this response
 * crosses a network: it reports what is configured without carrying any of the
 * eight secrets a full config holds, and there is a test that says so.
 */
export interface StatusPayload {
  businessName: string;
  /**
   * Payments and yield differ and are reported separately, as in the UI.
   * `unavailable` means the organization's Circle credentials are stored but
   * could not be read: cycles refuse to pay then rather than simulate (R12),
   * so neither leg is live or simulated.
   */
  provenance: {
    payments: "live" | "simulate" | "unavailable";
    yield: "live" | "simulate" | "unavailable";
    screening: "live" | "simulate";
  };
  clock: { mode: "real" | "simulate"; day: number; lastCycleAt: string | null };
  totals: { decisionsLogged: number; totalPaidOut: number; flagged: number };
  configuration: Record<string, unknown>;
  apiVersion: "v1";
}

/**
 * `describeConfig` also reports `database.*` — the Supabase project host and
 * whether tenant access is set up. Those describe the deployment, not the
 * workspace the calling key belongs to, so a workspace key must not see them
 * (K6: this surface serves the key's own workspace and nothing platform-wide).
 * `describeConfig` itself is unchanged; other callers still get the full
 * shape.
 */
function describeWorkspaceConfig(config: VestiarionConfig): Record<string, unknown> {
  const described = describeConfig(config);
  delete described.database;
  return described;
}

export async function GET(request: Request) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  return handleApiRequest("GET /api/v1/status", guard.key, async (): Promise<ApiResource<StatusPayload>> => {
    const config = currentConfig();
    // Modes, not the provider: status must still answer when the
    // organization's Circle credentials cannot be read (R12), or when it is on
    // Arc mainnet with no Circle account yet (mainnet limits L7). chainModes()
    // reports simulate/simulate then so pages render, but nothing pays in
    // either state, so a client told `simulate` would wait for settlements that
    // never come.
    const unreadable = hasNoProvider(config);
    const modes = chainModes();
    const snapshot = await stats();

    return {
      data: {
        businessName: config.businessName,
        provenance: {
          payments: unreadable ? "unavailable" : modes.mode,
          yield: unreadable ? "unavailable" : modes.earnMode,
          screening: screeningMode(),
        },
        clock: {
          mode: config.clockMode,
          day: snapshot.day,
          lastCycleAt: snapshot.lastCycleAt,
        },
        totals: {
          decisionsLogged: snapshot.decisionsLogged,
          totalPaidOut: snapshot.totalPaidOut,
          flagged: snapshot.flagged,
        },
        configuration: describeWorkspaceConfig(config),
        apiVersion: "v1",
      },
    };
  });
}
