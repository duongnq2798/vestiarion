import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { documentAnswer, evidenceReadsLimited, PAYEE_LOCK_TOO_LARGE, PERIOD_REFUSED, workspaceInScope } from "@/lib/api/evidence";
import { parsePeriod } from "@/lib/payee-lock-evidence";
import { readPayeeLockEvidence } from "@/lib/payee-lock-evidence-read";
import { takeApiEvidenceToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The payee lock's evidence for a period (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA1-EA3): the file the evidence pack's Download signed JSON gives, `vestiarion-payee-lock-evidence/1`, with members
 * named by user id. `from` and `to` are whole UTC days, either left out for an open end; a period that does not read is
 * refused before anything is read, and spends no evidence read (EA5, EA6). An answer over 4 MB is refused (EA7).
 */
export async function GET(request: Request) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const query = new URL(request.url).searchParams;
  const period = parsePeriod(query.get("from"), query.get("to"));
  if (!period) return apiError("invalid_request", PERIOD_REFUSED);
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/payee-lock/evidence", guard.key, async () => {
    const document = await readPayeeLockEvidence({ workspace: await workspaceInScope(), period, people: "id" });
    return documentAnswer(document, { tooLarge: PAYEE_LOCK_TOO_LARGE });
  });
}
