import { verifyLedger, type VerificationResult } from "@/lib/ledger";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  return handleApiRequest(
    "GET /api/v1/ledger/verify",
    guard.key,
    async (): Promise<ApiResource<VerificationResult>> => ({
      data: await verifyLedger(),
    })
  );
}
