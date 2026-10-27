"use client";

import { Download, FileSearch, RotateCcw } from "lucide-react";
import { useState } from "react";
import { BillCheckResults, BillCheckSummary } from "@/components/bill-check/BillCheckResults";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { checkedCsv, checkedFileName } from "@/lib/bill-check/csv";
import { checkBills, type BillCheck } from "@/lib/bill-check/findings";
import { CHECK_FIELDS, checkMapping, LIST_CURRENCIES, MAX_CHECK_BILLS, questionsOf, startingAnswers, unansweredOf, type CheckAnswers } from "@/lib/bill-check/read";
import { SAMPLE_SOURCE, sampleBillList } from "@/lib/bill-check/sample";
import { splitCurrency } from "@/lib/bill-import/amounts";
import { billRows, columnLetter, columnNames, FIELD_LABELS, REQUIRED_FIELDS, sampleValues, type ImportField } from "@/lib/bill-import/columns";
import { DATE_ORDERS, readDate, type DateOrder } from "@/lib/bill-import/dates";
import { decodeList, readTable, TableError, type Table } from "@/lib/bill-import/table";

/**
 * The free bill list check (docs/superpowers/specs/2026-10-28-check-bills-design.md CB2, CB3, CB9): a list, as a file or
 * pasted rows; its columns, matched as the bill import matches them and confirmed; and what the check found. Everything
 * is read and checked in this page: there is no form, and nothing the person gives it is sent anywhere or kept.
 */

/** The largest file read, in bytes: 5,000 bills of a wide export fit (CB2). */
const MAX_FILE_BYTES = 5_000_000;

type Step = "list" | "columns" | "results";

const STEPS: Array<[Step, string]> = [
  ["list", "Your list"],
  ["columns", "Columns"],
  ["results", "What it found"],
];

/** The list as the page holds it: read into rows, and where it came from. */
interface GivenList {
  source: string;
  table: Table;
  /** The file was not UTF-8: names may need it saved as UTF-8. */
  legacy: boolean;
  sample: boolean;
}

