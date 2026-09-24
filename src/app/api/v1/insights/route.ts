import { getInsightsData, type InsightsData } from "@/lib/insights";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardApiRequest(request, { scope: "read" });
  if (denied) return denied;

  return handleApiRequest(
    "GET /api/v1/insights",
    async (): Promise<ApiResource<InsightsData>> => ({
      // Return the read model intact: nullable comparisons and partial cycle
      // statuses carry meaning and must not be flattened for the API.
      data: await getInsightsData(),
    })
  );
}
