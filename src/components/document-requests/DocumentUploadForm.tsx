"use client";

import { CircleCheck, FileText, Send, X } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { startDocumentUploadAction, submitDocumentAction, type DocumentSubmitResult } from "@/app/documents/[token]/actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { MAX_DOCUMENT_NOTE, MAX_DOCUMENT_PO, MAX_VENDOR_DOCUMENT_BYTES, missingWords, sniffDocumentType, type MissingDocument } from "@/lib/document-requests/rules";

const INITIAL: DocumentSubmitResult = { ok: false, message: "" };

/** What the vendor reads under the file (ER5). */
export const DOCUMENT_FILE_LINE = "One PDF, PNG or JPEG, up to 10 MB. Only the business you work with can open it.";
const TOO_LARGE = "The file is over 10 MB. Send a smaller copy.";
const NOT_SENT = "The file could not be sent. Try again in a moment.";

/**
 * What the file is, by its first bytes (ER5): a browser types a file by its name's extension, so a PDF saved with none
 * has no type, and one misnamed has the wrong one. Read here, it is the type the upload address is asked for and the file
 * is put with; a file that is none of the three keeps the browser's, for the server to refuse. The server reads the bytes
 * again when it is sent.
 */
async function typeOf(file: File): Promise<string> {
  try {
    return sniffDocumentType(new Uint8Array(await file.slice(0, 8).arrayBuffer())) ?? file.type;
  } catch {
    return file.type;
  }
}

export interface DocumentRequestShown {
  orgName: string;
  vendorName: string;
  reference: string | null;
  /** The amount as the page writes it, with its token: "1,250.00 USDC". */
  amount: string;
  /** The due date and the link's last day, as "Oct 30, 2026". */
  dueOn: string;
  until: string;
  missing: MissingDocument[];
}

/**
 * The vendor's page behind a document request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5):
 * which business asks, for which of the vendor's invoices, its amount and due date, and what is missing; then one file,
 * an optional purchase order number and a note. The file goes from the browser straight to the business's private
 * storage, at an address the server makes for this request, and the server then checks it and takes the answer once.
 * Opening the page changes nothing.
 */
export function DocumentUploadForm({ token, request }: { token: string; request: DocumentRequestShown }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<DocumentSubmitResult>(INITIAL);
  const [pending, startTransition] = useTransition();
  const what = missingWords(request.missing);
  const invoice = request.reference ? `invoice ${request.reference}` : "your invoice";

  function letGo() {
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
  }

  function choose(chosen: File | undefined) {
    if (chosen && chosen.size > MAX_VENDOR_DOCUMENT_BYTES) {
      letGo();
      setState({ ok: false, message: TOO_LARGE, field: "file" });
      return;
    }
    setState(INITIAL);
    if (chosen) setFile(chosen);
    else letGo();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.delete("file");
    if (!file) {
      setState({ ok: false, message: "Choose the file to send.", field: "file" });
      return;
    }
    startTransition(async () => {
      const type = await typeOf(file);
      const started = await startDocumentUploadAction(token, file.size, type);
      if (!started.ok || !started.url) {
        setState({ ok: false, message: started.message, field: "file" });
        return;
      }
      let put: Response | null = null;
      try {
        put = await fetch(started.url, { method: "PUT", body: file, headers: { "content-type": type, "x-upsert": "true" } });
      } catch {
        put = null;
      }
      if (!put?.ok) {
        setState({ ok: false, message: NOT_SENT, field: "file" });
        return;
      }
      const result = await submitDocumentAction(INITIAL, formData);
      if (!result.ok && result.field === "file") letGo();
      setState(result);
    });
  }

  const error = (field: "poReference" | "note") => (state.field === field ? state.message : undefined);

  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-ink-3">A document for your invoice</p>
        <h1 className="text-xl font-semibold text-ink [text-wrap:balance]">
          {request.orgName} needs {what}
        </h1>
        <p className="text-sm text-ink-2">
          {request.orgName} has {invoice} from {request.vendorName}. To check it, they need {what}.
        </p>
      </div>
      <dl className="grid gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
        {request.reference && (
          <div className="flex flex-wrap items-baseline gap-x-3">
            <dt className="w-24 shrink-0 text-ink-3">Invoice</dt>
            <dd className="min-w-0 break-all font-mono text-ink">{request.reference}</dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-24 shrink-0 text-ink-3">Amount</dt>
          <dd className="tabular-nums text-ink">{request.amount}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-24 shrink-0 text-ink-3">Due</dt>
          <dd className="text-ink">{request.dueOn}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-24 shrink-0 text-ink-3">Missing</dt>
          <dd className="text-ink">{what[0].toUpperCase() + what.slice(1)}</dd>
        </div>
      </dl>
      {state.ok ? (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
          {state.message}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4">
          <input type="hidden" name="token" value={token} />
          <div className="grid gap-2">
            <FileInput
              id="document-file"
              name="file"
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              label="Choose the document"
              description={DOCUMENT_FILE_LINE}
              inputRef={inputRef}
              disabled={pending}
              onFile={choose}
            />
            {file && (
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <FileText aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{file.name}</span>
                <Button type="button" variant="link" icon={<X />} onClick={letGo} disabled={pending}>
                  Remove file
                </Button>
              </div>
            )}
          </div>
          <Field id="document-po" label="Purchase order number" optional error={error("poReference")}>
            <Input name="poReference" maxLength={MAX_DOCUMENT_PO} autoComplete="off" placeholder="PO-100" />
          </Field>
          <Field id="document-note" label="Note" optional error={error("note")}>
            <Textarea name="note" rows={3} maxLength={MAX_DOCUMENT_NOTE} />
          </Field>
          <div className="grid gap-2">
            <p className="text-xs leading-5 text-ink-3">
              This link takes one document, until {request.until} (UTC). It never asks for a password, a key or a payment.
            </p>
            <FormMessage tone={state.message ? "error" : "neutral"}>{state.message && state.field !== "poReference" && state.field !== "note" ? state.message : null}</FormMessage>
          </div>
          <Button type="submit" loading={pending} icon={<Send />}>
            {pending ? "Sending…" : "Send the document"}
          </Button>
        </form>
      )}
    </Card>
  );
}
