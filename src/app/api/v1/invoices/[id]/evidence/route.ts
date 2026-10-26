import { documentAnswer, evidenceReadsLimited, payableNotFound, readPaymentEvidence } from "@/lib/api/evidence";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { evidenceRequest } from "@/lib/evidence-read";
import { takeApiEvidenceToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * One payable's evidence (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA1-EA3): the
 * file the evidence page's Download evidence gives, `vestiarion-evidence/1`, with members named by user id. An id that is
 * not a UUID is not found before anything is read, and spends no evidence read (EA5, EA6); a receivable, an unknown id
 * and another workspace's are the same 404, since every read runs in the key's workspace.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { id } = await params;
  const wanted = evidenceRequest("invoice", id);
  if (!wanted) return payableNotFound(id);
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/invoices/{id}/evidence", guard.key, async () => {
    const document = await readPaymentEvidence("invoice", wanted.id);
    return document ? documentAnswer(document) : payableNotFound(id);
  });
}
