"use client";

import { CircleCheck, FileText, Send, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { submitPayeeInvoiceAction, type PayeeInvoiceResult } from "@/app/payee/[token]/actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { PAYEE_FILE_MAX_BYTES, PAYEE_FILE_MESSAGES, PAYEE_INVOICE_NOTE_MAX, PAYEE_INVOICE_NUMBER_MAX, type PayeeInvoiceField } from "@/lib/payee-invoice";

const INITIAL: PayeeInvoiceResult = { ok: false, message: "" };

/** What the payee reads under the file: only the text is kept (payee invoice link P4). */
export const INVOICE_FILE_LINE = "A PDF or a text file, up to 4 MB. Only its text is kept, never the file.";

/**
 * The payee's invoice, on a link that asks for it (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P4):
 * the invoice number, the amount in USDC, the due date, and optionally a note and the invoice as a file. Sending it
 * refreshes the page into the next step, which the link now shows. `today` and `lastDay` are the UTC days the due date
 * may fall between, from the server, so the form and the check agree.
 */
export default function PayeeInvoiceForm({ token, orgName, today, lastDay }: { token: string; orgName: string; today: string; lastDay: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState("");
  const letGo = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
  }, []);
  // A refusal about the file lets it go, so the next send is without it unless another is chosen.
  const onResult = useCallback(
    (result: PayeeInvoiceResult) => {
      if (!result.ok && result.field === "file") letGo();
    },
    [letGo]
  );
  const { state, formProps } = useActionForm(submitPayeeInvoiceAction, INITIAL, { onSuccess: () => router.refresh(), onResult });

  if (state.ok) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
        {state.message}
      </p>
    );
  }

  const error = (field: PayeeInvoiceField) => (state.field === field ? state.message : undefined);
  function choose(chosen: File | undefined) {
    const tooLarge = chosen !== undefined && chosen.size > PAYEE_FILE_MAX_BYTES;
    setFileProblem(tooLarge ? PAYEE_FILE_MESSAGES.too_large : "");
    if (!chosen || tooLarge) letGo();
    else setFile(chosen);
  }

  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <Field id="payee-invoice-number" label="Invoice number" error={error("invoiceNumber")}>
        <Input name="invoiceNumber" required maxLength={PAYEE_INVOICE_NUMBER_MAX} autoComplete="off" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="payee-invoice-amount" label="Amount (USDC)" error={error("amount")}>
          <Input name="amount" required inputMode="decimal" autoComplete="off" placeholder="1250.00" />
        </Field>
        <Field id="payee-invoice-due" label="Due date" error={error("dueDate")}>
          <Input name="dueDate" type="date" required min={today} max={lastDay} />
        </Field>
      </div>
      <Field id="payee-invoice-note" label="Note" optional error={error("note")}>
        <Textarea name="note" rows={3} maxLength={PAYEE_INVOICE_NOTE_MAX} />
      </Field>
      <div className="grid gap-2">
        <FileInput
          id="payee-invoice-file"
          name="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          label="Attach the invoice (optional)"
          description={INVOICE_FILE_LINE}
          inputRef={inputRef}
          onFile={choose}
        />
        {file && (
          <div className="flex items-center gap-2 text-sm text-ink-2">
            <FileText aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{file.name}</span>
            <Button type="button" variant="link" icon={<X />} onClick={letGo}>
              Remove file
            </Button>
          </div>
        )}
      </div>
      <div className="grid gap-2">
        <p className="text-xs leading-5 text-ink-3">
          {orgName} checks your invoice before adding it. Nothing is paid because you sent it, and this link sends one invoice.
        </p>
        <FormMessage tone={fileProblem || state.message ? "error" : "neutral"}>{fileProblem || state.message || null}</FormMessage>
      </div>
      <SubmitButton pendingLabel="Sending…" icon={<Send />}>
        Send my invoice
      </SubmitButton>
    </form>
  );
}
