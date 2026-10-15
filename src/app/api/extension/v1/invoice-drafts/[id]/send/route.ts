import { sendInvoiceDraft } from "@/lib/commands/invoice-drafts";
import { draftAnswer, refusedAnswer } from "@/lib/extension/drafts-http";
import { extensionPreflight, guardExtensionRequest, inExtensionScope } from "@/lib/extension/http";

export const dynamic = "force-dynamic";

/**
 * Sends a draft for review (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C4, C8): it is listed under
 * Captured drafts on Bills & receivables, still a draft, until a person adds it as a bill or discards it there. The
 * answer carries `reviewUrl`, the page it is reviewed on.
 */
export function OPTIONS(request: Request) {
  return extensionPreflight(request, "POST");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardExtensionRequest(request, "invoice_draft:create");
  if ("denied" in guard) return guard.denied;
  const { id } = await params;
  const { principal, actor } = guard;
  return inExtensionScope(request, principal, "POST /api/extension/v1/invoice-drafts/{id}/send", async () => {
    const outcome = await sendInvoiceDraft(actor, { draftId: id, connectionId: principal.connectionId });
    if (!outcome.ok) return refusedAnswer(request, outcome);
    return draftAnswer(request, principal, outcome.draft);
  });
}
