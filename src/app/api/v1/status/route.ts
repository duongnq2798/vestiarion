import { describeConfig } from "@/lib/config";
import { currentConfig } from "@/lib/context";
import { getChainProvider } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { stats } from "@/lib/queries";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";

export const dynamic = "force-dynamic";

/**
 * What this instance is, and what it can actually do.
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
  /** Payments and yield differ and are reported separately, as in the UI. */
  provenance: {
    payments: "live" | "simulate";
    yield: "live" | "simulate";
    screening: "live" | "simulate";
  };
  clock: { mode: "real" | "simulate"; day: number; lastCycleAt: string | null };
  totals: { decisionsLogged: number; totalPaidOut: number; flagged: number };
  configuration: Record<string, unknown>;
  apiVersion: "v1";
}

export async function GET(request: Request) {
  const denied = guardApiRequest(request, { scope: "read" });
  if (denied) return denied;

  return handleApiRequest("GET /api/v1/status", async (): Promise<ApiResource<StatusPayload>> => {
    const config = currentConfig();
    const provider = getChainProvider();
    const snapshot = await stats();

    return {
      data: {
        businessName: config.businessName,
        provenance: {
          payments: provider.mode,
          yield: provider.earnMode,
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
        configuration: describeConfig(config),
        apiVersion: "v1",
      },
    };
  });
}
