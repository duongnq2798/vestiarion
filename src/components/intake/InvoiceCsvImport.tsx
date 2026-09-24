"use client";

import { type FormEvent, useRef, useState } from "react";
import { importInvoicesAction, type IntakeActionResult } from "@/app/actions/intake";
import { INVOICE_CSV_TEMPLATE, parseInvoiceCsv, type InvoiceCsvRow } from "@/lib/invoice-csv";
import { csvInvoiceInputSchema, firstZodMessage } from "@/lib/intake-validation";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

export default function InvoiceCsvImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<InvoiceCsvRow[]>([]);
  const [previewError, setPreviewError] = useState("");
  const [state, setState] = useState<IntakeActionResult>(INITIAL);
  const [pending, setPending] = useState(false);

  async function preview(file: File | undefined) {
    setRows([]);
    setPreviewError("");
    setState(INITIAL);
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

  async function confirmImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await importInvoicesAction(INITIAL, new FormData(event.currentTarget));
      setState(result);
      if (result.ok) {
        setRows([]);
        if (inputRef.current) inputRef.current.value = "";
      }
    } catch (error) {
      setState({ ok: false, message: error instanceof Error ? error.message : "Invoices could not be imported." });
    } finally {
      setPending(false);
    }
  }

  const feedback = previewError || state.message;
  const failed = Boolean(previewError || (state.message && !state.ok));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block text-sm font-medium text-ink">
          CSV file
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void preview(event.target.files?.[0])}
            className="mt-1.5 block w-full max-w-md text-sm text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-raised"
          />
        </label>
        <button type="button" onClick={() => void navigator.clipboard.writeText(INVOICE_CSV_TEMPLATE)} className="text-left text-xs text-agent hover:underline">
          Copy CSV template
        </button>
      </div>

      <p aria-live="polite" className={`text-sm ${failed ? "text-refused" : "text-ink-2"}`}>
        {feedback || "Nothing is uploaded until you inspect the preview and confirm."}
      </p>

      {rows.length > 0 && (
        <form onSubmit={confirmImport} className="space-y-3">
          <input type="hidden" name="rowsJson" value={JSON.stringify(rows)} />
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="sticky top-0 bg-raised text-ink-2">
                <tr>{["Direction", "Counterparty", "Amount", "Memo", "PO", "Received", "Due"].map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row, index) => (
                  <tr key={`${row.counterparty}-${index}`} className="bg-surface text-ink">
                    <td className="px-3 py-2">{row.direction}</td>
                    <td className="px-3 py-2 font-medium">{row.counterparty}</td>
                    <td className="px-3 py-2 font-mono">{row.amount}</td>
                    <td className="max-w-48 truncate px-3 py-2">{row.memo || "—"}</td>
                    <td className="px-3 py-2 font-mono">{row.po_reference || "—"}</td>
                    <td className="px-3 py-2">{row.goods_received || "false"}</td>
                    <td className="px-3 py-2 font-mono">{row.due_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button disabled={pending} className="h-10 rounded-md bg-agent px-4 text-sm font-semibold text-on-agent hover:bg-agent/90 disabled:opacity-60">
              {pending ? "Importing…" : `Confirm ${rows.length} invoice${rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
