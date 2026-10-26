import { documentAnswer, evidenceReadsLimited, milestoneNotFound, readPaymentEvidence } from "@/lib/api/evidence";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { evidenceRequest } from "@/lib/evidence-read";
import { takeApiEvidenceToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * One milestone's evidence (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA1-EA3): a
 * payable's format, `vestiarion-evidence/1`, with members named by user id. An id that is not a UUID is not found before
 * anything is read, and spends no evidence read (EA5, EA6); an unknown id and another workspace's are the same 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { id } = await params;
  const wanted = evidenceRequest("milestone", id);
  if (!wanted) return milestoneNotFound(id);
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/milestones/{id}/evidence", guard.key, async () => {
    const document = await readPaymentEvidence("milestone", wanted.id);
    return document ? documentAnswer(document) : milestoneNotFound(id);
  });
}
