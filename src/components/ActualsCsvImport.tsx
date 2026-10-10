"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { importActualsCsvAction, previewActualsCsvAction } from "@/app/actions/actual-payments";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { METHOD_WORDS } from "@/lib/actual-payment-fields";
import { ACTUALS_CSV_MAX_BYTES, ACTUALS_CSV_MAX_ROWS, type PreviewRow } from "@/lib/actual-payments-csv";
import { billDigits } from "@/lib/bill-amount";

/**
 * What the business paid, from a CSV (docs/superpowers/specs/2026-10-10-actual-payments-design.md A6): the server reads
 * it against the workspace's payables and shows each row as it would be saved, or why it would not, before anything is
 * written. Saving reads it again and writes the matched rows that change something.
 */

const STATUS: Record<PreviewRow["status"], { word: string; tone: "proof" | "neutral" | "held" | "refused" }> = {
  new: { word: "New", tone: "proof" },
  correction: { word: "Corrects the record", tone: "neutral" },
  same: { word: "Same as recorded", tone: "neutral" },
  unmatched: { word: "Not matched", tone: "held" },
  invalid: { word: "Not read", tone: "refused" },
};

type Note = { tone: "neutral" | "error"; text: string } | null;

export default function ActualsCsvImport({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [pending, startTransition] = useTransition();
  const toSave = rows.filter((row) => row.status === "new" || row.status === "correction").length;

  function preview(file: File | undefined) {
    setRows([]);
    setCsv(null);
    setNote(null);
    if (!file) return;
    if (file.size > ACTUALS_CSV_MAX_BYTES) {
      setNote({ tone: "error", text: "Choose a CSV smaller than 1 MB." });
      return;
    }
    startTransition(async () => {
      const text = await file.text();
      const result = await previewActualsCsvAction(orgSlug, text);
      if (!result.ok || !result.rows) {
        setNote({ tone: "error", text: result.message });
        return;
      }
      setCsv(text);
      setRows(result.rows);
    });
  }

  function save() {
    if (!csv) return;
    startTransition(async () => {
      const result = await importActualsCsvAction(orgSlug, csv);
      setNote({ tone: result.ok ? "neutral" : "error", text: result.message });
      // What is left, read again: a row someone recorded meanwhile, or one refused, shows where it stands now.
      const again = await previewActualsCsvAction(orgSlug, csv);
      setRows(again.ok && again.rows ? again.rows : []);
      if (result.ok && inputRef.current) inputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <FileInput
        id="actuals-csv"
        accept=".csv,text/csv"
        label="Choose a CSV file, or drop one here"
        description={`Columns: invoice (the Vestiarion invoice id, or the invoice number in the bill's memo), paid_date (YYYY-MM-DD), amount, and optionally currency, reference and method. Up to ${ACTUALS_CSV_MAX_ROWS} payments and 1 MB. Nothing is saved until you check the preview.`}
        inputRef={inputRef}
        onFile={preview}
      />
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
      {rows.length > 0 && (
        <div className="space-y-3">
          <Table label="Payments to save" containerClassName="max-h-80 overflow-auto rounded-xl border border-line" className="min-w-[40rem] text-xs">
            <TableHeader className="sticky top-0 z-10 bg-ground">
              <TableRow>
                <TableHead className="px-3 py-2">Row</TableHead>
                <TableHead className="px-3 py-2">Bill</TableHead>
                <TableHead className="px-3 py-2">Paid</TableHead>
                <TableHead className="px-3 py-2">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.line}>
                  <TableCell className="px-3 py-2 font-mono">{row.line}</TableCell>
                  <TableCell className="px-3 py-2">{"payee" in row ? row.payee : <span className="font-mono">{row.invoice}</span>}</TableCell>
                  <TableCell className="px-3 py-2">
                    {"record" in row ? (
                      <span className="tabular-nums">
                        {row.record.amount.toLocaleString("en-US", { minimumFractionDigits: billDigits(row.record.currency), maximumFractionDigits: billDigits(row.record.currency) })}{" "}
                        {row.record.currency} on {row.record.paidOn} · {METHOD_WORDS[row.record.method]}
                        {row.record.reference ? ` · ${row.record.reference}` : ""}
                      </span>
                    ) : (
                      <span className="text-ink-2">{row.why}</span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge size="sm" tone={STATUS[row.status].tone}>
                      {STATUS[row.status].word}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex justify-end">
            <Button icon={<Upload />} loading={pending} disabled={toSave === 0} onClick={save}>
              {toSave === 0 ? "Nothing to save" : `Save ${toSave} ${toSave === 1 ? "payment" : "payments"}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
