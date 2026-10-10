"use client";

import { ArrowLeft, Download, FileSearch, RotateCcw, Upload } from "lucide-react";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { checkBillListAction, importBillListAction, type BillCheckResult, type BillImportResult } from "@/app/actions/bill-import";
import { DocsLink } from "@/components/DocsLink";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { toast } from "@/components/ui/Toaster";
import { AGENT_EXPECTED_EVENT } from "@/lib/agent-activity";
import { currencyDigits, splitCurrency } from "@/lib/bill-import/amounts";
import { billRows, columnLetter, columnNames, detectMapping, FIELD_LABELS, IMPORT_FIELDS, REQUIRED_FIELDS, sampleValues, type ImportField } from "@/lib/bill-import/columns";
import { readDate } from "@/lib/bill-import/dates";
import {
  acceptedCurrencies,
  failedRowsCsv,
  questionsFor,
  startingSettings,
  unanswered,
  type ImportedFate,
  type ImportSettings,
  type ImportWorkspace,
  type RowFate,
} from "@/lib/bill-import/rows";
import { decodeList, readTable, TableError, type Table as ListTable } from "@/lib/bill-import/table";
import { INVOICE_CSV_TEMPLATE } from "@/lib/bill-import/template";

/**
 * A bill list imported in four steps (docs/superpowers/specs/2026-10-10-import-wizard-design.md): the list, as a file
 * or pasted rows; its columns, matched and confirmed, with what only the person can say; the check, every row's fate
 * from the server with nothing written; and the result. The rows that cannot be added go out as a CSV with the reason,
 * to come back fixed (I08).
 */

/** The largest file read, in bytes (B2). */
const MAX_FILE_BYTES = 1_000_000;

export interface BillImportActions {
  check: (orgSlug: string, text: string, settings: ImportSettings) => Promise<BillCheckResult>;
  importList: (orgSlug: string, text: string, settings: ImportSettings) => Promise<BillImportResult>;
}

const SERVER_ACTIONS: BillImportActions = { check: checkBillListAction, importList: importBillListAction };

/** The list as the panel holds it: its text, sent to the server as it is, and where it came from. */
export interface ImportList {
  text: string;
  source: string;
  table: ListTable;
  /** The file was not UTF-8: names may need it saved as UTF-8. */
  legacy: boolean;
}

type Step = "list" | "columns" | "check" | "done";

const STEPS: Array<[Step, string]> = [
  ["list", "Your list"],
  ["columns", "Columns"],
  ["check", "Check"],
  ["done", "Done"],
];

/**
 * An amount with its thousands grouped and, in a currency with cents, at least two decimals, exactly as read: no float
 * in between. 1250 USDC shows as 1,250.00; 120000 JPY as 120,000.
 */
export function grouped(amount: string, currency: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = currencyDigits(currency) === 0 ? fraction : fraction.padEnd(2, "0");
  return decimals ? `${withCommas}.${decimals}` : withCommas;
}

/** Saves text as a file in the browser. */
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The name the failed rows are saved under: the list's own name, said to be the rows that could not be added. */
export function failedRowsFileName(source: string): string {
  const base = source.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "bills";
  return `${base}-not-added.csv`;
}

