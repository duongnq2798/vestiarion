import { supabase, unwrap } from "@/lib/supabase";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";
import { mapTreasuryPayload, type TreasuryPayload } from "@/lib/api/treasury";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardApiRequest(request, { scope: "read" });
  if (denied) return denied;

  return handleApiRequest(
    "GET /api/v1/treasury",
    async (): Promise<ApiResource<TreasuryPayload>> => {
      const db = supabase();
      const [accountResult, snapshotResult, forecastResult, actionResult] = await Promise.all([
        db
          .from("accounts")
          .select("id, name, kind, chain, token, address, balance, apy")
          .order("kind", { ascending: true })
          .order("name", { ascending: true }),
        db
          .from("cycle_snapshots")
          .select("captured_at, obligations_due_7d, obligations_due_14d")
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from("forecasts")
          .select(
            "id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance, recommendation"
          )
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from("treasury_actions")
          .select("id, action, amount, from_account, to_account, reasoning, created_at")
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      const accounts = unwrap(accountResult) as Array<Record<string, unknown>>;
      if (snapshotResult.error) throw new Error(snapshotResult.error.message);
      if (forecastResult.error) throw new Error(forecastResult.error.message);
      const actions = unwrap(actionResult) as Array<Record<string, unknown>>;

      return {
        data: mapTreasuryPayload(
          accounts,
          snapshotResult.data as Record<string, unknown> | null,
          forecastResult.data as Record<string, unknown> | null,
          actions
        ),
      };
    }
  );
}
