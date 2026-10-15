import { editInvoiceDraft } from "@/lib/commands/invoice-drafts";
import { draftAnswer, refusedAnswer } from "@/lib/extension/drafts-http";
import { extensionError, extensionPreflight, guardExtensionRequest, inExtensionScope, readExtensionJson } from "@/lib/extension/http";
import { draftEditSchema, MAX_JSON_BYTES } from "@/lib/invoice-drafts/model";
import { draftOfConnection } from "@/lib/invoice-drafts/store";

export const dynamic = "force-dynamic";

/**
 * One draft the extension captured (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C3, C4, C19): read it,
 * or save the person's edits while it is still `draft`. A draft another connection captured is not found.
 */

const NOT_FOUND = "No draft with that id was captured through this connection.";

export function OPTIONS(request: Request) {
  return extensionPreflight(request, "GET, PATCH");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardExtensionRequest(request, "invoice_draft:read");
  if ("denied" in guard) return guard.denied;
  const { id } = await params;
  const { principal } = guard;
  return inExtensionScope(request, principal, "GET /api/extension/v1/invoice-drafts/{id}", async () => {
    const draft = await draftOfConnection(id, principal.connectionId);
    if (!draft) return extensionError(request, "not_found", NOT_FOUND);
    return draftAnswer(request, principal, draft);
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardExtensionRequest(request, "invoice_draft:create");
  if ("denied" in guard) return guard.denied;
  const { id } = await params;
  const body = await readExtensionJson(request, MAX_JSON_BYTES);
  if ("denied" in body) return body.denied;
  const parsed = draftEditSchema.safeParse(body.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue?.code === "unrecognized_keys" ? `${issue.keys[0]}: is not a field a draft has.` : `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid."}`;
    return extensionError(request, "invalid_request", message);
  }
  const { principal, actor } = guard;
  return inExtensionScope(request, principal, "PATCH /api/extension/v1/invoice-drafts/{id}", async () => {
    const outcome = await editInvoiceDraft(actor, { draftId: id, connectionId: principal.connectionId, edit: parsed.data });
    if (!outcome.ok) return refusedAnswer(request, outcome);
    return draftAnswer(request, principal, outcome.draft);
  });
}
