"use client";

import { ScanText } from "lucide-react";
import { useRef, useState } from "react";
import { readInvoiceDocumentAction, type DocumentReadResult } from "@/app/actions/invoice-document";
import InvoiceIntake, { type IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import { Callout } from "@/components/ui/Callout";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: DocumentReadResult = { ok: false, message: "" };

const READERS: Record<string, string> = {
  deepseek: "DeepSeek",
  anthropic: "Claude",
  openai: "OpenAI",
  heuristic: "the rule-based reader",
};

const NOT_FOUND: Record<string, string> = {
  amount: "The amount the model gave is not in the document, so it was left blank.",
  poReference: "The purchase order the model gave is not in the document, so it was left blank.",
  payToAddress: "The pay-to address the model gave is not in the document, so it was ignored.",
};

/**
 * An invoice read from a document, in the usual invoice form for a member to
 * check and add (invoice from a document D7). Nothing here is added until
 * **Add invoice**, which goes through the same action and checks as an
 * invoice typed in.
 */
export function DocumentDraft({
  result,
  counterparties,
  orgSlug,
  onAdded,
}: {
  result: DocumentReadResult;
  counterparties: IntakeCounterparty[];
  orgSlug: string;
  onAdded: () => void;
}) {
  const { draft, document } = result;
  if (!draft || !document) return null;
  const issues = [...(result.warnings ?? []), ...(result.notFound ?? []).map((field) => NOT_FOUND[field])];
  const read = {
    amount: draft.amount,
    currency: draft.currency,
    dueDate: draft.dueDate,
    poReference: draft.poReference,
    earlyPayDiscountPct: draft.earlyPayDiscountPct,
    discountDeadline: draft.discountDeadline,
    memo: draft.memo,
    counterpartyId: draft.counterpartyId,
  };

  return (
    <div className="space-y-4 border-t border-line pt-6">
      <Callout tone={issues.length > 0 ? "held" : "agent"}>
        <div className="space-y-2">
          <p>
            {result.message} Read by {READERS[result.reader ?? "heuristic"] ?? result.reader}.
          </p>
          {issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </Callout>
      <InvoiceIntake
        orgSlug={orgSlug}
        counterparties={counterparties}
        initial={read}
        document={{ kind: document.kind, sha256: document.sha256, reader: result.reader ?? "heuristic", read: JSON.stringify(read) }}
        onAdded={onAdded}
      />
    </div>
  );
}

/** A PDF, an email or pasted text, read by the model into the invoice form (invoice from a document D1). */
export default function InvoiceDocumentIntake({ counterparties, orgSlug }: { counterparties: IntakeCounterparty[]; orgSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, formProps } = useActionForm(readInvoiceDocumentAction, INITIAL);
  // The draft of the last read, until it is added.
  const [added, setAdded] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <form {...formProps} className="space-y-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <FileInput
          id="invoice-document"
          name="file"
          accept=".pdf,.txt,.eml,application/pdf,text/plain,message/rfc822"
          label="Choose a PDF or email, or drop one here"
          description="Up to 4 MB. The model reads it into the form below; nothing is added until you check it and choose Add invoice."
          inputRef={inputRef}
          onFile={() => {}}
        />
        <Field id="invoice-document-text" label="Or paste the invoice's text" optional>
          <Textarea name="text" rows={5} maxLength={20_000} />
        </Field>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<ScanText />} pendingLabel="Reading…" className="shrink-0">
            Read invoice
          </SubmitButton>
        </div>
      </form>
      {state.ok && state.nonce !== added && (
        <DocumentDraft
          key={state.nonce}
          result={state}
          counterparties={counterparties}
          orgSlug={orgSlug}
          onAdded={() => {
            setAdded(state.nonce ?? null);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
      )}
    </div>
  );
}
