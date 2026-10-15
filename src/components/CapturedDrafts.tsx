"use client";

import { Trash2, UserPlus } from "lucide-react";
import Link from "next/link";
import { confirmInvoiceDraftAction, discardInvoiceDraftAction, type DraftActionResult } from "@/app/actions/invoice-drafts";
import InvoiceIntake, { ADD_COUNTERPARTY_PATH, type IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import { startingMemo } from "@/lib/invoice-drafts/model";
import type { CapturedDraftView } from "@/lib/invoice-drafts/store";

const INITIAL: DraftActionResult = { ok: false, message: "" };
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** "Oct 15, 09:40 UTC". */
function capturedOn(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${date.toISOString().slice(11, 16)} UTC`;
}

const SOURCE_WORDS: Record<string, string> = {
  pdf: "a PDF",
  email: "an email file",
  text: "a text file",
  image: "a picture",
};

function sourceWords(draft: CapturedDraftView): string {
  if (draft.source === "selection") return "text selected on a page";
  return draft.documentKind ? (SOURCE_WORDS[draft.documentKind] ?? "a file") : "a file";
}

function Discard({ orgSlug, draftId }: { orgSlug: string; draftId: string }) {
  const discard = useActionForm(discardInvoiceDraftAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...discard.formProps} className="space-y-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceDraftId" value={draftId} />
      <SubmitButton size="sm" variant="secondary" pendingLabel="Discarding…" icon={<Trash2 aria-hidden />}>
        Discard
      </SubmitButton>
      <FormMessage tone={!discard.state.ok && discard.state.message ? "error" : "neutral"}>{!discard.state.ok ? discard.state.message || null : null}</FormMessage>
    </form>
  );
}

function DraftCard({ orgSlug, draft, canAdd, counterparties, capturedBy }: { orgSlug: string; draft: CapturedDraftView; canAdd: boolean; counterparties: IntakeCounterparty[]; capturedBy: string | null }) {
  const { fields } = draft;
  const supplier = fields.supplierName;
  const matched = draft.counterpartyId && counterparties.some((counterparty) => counterparty.id === draft.counterpartyId) ? draft.counterpartyName : null;
  const addCounterparty = `${ADD_COUNTERPARTY_PATH}${supplier ? `&name=${encodeURIComponent(supplier)}` : ""}`;
  return (
    <Card className="space-y-3 p-4 sm:p-5" id={`captured-${draft.id}`}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">
          {supplier ?? "Supplier not read"}
          {fields.invoiceNumber ? ` · ${fields.invoiceNumber}` : ""}
        </p>
        <p className="text-xs text-ink-3">
          Captured from {sourceWords(draft)} with the Chrome extension{capturedBy ? ` by ${capturedBy}` : ""} · {capturedOn(draft.sentAt ?? draft.capturedAt)}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-3">Counterparty</dt>
        <dd className="text-ink">
          {matched ?? (
            <>
              {supplier ?? "not matched"} <span className="text-ink-3">· not in Counterparties</span>
            </>
          )}
        </dd>
        <dt className="text-ink-3">Amount</dt>
        <dd className="text-ink">{fields.amount ? `${AMOUNT.format(Number(fields.amount))} ${fields.currency ?? ""}`.trim() : "not read"}</dd>
        <dt className="text-ink-3">Invoice date</dt>
        <dd className="text-ink">{fields.invoiceDate ?? "not read"}</dd>
        <dt className="text-ink-3">Due</dt>
        <dd className="text-ink">{fields.dueDate ?? "not read"}</dd>
        <dt className="text-ink-3">Purchase order</dt>
        <dd className="text-ink">{fields.poReference ?? "none"}</dd>
        {fields.memo && (
          <>
            <dt className="text-ink-3">Memo</dt>
            <dd className="text-ink">{fields.memo}</dd>
          </>
        )}
      </dl>
      {draft.duplicates.length > 0 && (
        <div className="rounded-lg border border-refused/40 bg-refused/5 p-3 text-sm text-ink-2">
          <p className="font-medium text-refused">This may be a duplicate</p>
          <ul className="mt-1 list-disc pl-5">
            {draft.duplicates.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.warnings.map((warning) => (
        <p key={warning} className="text-xs text-refused">
          {warning}
        </p>
      ))}
      {draft.modelNote && <p className="text-xs italic text-ink-3">The model&apos;s note: {draft.modelNote}</p>}
      {draft.rawText && (
        <Disclosure summary="What was captured">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink-2">{draft.rawText}</pre>
          <p className="mt-2 text-xs text-ink-3">Kept until this draft is added or discarded, and at most 30 days.</p>
        </Disclosure>
      )}
      {canAdd ? (
        <>
          {!matched && (
            <p className="text-sm text-ink-2">
              <Link href={orgHref(orgSlug, addCounterparty)} className="inline-flex items-center gap-1 font-medium text-agent underline-offset-2 hover:underline">
                <UserPlus aria-hidden className="size-4" />
                Add {supplier ? `“${supplier}”` : "the supplier"} as a counterparty
              </Link>{" "}
              first if it is new, then choose it below.
            </p>
          )}
          <Disclosure summary="Review and add as bill">
            <InvoiceIntake
              orgSlug={orgSlug}
              counterparties={counterparties}
              invoiceDraftId={draft.id}
              action={confirmInvoiceDraftAction}
              idPrefix={`captured-${draft.id}`}
              submitLabel="Add as bill"
              duplicateCheck={draft.duplicates.length > 0}
              initial={{
                counterpartyId: matched ? draft.counterpartyId : null,
                amount: fields.amount,
                currency: fields.currency,
                dueDate: fields.dueDate,
                earlyPayDiscountPct: draft.extracted?.earlyPayDiscountPct ?? null,
                discountDeadline: draft.extracted?.discountDeadline ?? null,
                memo: startingMemo(fields.invoiceNumber, fields.memo),
                poReference: fields.poReference,
              }}
            />
          </Disclosure>
          <Discard orgSlug={orgSlug} draftId={draft.id} />
        </>
      ) : (
        <p className="text-xs text-ink-3">An owner or admin adds it as a bill, or discards it.</p>
      )}
    </Card>
  );
}

/**
 * The invoices captured with the Chrome extension and sent for review, on Bills & receivables
 * (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C5-C7): what was read, what it may repeat and the text
 * it came from; for an owner or admin, Review and add as bill (the invoice form, through the add-invoice command) and
 * Discard. Nothing here is added by itself. Renders nothing when nothing waits.
 */
export default function CapturedDrafts({
  orgSlug,
  drafts,
  canAdd,
  counterparties,
  members,
}: {
  orgSlug: string;
  drafts: CapturedDraftView[];
  canAdd: boolean;
  counterparties: IntakeCounterparty[];
  /** Each member's email by user id, to say who captured a draft. */
  members: Record<string, string>;
}) {
  if (drafts.length === 0) return null;
  return (
    <section aria-labelledby="captured-drafts-title" id="captured-drafts" className="mb-8">
      <SectionHeader id="captured-drafts-title" title="Captured drafts" meta={`${drafts.length} to review · captured with the Chrome extension`} />
      <div className="space-y-3">
        {drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            orgSlug={orgSlug}
            draft={draft}
            canAdd={canAdd}
            counterparties={counterparties}
            capturedBy={draft.capturedBy ? (members[draft.capturedBy] ?? null) : null}
          />
        ))}
      </div>
    </section>
  );
}
