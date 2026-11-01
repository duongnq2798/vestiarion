import { Field } from "@/components/ui/Field";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { splitCurrency, type DecimalMark } from "@/lib/bill-import/amounts";
import { billRows, columnLetter, FIELD_LABELS, REQUIRED_FIELDS, sampleValues, type ImportField } from "@/lib/bill-import/columns";
import { DATE_ORDERS, readDate, type DateOrder, type DateOrderQuestion } from "@/lib/bill-import/dates";
import type { Table } from "@/lib/bill-import/table";

/**
 * What the bill import (docs/superpowers/specs/2026-10-10-import-wizard-design.md), the free bill list check
 * (docs/superpowers/specs/2026-10-28-check-bills-design.md CB2, CB3) and the free payout batch check
 * (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP2) share in their steps: the trail of steps, a field's
 * column, the questions about a list's dates and amounts in its own words, a check run once the page has shown it is
 * busy, and saving a list made in the browser. One copy, so a change to how a list is asked about reaches each.
 */

/**
 * The steps a list goes through, the current one marked. It can take the focus from code, so a page that swaps one step
 * for the next moves the focus to it rather than to the page (CB2).
 */
export function StepTrail<Step extends string>({ steps, step, label }: { steps: ReadonlyArray<readonly [Step, string]>; step: Step; label: string }) {
  const at = steps.findIndex(([key]) => key === step);
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
      {steps.map(([key, name], index) => (
        <li
          key={key}
          aria-current={index === at ? "step" : undefined}
          tabIndex={index === at ? -1 : undefined}
          className={index === at ? "font-semibold text-ink outline-hidden" : undefined}
        >
          {index + 1}. {name}
        </li>
      ))}
    </ol>
  );
}

/** Saves text as a CSV file, made in the browser. */
export function download(text: string, file: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** How long a check waits for a frame before it runs anyway: a tab in the background draws none (CB2). */
const FRAME_WAIT_MS = 100;

/**
 * Runs `work` once the page has painted what changed before it: the browser draws a frame, then the work holds it. A
 * tab in the background draws no frames, so `work` also runs after FRAME_WAIT_MS without one. It runs once either way.
 */
export function afterPaint(work: () => void) {
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    work();
  };
  requestAnimationFrame(() => setTimeout(once, 0));
  setTimeout(once, FRAME_WAIT_MS);
}

const NONE = "none";

/**
 * A column, chosen among the list's by letter and name or none, with the values it reads; `noun` names what holds the
 * columns, "list" or "batch". Long values, such as addresses and payment links, break anywhere rather than widen the
 * page: the field's one track is as wide as its column, not as its longest value (payout check CP2).
 */
export function ColumnChoice({
  id,
  label,
  optional,
  table,
  hasHeader,
  names,
  column,
  onChoose,
  noun = "list",
}: {
  id: string;
  label: string;
  optional: boolean;
  table: Table;
  hasHeader: boolean;
  names: readonly string[];
  column: number | undefined;
  onChoose: (column: number | undefined) => void;
  noun?: string;
}) {
  const samples = column === undefined ? [] : sampleValues(table, hasHeader, column);
  return (
    <Field
      id={id}
      label={label}
      optional={optional}
      description={column === undefined ? `Not in the ${noun}.` : samples.length > 0 ? `Reads: ${samples.join(" · ")}` : "This column is empty."}
      className="min-w-0 grid-cols-1 [overflow-wrap:anywhere]"
    >
      <Select value={column === undefined ? NONE : String(column)} onValueChange={(value) => onChoose(value === NONE ? undefined : Number(value))}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{`Not in the ${noun}`}</SelectItem>
          {names.map((name, index) => (
            <SelectItem key={index} value={String(index)}>
              {columnLetter(index)} · {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A bill field's column, chosen among the list's by letter and name or none, with the values it reads. */
export function ColumnField({
  field,
  ...props
}: {
  id: string;
  field: ImportField;
  table: Table;
  hasHeader: boolean;
  names: readonly string[];
  column: number | undefined;
  onChoose: (column: number | undefined) => void;
}) {
  return <ColumnChoice {...props} label={FIELD_LABELS[field]} optional={!REQUIRED_FIELDS.includes(field)} />;
}

/** Each way a list can write its dates, offered when the list's dates can be in it. */
const DATE_ORDER_OPTIONS: ReadonlyArray<{ value: DateOrder; label: string }> = [
  { value: "dmy", label: "Day first (15/10/2026)" },
  { value: "mdy", label: "Month first (10/15/2026)" },
  { value: "ymd", label: "Year first (26/10/15)" },
];

/** The first value of a column that reads as a date two ways, to ask about in the list's own words. */
export function twoWayDate(table: Table, hasHeader: boolean, column: number | undefined): string | null {
  if (column === undefined) return null;
  for (const row of billRows(table, hasHeader)) {
    const cell = row.cells[column] ?? "";
    const read = readDate(cell, null);
    if (!read.ok && read.reason.startsWith("could be read")) return cell;
  }
  return null;
}

/** The first value of a column that reads as an amount two ways: 1,234 or 1.234. */
export function twoWayAmount(table: Table, hasHeader: boolean, column: number | undefined): string | null {
  if (column === undefined) return null;
  for (const row of billRows(table, hasHeader)) {
    if (/^\d{1,3}[.,]\d{3}$/.test(splitCurrency(row.cells[column] ?? "").number)) return row.cells[column];
  }
  return null;
}

/** Day first or month first, asked only when the list's dates can be read more than one way, with one of its own dates. */
export function DatesQuestion({
  question,
  table,
  hasHeader,
  dueColumn,
  value,
  onChange,
}: {
  question: DateOrderQuestion;
  table: Table;
  hasHeader: boolean;
  dueColumn: number | undefined;
  value: DateOrder | null;
  onChange: (order: DateOrder | null) => void;
}) {
  if (!question.ask) return null;
  return (
    <RadioGroup
      legend={
        question.mixed
          ? `The list writes dates ${question.orders.length > 2 ? "more than one way" : "both ways"}. Which way is right?`
          : `Dates like ${twoWayDate(table, hasHeader, dueColumn) ?? "03/04/2026"} are written`
      }
      value={value !== null && question.orders.includes(value) ? value : ""}
      onValueChange={(chosen) => onChange(DATE_ORDERS.find((order) => order === chosen) ?? null)}
      options={DATE_ORDER_OPTIONS.filter((option) => question.orders.includes(option.value))}
    />
  );
}

/** How the list writes its amounts, asked only when one of them reads two ways, with that amount; `noun` as `ColumnChoice` takes it. */
export function AmountsQuestion({
  question,
  table,
  hasHeader,
  amountColumn,
  value,
  onChange,
  noun = "list",
}: {
  question: { ask: boolean; mixed: boolean };
  table: Table;
  hasHeader: boolean;
  amountColumn: number | undefined;
  value: DecimalMark | null;
  onChange: (mark: DecimalMark) => void;
  noun?: string;
}) {
  if (!question.ask) return null;
  return (
    <RadioGroup
      legend={question.mixed ? `The ${noun} writes amounts both ways. Which way is right?` : `Amounts like ${twoWayAmount(table, hasHeader, amountColumn) ?? "1,234"} are written`}
      value={value ?? ""}
      onValueChange={(chosen) => onChange(chosen === "," ? "," : ".")}
      options={[
        { value: ".", label: "1,234.50", description: "A dot before the cents." },
        { value: ",", label: "1.234,50", description: "A comma before the cents." },
      ]}
    />
  );
}
