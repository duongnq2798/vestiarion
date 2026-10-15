import { z } from "zod";
import { captureInvoiceDraft } from "@/lib/commands/invoice-drafts";
import { draftAnswer, refusedAnswer } from "@/lib/extension/drafts-http";
import { extensionError, extensionPreflight, guardExtensionRequest, inExtensionScope, readExtensionJson } from "@/lib/extension/http";
import { captureTooLarge, type CaptureInput } from "@/lib/invoice-drafts/capture";
import { MAX_JSON_BYTES } from "@/lib/invoice-drafts/model";
import { MAX_DOCUMENT_BYTES } from "@/lib/invoice-document/read";
import { takeDocumentReadToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A capture from the Chrome extension (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C2, C19, C20): the
 * text a person selected, as `{ source: "selection", text }`, or a file they chose, as `multipart/form-data` with
 * `file`. Read by the reader into a new draft, still `draft`, which only this connection can read or change until it
 * is sent. An `Idempotency-Key` is required: the same key and the same capture answer the same draft, so a double
 * click makes one.
 */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const selectionSchema = z.object({ source: z.literal("selection"), text: z.string() }).strict();
/** A file's form, with room for its multipart framing. */
const MAX_FORM_BYTES = MAX_DOCUMENT_BYTES + 64_000;
const TOO_LARGE = "Choose a file of at most 4 MB.";

async function captureOf(request: Request): Promise<{ input: CaptureInput } | { denied: Response }> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("multipart/form-data")) {
    // The size is known before anything is read: a file sent without its length is refused, never buffered to find out.
    const length = request.headers.get("content-length");
    const declared = Number(length);
    if (length === null || !Number.isFinite(declared)) return { denied: extensionError(request, "length_required", "Send the file with its Content-Length.") };
    if (declared > MAX_FORM_BYTES) return { denied: extensionError(request, "payload_too_large", TOO_LARGE) };
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { denied: extensionError(request, "invalid_request", "The file could not be read from the form.") };
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { denied: extensionError(request, "invalid_request", "Choose a file to capture.") };
    if (file.size > MAX_DOCUMENT_BYTES) return { denied: extensionError(request, "payload_too_large", TOO_LARGE) };
    return { input: { source: "file", bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.slice(0, 200), type: file.type } };
  }
  const body = await readExtensionJson(request, MAX_JSON_BYTES);
  if ("denied" in body) return body;
  const parsed = selectionSchema.safeParse(body.value);
  if (!parsed.success) return { denied: extensionError(request, "invalid_request", 'Send { "source": "selection", "text": … }, or a file as multipart/form-data.') };
  if (!/[A-Za-z0-9]/.test(parsed.data.text)) return { denied: extensionError(request, "invalid_request", "Select the invoice's text on the page first.") };
  return { input: { source: "selection", text: parsed.data.text } };
}

export function OPTIONS(request: Request) {
  return extensionPreflight(request, "POST");
}

export async function POST(request: Request) {
  const guard = await guardExtensionRequest(request, "invoice_draft:create");
  if ("denied" in guard) return guard.denied;
  const key = request.headers.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    return extensionError(request, "invalid_request", "Send an Idempotency-Key header of 1 to 100 letters, digits, dots, colons, dashes or underscores.");
  }
  const capture = await captureOf(request);
  if ("denied" in capture) return capture.denied;
  const tooLarge = captureTooLarge(capture.input);
  if (tooLarge) return extensionError(request, "payload_too_large", tooLarge);

  const { principal, actor } = guard;
  return inExtensionScope(request, principal, "POST /api/extension/v1/invoice-drafts", async () => {
    const outcome = await captureInvoiceDraft(actor, {
      connectionId: principal.connectionId,
      idempotencyKey: key,
      capture: capture.input,
      today: new Date().toISOString().slice(0, 10),
      allowRead: () => takeDocumentReadToken(principal.orgId),
    });
    if (!outcome.ok) return refusedAnswer(request, outcome);
    return draftAnswer(request, principal, outcome.draft, {
      status: outcome.replayed ? 200 : 201,
      headers: outcome.replayed ? { "Idempotent-Replayed": "true" } : {},
    });
  });
}
