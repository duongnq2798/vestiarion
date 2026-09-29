"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { importInvoicesAction, type IntakeActionResult } from "@/app/actions/intake";
import { CopyButton } from "@/components/ui/CopyButton";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { useActionForm } from "@/components/ui/useActionForm";
import { INVOICE_CSV_TEMPLATE, parseInvoiceCsv, type InvoiceCsvRow } from "@/lib/invoice-csv";
import { csvInvoiceInputSchema, firstZodMessage } from "@/lib/intake-validation";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const HEADINGS = ["Direction", "Counterparty", "Amount", "Memo", "PO", "Received", "Due"];

/**
 * A CSV of invoices, previewed and checked row by row in the browser before
 * anything is sent. Nothing is imported until the preview is confirmed.
 */
export default function InvoiceCsvImport({ orgSlug }: { orgSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<InvoiceCsvRow[]>([]);
  const [previewError, setPreviewError] = useState("");
  const { state, formProps } = useActionForm(importInvoicesAction, INITIAL, {
    toastOnSuccess: true,
    onSuccess: () => {
      setRows([]);
      if (inputRef.current) inputRef.current.value = "";
    },
  });
  // A new file makes the last import's error stale: it is hidden until the next import says something new.
  const [dismissed, setDismissed] = useState<IntakeActionResult | null>(null);
  const actionError = !state.ok && state !== dismissed ? state.message : "";

  async function preview(file: File | undefined) {
    setRows([]);
    setPreviewError("");
    setDismissed(state);
    if (!file) return;
    if (file.size > 1_000_000) {
      setPreviewError("CSV must be smaller than 1 MB.");
      return;
    }
    try {
      const parsedRows = parseInvoiceCsv(await file.text());
      if (parsedRows.length > 200) throw new Error("Import at most 200 invoices at a time");
      parsedRows.forEach((row, index) => {
        const validated = csvInvoiceInputSchema.safeParse(row);
        if (!validated.success) throw new Error(`Row ${index + 1}: ${firstZodMessage(validated.error)}`);
      });
      setRows(parsedRows);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "CSV could not be read.");
    }
  }

  return (
    <div className="space-y-4">
      <FileInput
        id="invoice-csv"
        accept=".csv,text/csv"
        label="Choose a CSV file, or drop one here"
        description="Up to 200 invoices and 1 MB. Nothing is uploaded until you inspect the preview and confirm."
        inputRef={inputRef}
        onFile={(file) => void preview(file)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FormMessage tone="error">{previewError || actionError}</FormMessage>
        <CopyButton value={INVOICE_CSV_TEMPLATE} variant="link">
          Copy CSV template
        </CopyButton>
      </div>

      {rows.length > 0 && (
        <form {...formProps} className="space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="rowsJson" value={JSON.stringify(rows)} />
          <Table label="Invoices to import" containerClassName="max-h-72 overflow-auto rounded-xl border border-line" className="min-w-[48rem] text-xs">
            <TableHeader className="sticky top-0 z-10 bg-ground">
              <TableRow>
                {HEADINGS.map((heading) => (
                  <TableHead key={heading} className="px-3 py-2">
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={`${row.counterparty}-${index}`}>
                  <TableCell className="px-3 py-2">{row.direction}</TableCell>
                  <TableCell className="px-3 py-2 font-medium">{row.counterparty}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.amount}</TableCell>
                  <TableCell className="max-w-48 truncate px-3 py-2">{row.memo || "—"}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.po_reference || "—"}</TableCell>
                  <TableCell className="px-3 py-2">{row.goods_received || "false"}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.due_date}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex justify-end">
            <SubmitButton icon={<Upload />} pendingLabel="Importing…">
              {`Confirm ${rows.length} invoice${rows.length === 1 ? "" : "s"}`}
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
