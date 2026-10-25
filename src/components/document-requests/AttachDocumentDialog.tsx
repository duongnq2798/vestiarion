"use client";

import { FileText, Paperclip } from "lucide-react";
import { useCallback, useState } from "react";
import { attachDocumentAction, type DocumentRequestsActionResult } from "@/app/actions/document-requests";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { MAX_ATTACHED_DOCUMENT_BYTES } from "@/lib/document-requests/rules";

const INITIAL: DocumentRequestsActionResult = { ok: false, message: "" };
const attach = withSuccessToast(attachDocumentAction);

/** What the dialog says of a file it will not send: none chosen, not a PDF, or too large (DK11). */
export const CHOOSE_A_PDF = "Choose a PDF of up to 4 MB.";

/** What the dialog says the check does, in the mode vendor requests are in (document checks DK10, DK11). */
export function attachDescription(vendorName: string, mode: "shadow" | "on"): string {
  const choose = `Choose the PDF ${vendorName} sent you, such as their purchase order, of up to 4 MB.`;
  return mode === "on"
    ? `${choose} Vestiarion checks its vendor, amount and purchase order against the bill. When they match, it adds the purchase order, and a person approves the payment.`
    : `${choose} Vestiarion checks its vendor, amount and purchase order against the bill and says what it found. Vendor requests are in shadow, so the bill does not change.`;
}

/** Whether the browser's file can be sent: a PDF by its name or type, of at most 4 MB. The server reads its first bytes. */
function sendable(file: File | undefined): boolean {
  return Boolean(file && file.size > 0 && file.size <= MAX_ATTACHED_DOCUMENT_BYTES && (file.type === "application/pdf" || /\.pdf$/i.test(file.name)));
}

/**
 * Attach a document, beside Add details on a bill's card on Approvals and on Bills
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK11): an owner or admin adds the PDF a vendor
 * emailed them, such as their purchase order, and the cycle checks it against the bill within a minute, as one the
 * vendor sent through a request's link. Shown by the card only while vendor requests are in shadow or on (`mode`), once
 * migration 0144 has run, on a bill that waits for its purchase order or goods receipt with no payment sent for it.
 */
export function AttachDocumentDialog({
  orgSlug,
  invoiceId,
  vendorName,
  mode,
  size = "sm",
}: {
  orgSlug: string;
  invoiceId: string;
  vendorName: string;
  mode: "shadow" | "on";
  /** `touch` where it is decided from a phone too (Approvals). */
  size?: "sm" | "touch";
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    setFile(undefined);
  }, []);
  const { state, formProps } = useActionForm(attach, INITIAL, { resetOnSuccess: true, onSuccess: close });
  const refused = file !== undefined && !sendable(file);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFile(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant="secondary" icon={<Paperclip />}>
          Attach a document
        </Button>
      </DialogTrigger>
      <DialogContent title={`Attach ${vendorName}'s document`} description={attachDescription(vendorName, mode)}>
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <div className="grid gap-2">
            <FileInput id={`attach-document-${invoiceId}`} name="file" accept="application/pdf" label="PDF" onFile={setFile} />
            {file && (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <FileText aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{file.name}</span>
              </p>
            )}
          </div>
          <FormMessage tone={refused || (state.message && !state.ok) ? "error" : "neutral"}>{refused ? CHOOSE_A_PDF : state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Attaching…" disabled={!sendable(file)}>
              Attach and check
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
