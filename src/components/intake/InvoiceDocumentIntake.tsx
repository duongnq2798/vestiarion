"use client";

import { FileText, ScanText, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { readInvoiceDocumentAction, type DocumentReadResult } from "@/app/actions/invoice-document";
import InvoiceIntake, { ADD_COUNTERPARTY_PATH, type IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";

const INITIAL: DocumentReadResult = { ok: false, message: "" };

/** The largest file sent, in bytes: the server refuses more, and a request much larger never reaches it (review I4). */
const MAX_FILE_BYTES = 4_000_000;

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

/** Why a chosen file is not sent, checked in the browser, or null when it may be. */
export function documentFileProblem(file: { size: number }): string | null {
  return file.size > MAX_FILE_BYTES ? "Choose a file of at most 4 MB." : null;
}

/**
 * An invoice read from a document, in the usual invoice form for a member to
 * check and add (invoice from a document D7). Nothing here is added until
 * **Add invoice**, which goes through the same action and checks as an
 * invoice typed in. A vendor that matches no counterparty is named, with the
 * way to add it: every invoice is against a counterparty.
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
  /** Runs once the invoice is added: the tab hides this draft. */
  onAdded?: () => void;
}) {
  const { draft, document } = result;
  if (!draft || !document) return null;
  // Vestiarion's own checks, then, apart and named as such, the model's note: it can be wrong.
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
    <div className="space-y-4">
      <Callout tone={issues.length > 0 ? "held" : "agent"}>
        <div className="space-y-2">
          <p>
            {result.message} Read by {READERS[result.reader ?? "heuristic"] ?? result.reader}.
          </p>
          {issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          {result.modelNote && <p className="text-ink-2 italic">The model noted: {result.modelNote}</p>}
        </div>
      </Callout>
      {!draft.counterpartyId && (
        <Callout tone="held" icon={<UserPlus />}>
          <p>
            {draft.vendorName ? `${draft.vendorName} is not one of your counterparties yet.` : "This invoice matches none of your counterparties."} Add it, then read the
            invoice again.
          </p>
          <Button asChild size="sm" variant="secondary" className="mt-2">
            <Link href={orgHref(orgSlug, ADD_COUNTERPARTY_PATH)}>Add a counterparty</Link>
          </Button>
        </Callout>
      )}
      <InvoiceIntake
        orgSlug={orgSlug}
        counterparties={counterparties}
        idPrefix="invoice-document-draft"
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
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState("");

  const letGo = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
  }, []);

  // A refusal about the file chosen lets it go, so the text pasted next is what gets read (review I3).
  const onResult = useCallback(
    (result: DocumentReadResult) => {
      if (!result.ok && result.clearFile) letGo();
    },
    [letGo]
  );
  const { state, formProps } = useActionForm(readInvoiceDocumentAction, INITIAL, { onResult });
  // The draft of the last read, until it is added.
  const [added, setAdded] = useState<number | null>(null);

  function choose(chosen: File | undefined) {
    const problem = chosen ? documentFileProblem(chosen) : null;
    setFileProblem(problem ?? "");
    if (!chosen || problem) letGo();
    else setFile(chosen);
  }

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
        <Field id="invoice-document-text" label="Or paste the invoice's text" optional>
          <Textarea name="text" rows={5} maxLength={20_000} />
        </Field>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{fileProblem || (state.ok ? null : state.message)}</FormMessage>
          <SubmitButton icon={<ScanText />} pendingLabel="Reading…" className="shrink-0">
            Read invoice
          </SubmitButton>
        </div>
      </form>
      {state.ok && state.nonce !== added && (
        <div className="border-t border-line pt-6">
          <DocumentDraft
            key={state.nonce}
            result={state}
            counterparties={counterparties}
            orgSlug={orgSlug}
            onAdded={() => {
              setAdded(state.nonce ?? null);
              letGo();
            }}
          />
        </div>
      )}
    </div>
  );
}
