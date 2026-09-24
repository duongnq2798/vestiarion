import { verifyLedger, type VerificationResult } from "@/lib/ledger";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardApiRequest(request, { scope: "read" });
  if (denied) return denied;

  return handleApiRequest(
    "GET /api/v1/ledger/verify",
    async (): Promise<ApiResource<VerificationResult>> => ({
      data: await verifyLedger(),
    })
  );
}