/** The person's own today, `YYYY-MM-DD`: the next 7 days are counted on their calendar. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Saves text as a file, made in the browser. */
function download(text: string, file: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function StepTrail({ step }: { step: Step }) {
  const at = STEPS.findIndex(([key]) => key === step);
  return (
    <ol aria-label="Check steps" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
      {STEPS.map(([key, label], index) => (
        <li key={key} aria-current={index === at ? "step" : undefined} className={index === at ? "font-semibold text-ink" : undefined}>
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function ListStep({ onList, error }: { onList: (text: string, source: string, legacy: boolean, sample: boolean) => void; error: string }) {
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState("");

  async function chose(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setProblem("Choose a file of at most 5 MB.");
      return;
    }
    const { text, legacy } = decodeList(await file.arrayBuffer());
    onList(text, file.name, legacy, false);
  }

  return (
    <div className="space-y-4">
      <FileInput
        id="check-bills-file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        label="Choose a CSV file, or drop one here"
        description="An export from QuickBooks, Xero or Zoho Books, or a sheet saved as CSV. Up to 5,000 bills and 5 MB."
        onFile={(file) => void chose(file)}
      />
      <Field id="check-bills-paste" label="Or paste rows from Excel or Google Sheets" description="Copy the rows with their column names, then paste them here.">
        <Textarea
          rows={5}
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // 16 px on a phone, so the browser does not zoom into it; smaller beside a keyboard and mouse.
          className="font-mono text-base sm:text-xs"
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FormMessage tone="error">{problem || error}</FormMessage>
        <Button type="button" variant="secondary" icon={<FileSearch />} disabled={pasted.trim() === ""} onClick={() => onList(pasted, "Pasted rows", false, false)}>
          Read the pasted rows
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <p className="text-sm text-ink-2">No list to hand? Try one with made-up vendors.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => onList(sampleBillList(localToday()), SAMPLE_SOURCE, false, true)}>
          Try the sample list
        </Button>
        <Button type="button" variant="link" icon={<Download />} onClick={() => download(sampleBillList(localToday()), "bill-list-sample.csv")}>
          Download the sample
        </Button>
      </div>
    </div>
  );
}

const NONE = "none";

/** Each way a list can write its dates, offered when the list's dates can be in it. */
const DATE_ORDER_OPTIONS: ReadonlyArray<{ value: DateOrder; label: string }> = [
  { value: "dmy", label: "Day first (15/10/2026)" },
  { value: "mdy", label: "Month first (10/15/2026)" },
  { value: "ymd", label: "Year first (26/10/15)" },
];

/** The first due date that reads two ways, to ask about in the list's own words. */
function twoWayDate(table: Table, answers: CheckAnswers): string | null {
  const column = answers.mapping.dueDate;
  if (column === undefined) return null;
  for (const row of billRows(table, answers.hasHeader)) {
    const cell = row.cells[column] ?? "";
    const read = readDate(cell, null);
    if (!read.ok && read.reason.startsWith("could be read")) return cell;
  }
  return null;
}

function twoWayAmount(table: Table, answers: CheckAnswers): string | null {
  const column = answers.mapping.amount;
  if (column === undefined) return null;
  for (const row of billRows(table, answers.hasHeader)) {
    if (/^\d{1,3}[.,]\d{3}$/.test(splitCurrency(row.cells[column] ?? "").number)) return row.cells[column];
  }
  return null;
}

function ColumnsStep({
  list,
  answers,
  onChange,
  onCheck,
  onRestart,
}: {
  list: GivenList;
  answers: CheckAnswers;
  onChange: (answers: CheckAnswers) => void;
  onCheck: () => void;
  onRestart: () => void;
}) {
  const names = columnNames(list.table, answers.hasHeader);
  const questions = questionsOf(list.table, answers);
  const waiting = unansweredOf(questions, answers);
  const set = (change: Partial<CheckAnswers>) => onChange({ ...answers, ...change });
  const choose = (field: ImportField, value: string) => {
    const mapping = { ...answers.mapping };
    if (value === NONE) delete mapping[field];
    else mapping[field] = Number(value);
    set({ mapping });
  };
  // The fields the list has, and the ones a bill needs, are shown; the rest wait folded, each one choice away.
  const shownFields = CHECK_FIELDS.filter((field) => REQUIRED_FIELDS.includes(field) || answers.mapping[field] !== undefined);
  const foldedFields = CHECK_FIELDS.filter((field) => !shownFields.includes(field));
  const fieldControl = (field: ImportField) => {
    const column = answers.mapping[field];
    const samples = column === undefined ? [] : sampleValues(list.table, answers.hasHeader, column);
    return (
      <Field
        key={field}
        id={`check-bills-column-${field}`}
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
            {names.map((heading, index) => (
              <SelectItem key={index} value={String(index)}>
                {columnLetter(index)} · {heading}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  };
  const bills = questions.bills;
  const dateSample = questions.dateOrder.ask ? twoWayDate(list.table, answers) : null;
  const amountSample = questions.decimalMark.ask ? twoWayAmount(list.table, answers) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">{list.source}</span>: {plural(bills + questions.leftOut, "bill", "bills")}, {plural(names.length, "column", "columns")}.
        </p>
        <Button type="button" variant="link" icon={<RotateCcw />} onClick={onRestart}>
          Choose another list
        </Button>
      </div>
      {list.sample && <Callout>Sample data: made-up vendors and amounts, dated from today.</Callout>}
      {list.legacy && (
        <Callout tone="held">
          This file is not saved as UTF-8. If names look wrong below, save it from Excel as &ldquo;CSV UTF-8&rdquo;, or paste the rows instead.
        </Callout>
      )}
      {questions.leftOut > 0 && (
        <Callout tone="held">
          The check reads the first {MAX_CHECK_BILLS.toLocaleString("en-US")} bills, so it stays fast. The other {plural(questions.leftOut, "bill is", "bills are")} left
          out: check them as a second list.
        </Callout>
      )}
      <Checkbox
        label="The first row holds column names"
        checked={answers.hasHeader}
        onCheckedChange={(checked) => {
          const hasHeader = checked === true;
          set({ hasHeader, mapping: hasHeader ? checkMapping(list.table.rows[0]?.cells ?? []) : {} });
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
      {questions.dateOrder.ask && (
        <RadioGroup
          legend={
            questions.dateOrder.mixed
              ? `The list writes dates ${questions.dateOrder.orders.length > 2 ? "more than one way" : "both ways"}. Which way is right?`
              : `Dates like ${dateSample ?? "03/04/2026"} are written`
          }
          value={answers.dateOrder !== null && questions.dateOrder.orders.includes(answers.dateOrder) ? answers.dateOrder : ""}
          onValueChange={(value) => set({ dateOrder: DATE_ORDERS.find((order) => order === value) ?? null })}
          options={DATE_ORDER_OPTIONS.filter((option) => questions.dateOrder.orders.includes(option.value))}
        />
      )}
      {questions.decimalMark.ask && (
        <RadioGroup
          legend={questions.decimalMark.mixed ? "The list writes amounts both ways. Which way is right?" : `Amounts like ${amountSample ?? "1,234"} are written`}
          value={answers.decimalMark ?? ""}
          onValueChange={(value) => set({ decimalMark: value === "," ? "," : "." })}
          options={[
            { value: ".", label: "1,234.50", description: "A dot before the cents." },
            { value: ",", label: "1.234,50", description: "A comma before the cents." },
          ]}
        />
      )}
      {questions.currency && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="check-bills-currency" label="Currency for rows that do not say" description="It labels amounts. Nothing is converted.">
            <Select value={answers.currency ?? undefined} onValueChange={(value) => set({ currency: value })}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a currency" />
              </SelectTrigger>
              <SelectContent>
                {LIST_CURRENCIES.map((currency) => (
                  <SelectItem key={currency} value={currency}>
                    {currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage>{waiting}</FormMessage>
        <Button type="button" icon={<FileSearch />} disabled={waiting !== null} onClick={onCheck} className="shrink-0">
          {`Check ${plural(bills, "bill", "bills")}`}
        </Button>
      </div>
    </div>
  );
}

export function BillListChecker() {
  const [step, setStep] = useState<Step>("list");
  const [list, setList] = useState<GivenList | null>(null);
  const [answers, setAnswers] = useState<CheckAnswers | null>(null);
  const [result, setResult] = useState<BillCheck | null>(null);
  const [error, setError] = useState("");

  function restart() {
    setStep("list");
    setList(null);
    setAnswers(null);
    setResult(null);
    setError("");
  }

  function read(text: string, source: string, legacy: boolean, sample: boolean) {
    setError("");
    try {
      const table = readTable(text);
      setList({ source, table, legacy, sample });
      setAnswers(startingAnswers(table));
      setStep("columns");
    } catch (problem) {
      setError(problem instanceof TableError ? problem.message : "The list could not be read.");
    }
  }

  function check() {
    if (!list || !answers) return;
    setResult(checkBills(list.table, answers, localToday()));
    setStep("results");
  }

  return (
    <div className="space-y-5">
      <StepTrail step={step} />
      {step === "list" && <ListStep onList={read} error={error} />}
      {step === "columns" && list && answers && <ColumnsStep list={list} answers={answers} onChange={setAnswers} onCheck={check} onRestart={restart} />}
      {/* Only the summary is announced when the check runs, not every finding under it. */}
      <div aria-live="polite" data-results>
        {step === "results" && result && <BillCheckSummary result={result} />}
      </div>
      {step === "results" && list && answers && result && (
        <BillCheckResults
          result={result}
          onBack={() => setStep("columns")}
          onRestart={restart}
          onDownload={() => download(checkedCsv(list.table, answers, result), checkedFileName(list.source))}
        />
      )}
    </div>
  );
}