function StepTrail({ step }: { step: Step }) {
  const at = STEPS.findIndex(([key]) => key === step);
  return (
    <ol aria-label="Import steps" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
      {STEPS.map(([key, label], index) => (
        <li key={key} aria-current={index === at ? "step" : undefined} className={index === at ? "font-semibold text-ink" : undefined}>
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

export function ListStep({ onList, error }: { onList: (text: string, source: string, legacy: boolean) => void; error: string }) {
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState("");

  async function chose(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setProblem("Choose a file of at most 1 MB.");
      return;
    }
    const { text, legacy } = decodeList(await file.arrayBuffer());
    onList(text, file.name, legacy);
  }

  return (
    <div className="space-y-4">
      <FileInput
        id="bill-list-file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        label="Choose a CSV file, or drop one here"
        description="Your own columns, dates and number format. Up to 200 bills and 1 MB. Nothing is added until you check the rows and confirm."
        onFile={(file) => void chose(file)}
      />
      <Field id="bill-list-paste" label="Or paste rows from Excel or Google Sheets" description="Copy the rows with their column names, then paste them here.">
        <Textarea name="pasted" rows={5} value={pasted} onChange={(event) => setPasted(event.target.value)} className="font-mono text-xs" />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FormMessage tone="error">{problem || error}</FormMessage>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={INVOICE_CSV_TEMPLATE} variant="link">
            Copy a CSV template
          </CopyButton>
          <Button type="button" variant="secondary" icon={<FileSearch />} disabled={pasted.trim() === ""} onClick={() => onList(pasted, "Pasted rows", false)}>
            Read the pasted rows
          </Button>
        </div>
      </div>
    </div>
  );
}

const NONE = "none";

/** The first value of a column that reads two ways, to ask about in the list's own words. */
function twoWayDate(list: ImportList, settings: ImportSettings): string | null {
  const column = settings.mapping.dueDate;
  if (column === undefined) return null;
  for (const row of billRows(list.table, settings.hasHeader)) {
    const cell = row.cells[column] ?? "";
    const read = readDate(cell, null);
    if (!read.ok && read.reason.startsWith("could be read two ways")) return cell;
  }
  return null;
}

function twoWayAmount(list: ImportList, settings: ImportSettings): string | null {
  const column = settings.mapping.amount;
  if (column === undefined) return null;
  for (const row of billRows(list.table, settings.hasHeader)) {
    const number = splitCurrency(row.cells[column] ?? "").number;
    if (/^\d{1,3}[.,]\d{3}$/.test(number)) return row.cells[column];
  }
  return null;
}

export function ColumnsStep({
  list,
  settings,
  workspace,
  onChange,
  onCheck,
  onRestart,
  pending,
  error,
}: {
  list: ImportList;
  settings: ImportSettings;
  workspace: ImportWorkspace;
  onChange: (settings: ImportSettings) => void;
  onCheck: () => void;
  onRestart: () => void;
  pending: boolean;
  error: string;
}) {
  const names = columnNames(list.table, settings.hasHeader);
  const questions = questionsFor(list.table, settings, workspace);
  const waiting = unanswered(questions, settings);
  const bills = questions.bills;
  const currencies = acceptedCurrencies(workspace);
  const set = (change: Partial<ImportSettings>) => onChange({ ...settings, ...change });
  const choose = (field: ImportField, value: string) => {
    const mapping = { ...settings.mapping };
    if (value === NONE) delete mapping[field];
    else mapping[field] = Number(value);
    set({ mapping });
  };
  // The fields the list has, and the ones a row needs, are shown; the rest wait folded, each one choice away.
  const shownFields = IMPORT_FIELDS.filter((field) => REQUIRED_FIELDS.includes(field) || settings.mapping[field] !== undefined);
  const foldedFields = IMPORT_FIELDS.filter((field) => !shownFields.includes(field));
  const fieldControl = (field: ImportField) => {
    const column = settings.mapping[field];
    const samples = column === undefined ? [] : sampleValues(list.table, settings.hasHeader, column);
    return (
      <Field
        key={field}
        id={`bill-column-${field}`}
        label={FIELD_LABELS[field]}
        optional={!REQUIRED_FIELDS.includes(field)}
        description={column === undefined ? "Not in the list." : samples.length > 0 ? `Reads: ${samples.join(" · ")}` : "This column is empty."}
      >
        <Select value={column === undefined ? NONE : String(column)} onValueChange={(value) => choose(field, value)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not in the list</SelectItem>
            {names.map((name, index) => (
              <SelectItem key={index} value={String(index)}>
                {columnLetter(index)} · {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  };
  const dateSample = questions.dateOrder.ask ? twoWayDate(list, settings) : null;
  const amountSample = questions.decimalMark.ask ? twoWayAmount(list, settings) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">{list.source}</span>: {bills} {bills === 1 ? "bill" : "bills"}, {names.length} {names.length === 1 ? "column" : "columns"}.
        </p>
        <Button type="button" variant="link" icon={<RotateCcw />} onClick={onRestart}>
          Choose another list
        </Button>
      </div>
      {list.legacy && (
        <Callout tone="held">
          This file is not saved as UTF-8. If names look wrong below, save it from Excel as &ldquo;CSV UTF-8&rdquo;, or paste the rows instead.
        </Callout>
      )}
      <Checkbox
        label="The first row holds column names"
        checked={settings.hasHeader}
        onCheckedChange={(checked) => {
          const hasHeader = checked === true;
          set({ hasHeader, mapping: hasHeader ? detectMapping(list.table.rows[0]?.cells ?? []) : {} });
        }}
      />
      <div>
        <p className="text-sm font-medium text-ink">Which column is which</p>
        <p className="mt-1 text-xs text-ink-3">Check each match, and change any that is wrong. Columns not chosen here are left out.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{shownFields.map(fieldControl)}</div>
      {foldedFields.length > 0 && (
        <Disclosure summary={`Not in the list: ${foldedFields.map((field) => FIELD_LABELS[field]).join(", ")}`}>
          <div className="grid gap-4 pt-1 sm:grid-cols-2">{foldedFields.map(fieldControl)}</div>
        </Disclosure>
      )}

      {questions.direction && (
        <RadioGroup
          legend="These rows are"
          value={settings.direction ?? ""}
          onValueChange={(value) => set({ direction: value === "receivable" ? "receivable" : "payable" })}
          options={[
            { value: "payable", label: "Bills to pay", description: "Payables: the agent decides when to pay each one." },
            { value: "receivable", label: "Invoices to collect", description: "Receivables: your clients pay them." },
          ]}
        />
      )}
      {questions.dateOrder.ask && (
        <RadioGroup
          legend={questions.dateOrder.mixed ? "The list writes dates both ways. Which way is right?" : `Dates like ${dateSample ?? "03/04/2026"} are written`}
          value={settings.dateOrder ?? ""}
          onValueChange={(value) => set({ dateOrder: value === "mdy" ? "mdy" : "dmy" })}
          options={[
            { value: "dmy", label: "Day first (15/10/2026)" },
            { value: "mdy", label: "Month first (10/15/2026)" },
          ]}
        />
      )}
      {questions.decimalMark.ask && (
        <RadioGroup
          legend={questions.decimalMark.mixed ? "The list writes amounts both ways. Which way is right?" : `Amounts like ${amountSample ?? "1,234"} are written`}
          value={settings.decimalMark ?? ""}
          onValueChange={(value) => set({ decimalMark: value === "," ? "," : "." })}
          options={[
            { value: ".", label: "1,234.50", description: "A dot before the cents." },
            { value: ",", label: "1.234,50", description: "A comma before the cents." },
          ]}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="bill-list-currency"
          label={questions.currencyColumn ? "Currency for rows that leave it blank" : "Currency of the bills"}
          description={
            workspace.shadowCurrency ? (
              <>
                A bill in {workspace.shadowCurrency} is paid in USDC at the day&apos;s rate.{" "}
                <a href="https://www.exchangerate-api.com" className="underline underline-offset-2" target="_blank" rel="noreferrer">
                  Rates By Exchange Rate API
                </a>
              </>
            ) : (
              "Vestiarion takes bills in USDC or EURC."
            )
          }
        >
          <Select value={settings.currency ?? undefined} onValueChange={(value) => set({ currency: value })}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a currency" />
            </SelectTrigger>
            <SelectContent>
              {currencies.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {!questions.goodsColumn && settings.direction !== "receivable" && (
        <Checkbox
          label="The goods or services on every bill were received"
          description="Tick it only if they all were. A bill without them waits until they are marked received."
          checked={settings.goodsReceived}
          onCheckedChange={(checked) => set({ goodsReceived: checked === true })}
        />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone={error ? "error" : "neutral"}>{error || waiting}</FormMessage>
        <Button type="button" icon={<FileSearch />} loading={pending} disabled={waiting !== null} onClick={onCheck} className="shrink-0">
          {`Check ${bills} ${bills === 1 ? "row" : "rows"}`}
        </Button>
      </div>
    </div>
  );
}

type ShownFate = RowFate | ImportedFate;

const FATE: Record<ShownFate["status"], { label: string; tone: "agent" | "proof" | "neutral" | "refused" }> = {
  add: { label: "To add", tone: "agent" },
  added: { label: "Added", tone: "proof" },
  duplicate: { label: "Already in Vestiarion", tone: "neutral" },
  error: { label: "Can't add", tone: "refused" },
};

/** Every row with its fate: what was read, and what happens to it, or why not. */
export function FateTable({ fates, label }: { fates: readonly ShownFate[]; label: string }) {
  return (
    <Table label={label} containerClassName="max-h-96 overflow-auto rounded-xl border border-line" className="min-w-[36rem] text-xs">
      <TableHeader className="sticky top-0 z-10 bg-ground">
        <TableRow>
          {["Row", "Bill", "Amount", "Result"].map((heading) => (
            <TableHead key={heading} className="px-3 py-2">
              {heading}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {fates.map((fate) => (
          <TableRow key={fate.line}>
            <TableCell className="px-3 py-2 align-top font-mono text-ink-3">{fate.line}</TableCell>
            <TableCell className="max-w-48 px-3 py-2 align-top">
              <span className="block truncate font-medium">{fate.counterparty || "—"}</span>
              <span className="block truncate text-ink-3">{[fate.reference, fate.dueDate ? `due ${fate.dueDate}` : null].filter(Boolean).join(" · ") || "—"}</span>
            </TableCell>
            <TableCell className="px-3 py-2 align-top">
              <span className="block whitespace-nowrap font-mono">{fate.amount && fate.currency ? `${grouped(fate.amount, fate.currency)} ${fate.currency}` : "—"}</span>
              {fate.usdc && <span className="block text-ink-3">{`${grouped(fate.usdc, "USDC")} USDC at the day's rate`}</span>}
            </TableCell>
            <TableCell className="min-w-48 px-3 py-2 align-top">
              <Badge tone={FATE[fate.status].tone} size="sm" dot>
                {FATE[fate.status].label}
              </Badge>
              {"reason" in fate && <span className="mt-1 block text-ink-2">{fate.reason}</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Counts({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

export function CheckStep({
  check,
  onBack,
  onImport,
  onDownload,
  pending,
  error,
}: {
  check: Required<Pick<BillCheckResult, "fates" | "counts">>;
  onBack: () => void;
  onImport: () => void;
  onDownload: () => void;
  pending: boolean;
  error: string;
}) {
  const { counts, fates } = check;
  return (
    <div className="space-y-4">
      <Counts>
        <Badge tone="agent">{`To add: ${counts.add}`}</Badge>
        <Badge tone="neutral">{`Already in Vestiarion: ${counts.duplicate}`}</Badge>
        <Badge tone={counts.error > 0 ? "refused" : "neutral"}>{`Can't add: ${counts.error}`}</Badge>
      </Counts>
      <p className="text-xs text-ink-3">Nothing has been added yet. A row already in Vestiarion is never added again, so importing the same list twice adds its bills once.</p>
      <FateTable fates={fates} label="Rows checked" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" icon={<ArrowLeft />} onClick={onBack} disabled={pending}>
            Change columns
          </Button>
          {counts.error > 0 && (
            <Button type="button" variant="link" icon={<Download />} onClick={onDownload}>
              Download the rows that can&apos;t be added
            </Button>
          )}
        </div>
        <Button type="button" icon={<Upload />} loading={pending} disabled={counts.add === 0} onClick={onImport} className="shrink-0">
          {counts.add === 0 ? "Nothing to add" : `Add ${counts.add} ${counts.add === 1 ? "bill" : "bills"}`}
        </Button>
      </div>
      <FormMessage tone="error">{error}</FormMessage>
    </div>
  );
}

export function DoneStep({ result, onDownload, onRestart }: { result: Required<Pick<BillImportResult, "fates" | "counts" | "message">>; onDownload: () => void; onRestart: () => void }) {
  const { counts } = result;
  return (
    <div className="space-y-4">
      <Callout tone={counts.error > 0 ? "held" : "proof"} role="status" title={result.message}>
        {counts.added > 0 ? "The agent usually decides on each payable within a minute. " : null}
        {counts.error > 0 ? "Download the rows that can't be added, fix them in your spreadsheet, and import that file: the rows already added stay as they are." : null}
      </Callout>
      <FateTable fates={result.fates} label="Rows imported" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {counts.error > 0 ? (
          <Button type="button" variant="link" icon={<Download />} onClick={onDownload}>
            Download the rows that can&apos;t be added
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" variant="secondary" icon={<RotateCcw />} onClick={onRestart}>
          Import another list
        </Button>
      </div>
    </div>
  );
}

export default function BillImport({
  orgSlug,
  workspace,
  actions = SERVER_ACTIONS,
}: {
  orgSlug: string;
  workspace: ImportWorkspace;
  /** The server's check and import; a stand-in on the design page. */
  actions?: BillImportActions;
}) {
  const [step, setStep] = useState<Step>("list");
  const [list, setList] = useState<ImportList | null>(null);
  const [settings, setSettings] = useState<ImportSettings | null>(null);
  const [check, setCheck] = useState<Required<Pick<BillCheckResult, "fates" | "counts">> | null>(null);
  const [result, setResult] = useState<Required<Pick<BillImportResult, "fates" | "counts" | "message">> | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const failedCsv = useMemo(() => {
    const fates = step === "done" ? result?.fates : check?.fates;
    return list && settings && fates ? failedRowsCsv(list.table, settings, fates) : "";
  }, [step, list, settings, check, result]);

  function restart() {
    setStep("list");
    setList(null);
    setSettings(null);
    setCheck(null);
    setResult(null);
    setError("");
  }

  function read(text: string, source: string, legacy: boolean) {
    setError("");
    try {
      const table = readTable(text);
      setList({ text, source, table, legacy });
      setSettings(startingSettings(table, workspace));
      setStep("columns");
    } catch (problem) {
      setError(problem instanceof TableError ? problem.message : "The list could not be read.");
    }
  }

  function runCheck() {
    if (!list || !settings) return;
    setError("");
    startTransition(async () => {
      const checked = await actions.check(orgSlug, list.text, settings);
      if (!checked.ok || !checked.fates || !checked.counts) {
        setError(checked.message);
        return;
      }
      setCheck({ fates: checked.fates, counts: checked.counts });
      setStep("check");
    });
  }

  function runImport() {
    if (!list || !settings) return;
    setError("");
    startTransition(async () => {
      const imported = await actions.importList(orgSlug, list.text, settings);
      if (!imported.ok || !imported.fates || !imported.counts) {
        setError(imported.message);
        return;
      }
      setResult({ fates: imported.fates, counts: imported.counts, message: imported.message });
      setStep("done");
      if (imported.counts.added > 0) {
        toast.success(imported.message);
        // The agent has payables to decide within seconds: the page watches it closely for a while.
        window.dispatchEvent(new Event(AGENT_EXPECTED_EVENT));
      }
    });
  }

  const saveFailed = () => {
    if (failedCsv && list) download(failedCsv, failedRowsFileName(list.source));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StepTrail step={step} />
        <DocsLink href="/docs/guides/import-bills" topic="importing a bill list" />
      </div>
      {step === "list" && <ListStep onList={read} error={error} />}
      {step === "columns" && list && settings && (
        <ColumnsStep
          list={list}
          settings={settings}
          workspace={workspace}
          onChange={(next) => {
            setError("");
            setSettings(next);
          }}
          onCheck={runCheck}
          onRestart={restart}
          pending={pending}
          error={error}
        />
      )}
      {step === "check" && check && (
        <CheckStep
          check={check}
          onBack={() => {
            setError("");
            setStep("columns");
          }}
          onImport={runImport}
          onDownload={saveFailed}
          pending={pending}
          error={error}
        />
      )}
      {step === "done" && result && <DoneStep result={result} onDownload={saveFailed} onRestart={restart} />}
    </div>
  );
}
