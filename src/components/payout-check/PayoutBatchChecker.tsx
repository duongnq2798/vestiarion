"use client";

import { Download, FileSearch, OctagonX, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { afterPaint, AmountsQuestion, ColumnChoice, download, StepTrail } from "@/components/intake/list-steps";
import { PayoutCheckResults, PayoutCheckSummary } from "@/components/payout-check/PayoutCheckResults";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { KNOWN_MAX, readKnownAddresses, type KnownAddresses, type SanctionedEntry } from "@/lib/address-check";
import { columnNames } from "@/lib/bill-import/columns";
import { decodeList, TableError } from "@/lib/bill-import/table";
import { plural } from "@/lib/copy";
import { checkedPayoutCsv, checkedPayoutFileName } from "@/lib/payout-check/csv";
import { checkPayouts, type PayoutCheck } from "@/lib/payout-check/findings";
import {
  detectPayoutColumns,
  PAYOUT_FIELD_LABELS,
  PAYOUT_FIELDS,
  PAYOUT_FILE_MAX_BYTES,
  PAYOUT_ROWS_MAX,
  payoutQuestions,
  readPayoutBatch,
  startingPayoutAnswers,
  unansweredPayout,
  type PayoutAnswers,
  type PayoutBatch,
  type PayoutField,
} from "@/lib/payout-check/read";
import { SAMPLE_PAYOUT_FILE, SAMPLE_PAYOUT_SOURCE, samplePayoutBatch } from "@/lib/payout-check/sample";

/**
 * The free payout batch check (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP2, CP5, CP9-CP11, CP13): a
 * batch, as a file or pasted rows; its columns, found by their names or by what the rows hold, and confirmed, with the
 * addresses the person has paid before; and what the check found. Everything is read and checked in this page: there is
 * no form, and nothing the person gives it is sent anywhere or kept. Each new step takes the focus the pressed button
 * had, and the check shows it is working before a batch of thousands holds the page, as the bill list check does.
 */

type Step = "batch" | "columns" | "results";

const STEPS: Array<[Step, string]> = [
  ["batch", "Your batch"],
  ["columns", "Columns"],
  ["results", "What it found"],
];

/** The batch as the page holds it: read into rows, and where it came from. */
interface GivenBatch {
  source: string;
  table: PayoutBatch;
  /** The file was not UTF-8: names may need it saved as UTF-8. */
  legacy: boolean;
  sample: boolean;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${plural(n, one, many)}`;

/** 16 px on a phone, so the browser does not zoom into the field; smaller beside a keyboard and mouse. */
const MONO_FIELD = "font-mono text-base sm:text-xs";

function BatchStep({ onBatch, error }: { onBatch: (text: string, source: string, legacy: boolean, sample: boolean) => void; error: string }) {
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState("");

  async function chose(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (file.size > PAYOUT_FILE_MAX_BYTES) {
      setProblem("Choose a file of at most 2 MB.");
      return;
    }
    const { text, legacy } = decodeList(await file.arrayBuffer());
    onBatch(text, file.name, legacy, false);
  }

  return (
    <div className="space-y-4">
      <FileInput
        id="check-payouts-file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        label="Choose a CSV file, or drop one here"
        description={`A Safe CSV Airdrop file, a Disperse list, an exchange's batch withdrawal file or a sheet saved as CSV. Up to ${PAYOUT_ROWS_MAX.toLocaleString("en-US")} rows and 2 MB.`}
        onFile={(file) => void chose(file)}
      />
      <Field
        id="check-payouts-paste"
        label="Or paste rows from a sheet, or a Disperse list"
        description="Copy the rows with their column names. In a Disperse list, each line is an address and an amount."
      >
        <Textarea
          rows={5}
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder={"0x… 250\n0x… 1200.50"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={MONO_FIELD}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FormMessage tone="error">{problem || error}</FormMessage>
        <Button type="button" variant="secondary" icon={<FileSearch />} disabled={pasted.trim() === ""} onClick={() => onBatch(pasted, "Pasted rows", false, false)}>
          Read the pasted rows
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <p className="text-sm text-ink-2">No batch to hand? Try one with made-up payees.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => onBatch(samplePayoutBatch(), SAMPLE_PAYOUT_SOURCE, false, true)}>
          Try an example
        </Button>
        <Button type="button" variant="link" icon={<Download />} onClick={() => download(samplePayoutBatch(), SAMPLE_PAYOUT_FILE)}>
          Download the example
        </Button>
      </div>
    </div>
  );
}

