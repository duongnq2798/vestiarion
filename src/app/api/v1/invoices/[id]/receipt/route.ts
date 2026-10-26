import { documentAnswer, evidenceReadsLimited, payableNotFound, workspaceInScope } from "@/lib/api/evidence";
import { guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { evidenceRequest } from "@/lib/evidence-read";
import { takeApiEvidenceToken } from "@/lib/rate-limit";
import { readReceiptDocument } from "@/lib/receipts/document-read";

export const dynamic = "force-dynamic";

/**
 * A payable's receipt (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA4):
 * `vestiarion-receipt/1`, what a receipt states for it, the entry that recorded it, its sharing and its two checks; not
 * ready yet, `ready: false` with a code and the builder's sentence. Never the receipt's link, its token or its hash. An id
 * that is not a UUID is not found before anything is read (EA5); a receivable and an unknown id are the same 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { id } = await params;
  const wanted = evidenceRequest("invoice", id);
  if (!wanted) return payableNotFound(id);
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/invoices/{id}/receipt", guard.key, async () => {
    const document = await readReceiptDocument({ invoiceId: wanted.id, workspace: await workspaceInScope() });
    return document ? documentAnswer(document) : payableNotFound(id);
  });
}
