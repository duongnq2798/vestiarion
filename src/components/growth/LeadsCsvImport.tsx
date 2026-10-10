"use client";

import { Eye, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { importLeadsCsvAction, previewLeadsCsvAction } from "@/app/admin/growth/actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { LEAD_CSV_HEADERS, LEADS_CSV_MAX_BYTES, LEADS_CSV_MAX_ROWS, type LeadPreviewRow } from "@/lib/growth/csv";
import { STAGE_WORDS } from "@/lib/growth/fields";

/**
 * Leads from a CSV, pasted or chosen (src/lib/growth/csv.ts): the server reads every row against the leads and
 * campaigns there are and shows each as it would be saved, a duplicate, or what is wrong with it, before anything is
 * written. Saving reads it again and adds only the new rows, each needing review. An existing lead is never changed.
 */

const STATUS: Record<LeadPreviewRow["status"], { word: string; tone: "proof" | "neutral" | "refused" }> = {
  new: { word: "New", tone: "proof" },
  duplicate: { word: "Duplicate", tone: "neutral" },
  invalid: { word: "Not read", tone: "refused" },
};

type Note = { tone: "neutral" | "error" | "success"; text: string } | null;

export function LeadsCsvImport() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const [rows, setRows] = useState<LeadPreviewRow[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [pending, startTransition] = useTransition();
  const fresh = rows.filter((row) => row.status === "new").length;

  function preview(csv: string) {
    setRows([]);
    setChecked(null);
    setNote(null);
    if (!csv.trim()) return;
    if (new Blob([csv]).size > LEADS_CSV_MAX_BYTES) {
      setNote({ tone: "error", text: "Paste or choose a CSV smaller than 1 MB." });
      return;
    }
    startTransition(async () => {
      const result = await previewLeadsCsvAction(csv);
      if (!result.ok || !result.rows) {
        setNote({ tone: "error", text: result.message });
        return;
      }
      setChecked(csv);
      setRows(result.rows);
    });
  }

  function chosen(file: File | undefined) {
    if (!file) return;
    if (file.size > LEADS_CSV_MAX_BYTES) {
      setNote({ tone: "error", text: "Paste or choose a CSV smaller than 1 MB." });
      return;
    }
    void file.text().then((csv) => {
      setText(csv);
      preview(csv);
    });
  }

  function save() {
    if (!checked) return;
    startTransition(async () => {
      const result = await importLeadsCsvAction(checked);
      setNote({ tone: result.ok ? "success" : "error", text: result.message });
      // What is left, read again: the rows just added now read as duplicates.
      const again = await previewLeadsCsvAction(checked);
      setRows(again.ok && again.rows ? again.rows : []);
      if (result.ok && fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <FileInput
        id="leads-csv-file"
        accept=".csv,text/csv"
        label="Choose a CSV file, or drop one here"
        description={`Up to ${LEADS_CSV_MAX_ROWS} leads and 1 MB. Nothing is saved until you check the preview.`}
        inputRef={fileRef}
        onFile={chosen}
      />
      <Field id="leads-csv-text" label="Or paste the CSV" description={
          <>
            The header, exactly these columns in any order: <code className="break-all">{LEAD_CSV_HEADERS.join(",")}</code>
          </>
        }
      >
        <Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-32 font-mono text-xs" spellCheck={false} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Eye />} loading={pending && !checked} disabled={!text.trim()} onClick={() => preview(text)}>
          Check rows
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
      {rows.length > 0 && (
        <div className="space-y-3">
          <Table label="Leads to import" containerClassName="max-h-96 overflow-auto rounded-xl border border-line" className="min-w-[36rem] text-xs">
            <TableHeader className="sticky top-0 z-10 bg-ground">
              <TableRow>
                <TableHead className="px-3 py-2">Row</TableHead>
                <TableHead className="px-3 py-2">Business</TableHead>
                <TableHead className="px-3 py-2">Saved as</TableHead>
                <TableHead className="px-3 py-2">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.line}>
                  <TableCell className="px-3 py-2 font-mono">{row.line}</TableCell>
                  <TableCell className="px-3 py-2">{row.status === "new" ? row.lead.business_name : row.businessName}</TableCell>
                  <TableCell className="px-3 py-2 text-ink-2">
                    {row.status === "new" && `${STAGE_WORDS[row.lead.stage]}, needs review · ${row.lead.dedupe_key}`}
                    {row.status === "duplicate" && `${row.dedupeKey}: ${row.why}`}
                    {row.status === "invalid" && (
                      <ul className="list-disc space-y-0.5 pl-4 text-refused">
                        {row.errors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
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
            <Button icon={<Upload />} loading={pending && checked !== null} disabled={fresh === 0} onClick={save}>
              {fresh === 0 ? "Nothing to add" : `Add ${fresh} ${fresh === 1 ? "lead" : "leads"} for review`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