/** The addresses someone has paid before (CP5), as the address checker reads them, and what was read of them. */
function KnownBox({ text, onText, known }: { text: string; onText: (text: string) => void; known: KnownAddresses }) {
  return (
    <div className="space-y-3">
      <Field
        id="check-payouts-known"
        optional
        label="Addresses you have paid before"
        description={`One a line, with its name, such as Northwind Design, 0x…. Up to ${KNOWN_MAX}. Copy them from your own records or past invoices, not from your wallet's recent activity, where a poisoned address hides.`}
      >
        <Textarea
          rows={3}
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder={"Northwind Design, 0x…"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={MONO_FIELD}
        />
      </Field>
      <div className="space-y-1.5 text-sm text-ink-2">
        <p>
          {known.known.length > 0
            ? `Read ${count(known.known.length, "address", "addresses")}: each row is compared with ${plural(known.known.length, "it", "them")} too.${known.more ? ` Only the first ${KNOWN_MAX} are read.` : ""}`
            : "Without them, the batch is compared only with itself."}
        </p>
        {known.unread.map((line) => (
          <p key={line.line} className="flex gap-2">
            <OctagonX aria-hidden className="mt-0.5 size-4 shrink-0 text-refused" />
            <span className="min-w-0 break-words">
              Line {line.line} was not read. {line.message}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ColumnsStep({
  batch,
  answers,
  onChange,
  knownText,
  onKnownText,
  known,
  onCheck,
  onRestart,
  checking,
}: {
  batch: GivenBatch;
  answers: PayoutAnswers;
  onChange: (answers: PayoutAnswers) => void;
  knownText: string;
  onKnownText: (text: string) => void;
  known: KnownAddresses;
  onCheck: () => void;
  onRestart: () => void;
  /** The check is running: a batch of thousands takes a moment. */
  checking: boolean;
}) {
  const { table } = batch;
  const names = columnNames(table, answers.hasHeader);
  // Reads every row, up to 5,000: once for each answer, not again for a render that changes none.
  const questions = useMemo(() => payoutQuestions(table, answers), [table, answers]);
  const waiting = unansweredPayout(questions, answers);
  const set = (change: Partial<PayoutAnswers>) => onChange({ ...answers, ...change });
  const choose = (field: PayoutField, column: number | undefined) => {
    const columns = { ...answers.columns };
    if (column === undefined) delete columns[field];
    else columns[field] = column;
    set({ columns });
  };
  // The address, which the check needs, and the fields the batch has are shown; the rest wait folded, each one choice away.
  const shownFields = PAYOUT_FIELDS.filter((field) => field === "address" || answers.columns[field] !== undefined);
  const foldedFields = PAYOUT_FIELDS.filter((field) => !shownFields.includes(field));
  const fieldControl = (field: PayoutField) => (
    <ColumnChoice
      key={field}
      id={`check-payouts-column-${field}`}
      label={PAYOUT_FIELD_LABELS[field]}
      optional={field !== "address"}
      table={table}
      hasHeader={answers.hasHeader}
      names={names}
      column={answers.columns[field]}
      onChoose={(column) => choose(field, column)}
      noun="batch"
    />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm text-ink-2">
          <span className="font-semibold text-ink">{batch.source}</span>: {count(questions.rows + questions.leftOut, "row", "rows")}, {count(names.length, "column", "columns")}.
        </p>
        <Button type="button" variant="link" icon={<RotateCcw />} disabled={checking} onClick={onRestart}>
          Choose another batch
        </Button>
      </div>
      {batch.sample && <Callout>Example data: made-up payees paid in USDC on Base, in Safe&apos;s CSV Airdrop form with a name column added. One address is on OFAC&apos;s list, to show that finding.</Callout>}
      {table.disperse && <Callout>Read as a Disperse list: an address and an amount on each line, with no column names.</Callout>}
      {batch.legacy && (
        <Callout tone="held">
          This file is not saved as UTF-8. If names look wrong below, save it from Excel as &ldquo;CSV UTF-8&rdquo;, or paste the rows instead.
        </Callout>
      )}
      {questions.leftOut > 0 && (
        <Callout tone="held">
          The check reads the first {PAYOUT_ROWS_MAX.toLocaleString("en-US")} rows, so it stays fast. The other {count(questions.leftOut, "row is", "rows are")} left out:
          check them as a second batch.
        </Callout>
      )}
      <Checkbox
        label="The first row holds column names"
        checked={answers.hasHeader}
        onCheckedChange={(checked) => {
          const hasHeader = checked === true;
          set({ hasHeader, columns: detectPayoutColumns(table, hasHeader) });
        }}
      />
      <div>
        <p className="text-sm font-medium text-ink">Which column is which</p>
        <p className="mt-1 text-xs text-ink-3">Check each match, and change any that is wrong. Columns not chosen here are not checked, and come back as they are.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{shownFields.map(fieldControl)}</div>
      {foldedFields.length > 0 && (
        <Disclosure summary={`Not in the batch: ${foldedFields.map((field) => PAYOUT_FIELD_LABELS[field]).join(", ")}`}>
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">{foldedFields.map(fieldControl)}</div>
        </Disclosure>
      )}
      <AmountsQuestion
        question={questions.decimalMark}
        table={table}
        hasHeader={answers.hasHeader}
        amountColumn={answers.columns.amount}
        value={answers.decimalMark}
        onChange={(decimalMark) => set({ decimalMark })}
        noun="batch"
      />
      <KnownBox text={knownText} onText={onKnownText} known={known} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage>{waiting}</FormMessage>
        <Button type="button" icon={<FileSearch />} loading={checking} disabled={waiting !== null} onClick={onCheck} className="shrink-0">
          {`Check ${count(questions.rows, "row", "rows")}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * The checker, given OFAC's EVM addresses as the address checker is (CP3) and the list's date, which every result says
 * (CP1). The addresses paid before are kept while another batch is read, never past the page.
 */
export function PayoutBatchChecker({ sanctioned, listDate }: { sanctioned: readonly SanctionedEntry[]; listDate: string }) {
  const [step, setStep] = useState<Step>("batch");
  const [batch, setBatch] = useState<GivenBatch | null>(null);
  const [answers, setAnswers] = useState<PayoutAnswers | null>(null);
  const [knownText, setKnownText] = useState("");
  const [result, setResult] = useState<PayoutCheck | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const known = useMemo(() => readKnownAddresses(knownText), [knownText]);
  const checker = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // The button pressed goes with its step: the new step's place in the trail takes the focus, not the page (CP2).
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    checker.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus();
  }, [step]);

  function go(next: Step) {
    moved.current = true;
    setStep(next);
  }

  function restart() {
    go("batch");
    setBatch(null);
    setAnswers(null);
    setResult(null);
    setError("");
  }

  function read(text: string, source: string, legacy: boolean, sample: boolean) {
    setError("");
    try {
      const table = readPayoutBatch(text);
      setBatch({ source, table, legacy, sample });
      setAnswers(startingPayoutAnswers(table));
      go("columns");
    } catch (problem) {
      setError(problem instanceof TableError ? problem.message : "The batch could not be read.");
    }
  }

  function check() {
    if (!batch || !answers) return;
    setChecking(true);
    // A batch of thousands holds the page for a moment: the button shows it is checking first (CP2).
    afterPaint(() => {
      setResult(checkPayouts(batch.table, answers, { sanctioned, known: known.known }));
      setChecking(false);
      go("results");
    });
  }

  return (
    <div ref={checker} className="space-y-5">
      <StepTrail steps={STEPS} step={step} label="Check steps" />
      {step === "batch" && <BatchStep onBatch={read} error={error} />}
      {step === "columns" && batch && answers && (
        <ColumnsStep
          batch={batch}
          answers={answers}
          onChange={setAnswers}
          knownText={knownText}
          onKnownText={setKnownText}
          known={known}
          onCheck={check}
          onRestart={restart}
          checking={checking}
        />
      )}
      {/* Only the summary and its counts are announced when the check runs, not every finding under them. */}
      <div aria-live="polite" data-results>
        {step === "results" && result && <PayoutCheckSummary result={result} listDate={listDate} />}
      </div>
      {step === "results" && batch && answers && result && (
        <PayoutCheckResults
          result={result}
          onBack={() => go("columns")}
          onRestart={restart}
          onDownload={() => download(checkedPayoutCsv(batch.table, answers, result), checkedPayoutFileName(batch.source))}
        />
      )}
    </div>
  );
}
