"use client";

import { Search, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { importStatementAction, previewStatementAction } from "@/app/actions/bank-statement";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { ROLE_WORDS, ROLES, type ColumnMapping, type Role } from "@/lib/bank-statement/columns";
import { ACCOUNT_MAX, readStatement, STATEMENT_MAX_BYTES, type BalanceCheck, type StatementChoices, type StatementLine, type StatementRead } from "@/lib/bank-statement/lines";
import { minorText, type Candidate, type LineMatch } from "@/lib/bank-statement/match";
import { DELIMITER_WORDS, DELIMITERS, type Delimiter } from "@/lib/bank-statement/table";
import type { DateOrder } from "@/lib/bank-statement/values";
import { billDigits } from "@/lib/bill-amount";
import { plural, utcDay } from "@/lib/copy";

/**
 * Fill in what the business paid from its bank statement (docs/superpowers/specs/2026-10-10-bank-statement-design.md
 * B1-B8, B12). The browser reads the statement as the person maps it, and shows at once the lines read, the period and
 * the statement's own balance check; it asks the date order or the decimal mark when the file allows two readings. The
 * server then reads the same text with the same choices, matches the money-out lines to the bills, and saves only the
 * lines the person ticks, each checked again.
 *
 * `StatementReadPanel` and `StatementMatches` take what they show as props, so a guide's screenshot renders each alone.
 */

const NONE = "none";
const ORDER_WORDS: Record<DateOrder, string> = { ymd: "Year first", dmy: "Day first", mdy: "Month first" };
const day = (date: string) => utcDay(`${date.slice(0, 10)}T00:00:00Z`);

type Source = { text: string; name: string };
type Note = { tone: "success" | "error"; text: string } | null;
/** What the server read and matched: each line of the statement, and its match, in the same order. */
export type Found = { lines: StatementLine[]; matches: LineMatch[] };
/** The bill each ticked line paid, by the line of the file. */
type Ticks = Record<number, string>;

/** Where the card starts: empty, or, for a test, a statement read with its choices and its matches. */
export interface StatementStart {
  text: string;
  name: string;
  account?: string;
  choices?: StatementChoices;
  found?: Found;
}

/** The lines ticked from the start: each exact match that is the line's and the bill's single best (B8). */
export function defaultTicks(matches: readonly LineMatch[]): Ticks {
  return Object.fromEntries(matches.flatMap((match) => (match.status === "matched" && match.ticked ? [[match.line, match.candidate.invoiceId]] : [])));
}

function withTick(ticks: Ticks, line: number, invoiceId: string | null): Ticks {
  const next = { ...ticks };
  if (invoiceId) next[line] = invoiceId;
  else delete next[line];
  return next;
}

function readOrError(source: Source | null, choices: StatementChoices, today: string): { read: StatementRead | null; error: string | null } {
  if (!source) return { read: null, error: null };
  try {
    return { read: readStatement(source.text, choices, today), error: null };
  } catch (error) {
    return { read: null, error: error instanceof Error ? error.message : "That statement could not be read." };
  }
}

/** The statement against its own running balance (B5): the bank's figures for the account, never the agent's money. */
function BalanceCallout({ check }: { check: BalanceCheck }) {
  const money = (minor: number) => minorText(minor, check.currency);
  const figures = `Opening balance ${money(check.opening)}, money out ${money(check.out)}, money in ${money(check.in)}, closing balance ${money(check.closing)}.`;
  const order = check.newestFirst ? " Listed newest first, it is checked from the oldest line." : "";
  if (check.status === "adds_up") {
    return (
      <Callout tone="proof" title={`The statement's balance adds up, in ${check.currency}`}>
        <span className="tabular-nums">{figures}</span>
        {order}
      </Callout>
    );
  }
  if (check.status === "reversed") {
    return (
      <Callout tone="held" title={`The statement's balance adds up only with money in and money out swapped, in ${check.currency}`}>
        Money in and money out are read the wrong way round. Check the columns, or how the amount column writes money out.
      </Callout>
    );
  }
  const at = check.mismatch!;
  return (
    <Callout tone="held" title={`The statement's balance does not add up at line ${at.line}, in ${check.currency}`}>
      <span className="tabular-nums">
        After line {at.line} the balance should be {money(at.expected)}; the statement says {money(at.found)}. {figures}
      </span>
      {order} A statement cut from a longer one can start mid-day: you can still match its lines.
    </Callout>
  );
}

/**
 * How the statement is read (B2-B5): the separator, the header row and each column, as found or chosen; the questions
 * the file leaves open; what stops it being read; then the lines read, the period, the rows not read and the balance
 * check; and Find the bills. Without `onChoose` the choices show but do not change, as in a guide's screenshot.
 */
export function StatementReadPanel({
  name,
  read,
  choices,
  onChoose,
  findBlocked = null,
  finding = false,
  busy = false,
  onFind,
}: {
  name: string;
  read: StatementRead;
  choices: StatementChoices;
  onChoose?: (change: Partial<StatementChoices>) => void;
  /** Why the bills cannot be found yet, such as an account not named; null when they can. */
  findBlocked?: string | null;
  finding?: boolean;
  busy?: boolean;
  onFind?: () => void;
}) {
  const choose = (change: Partial<StatementChoices>) => onChoose?.(change);
  const open = read.problems.length === 0 && read.questions.length === 0;
  const ready = open && read.lines.length > 0;

  const columnSelect = (role: Role) => {
    const value = read.columns[role];
    return (
      <Field key={role} id={`statement-column-${role}`} label={ROLE_WORDS[role]}>
        <Select value={value === null ? NONE : String(value)} onValueChange={(next) => choose({ columns: { ...read.columns, [role]: next === NONE ? null : Number(next) } as ColumnMapping })}>
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not in this statement</SelectItem>
            {read.headers.map((header, index) => (
              <SelectItem key={index} value={String(index)}>
                {header}
                {read.example[index] ? ` (${read.example[index].slice(0, 24)})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  };

  return (
    <div className="space-y-4 rounded-xl border border-line p-4">
      <p className="text-sm font-medium text-ink">How {name} is read</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="statement-delimiter" label="Separator">
          <Select value={read.delimiter} onValueChange={(next) => choose({ delimiter: DELIMITERS.find((item) => item === next) as Delimiter, headerRow: null, columns: null })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELIMITERS.map((item) => (
                <SelectItem key={item} value={item}>
                  {DELIMITER_WORDS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="statement-header" label="Header row">
          <Select value={String(read.headerRow)} onValueChange={(next) => choose({ headerRow: Number(next), columns: null })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-1">No header row</SelectItem>
              {read.firstRecords.map((record, index) => (
                <SelectItem key={record.line} value={String(index)}>
                  Line {record.line}: {record.cells.filter(Boolean).join(", ").slice(0, 48)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map(columnSelect)}
        {read.needsCurrency && (
          <Field id="statement-currency" label="Currency of the account" description="Three letters, such as SGD or EUR, or USDC or EURC.">
            <Input value={choices.currency ?? ""} maxLength={4} size="sm" className="uppercase" onChange={(event) => choose({ currency: event.target.value })} />
          </Field>
        )}
      </div>
      {read.columns.amount !== null && (
        <RadioGroup
          legend="In the amount column, money out is written"
          value={read.outIs}
          onValueChange={(next) => choose({ outIs: next === "positive" ? "positive" : "negative" })}
          options={[
            { value: "negative", label: "As a negative amount, such as -120.00" },
            { value: "positive", label: "As a positive amount, such as 120.00" },
          ]}
        />
      )}
      {read.questions.map((question) =>
        question.kind === "dateOrder" ? (
          <RadioGroup
            key="dateOrder"
            legend={`How are the dates written? ${question.example} reads two ways.`}
            value={choices.dateOrder ?? ""}
            onValueChange={(next) => choose({ dateOrder: question.readings.find((reading) => reading.order === next)?.order ?? null })}
            options={question.readings.map((reading) => ({ value: reading.order, label: `${ORDER_WORDS[reading.order]}: ${question.example} is ${day(reading.day)}` }))}
          />
        ) : (
          <RadioGroup
            key="decimalMark"
            legend={`Is ${question.example} a whole number in thousands, or a number with decimals?`}
            value={choices.decimalMark ?? ""}
            onValueChange={(next) => choose({ decimalMark: next === "," ? "," : "." })}
            options={(question.example.includes(",") ? [".", ","] : [",", "."]).map((mark, index) => ({
              value: mark,
              label: index === 0 ? `Thousands: the ${mark === "." ? "comma" : "dot"} groups them` : `Decimals: the ${mark === "," ? "comma" : "dot"} is the decimal mark`,
            }))}
          />
        )
      )}
      {read.problems.length > 0 && (
        <Callout tone="held" title="Before the lines can be read">
          <ul className="list-disc space-y-0.5 pl-4">
            {read.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Callout>
      )}
      {open && read.period && (
        <p className="text-sm text-ink-2">
          <span className="tabular-nums">{read.lines.length}</span> {plural(read.lines.length, "line", "lines")} read, from {day(read.period.from)} to {day(read.period.to)}:{" "}
          <span className="tabular-nums">{read.lines.filter((line) => line.minor < 0).length}</span> money out,{" "}
          <span className="tabular-nums">{read.lines.filter((line) => line.minor > 0).length}</span> money in. Money in is never matched to bills.
        </p>
      )}
      {open && read.lines.length === 0 && <p className="text-sm text-ink-2">No line of the statement could be read. The rows not read say why.</p>}
      {open && read.skipped.length > 0 && (
        <Disclosure summary={`${read.skipped.length} ${plural(read.skipped.length, "row", "rows")} not read as lines`}>
          <ul className="space-y-0.5 text-xs text-ink-2">
            {read.skipped.map((row) => (
              <li key={row.line}>
                Line <span className="tabular-nums">{row.line}</span>: {row.why}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {ready && read.balances.length > 0 && (
        <div className="space-y-2">
          {read.balances.map((check) => (
            <BalanceCallout key={check.currency} check={check} />
          ))}
          <p className="text-xs text-ink-3">These are your bank statement&apos;s own figures for the account: the agent never counts or spends this money.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {findBlocked && <span className="text-xs text-ink-3">{findBlocked}</span>}
        <Button icon={<Search />} variant="secondary" loading={finding} disabled={!ready || findBlocked !== null || busy} onClick={onFind}>
          Find the bills
        </Button>
      </div>
    </div>
  );
}

function Why({ candidate }: { candidate: Candidate }) {
  return (
    <ul className="space-y-0.5 text-xs text-ink-3">
      {candidate.why.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

const billText = (candidate: Candidate) =>
  `${candidate.payee}, ${minorText(Math.round(candidate.bill.amount * 10 ** billDigits(candidate.bill.currency)), candidate.bill.currency)}${candidate.dueDate ? `, due ${day(candidate.dueDate)}` : ""}`;

/**
 * Each line of money out, the bill it paid and why, with a box to tick it for saving, and Save (B7, B8). The card holds
 * the ticks; alone, as in a guide's screenshot, it keeps its own, starting from the unique exact matches.
 */
export function StatementMatches({
  found,
  ticked,
  onTick,
  onSave,
  saving = false,
}: {
  found: Found;
  ticked?: Ticks;
  onTick?: (line: number, invoiceId: string | null) => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const [own, setOwn] = useState<Ticks>(() => defaultTicks(found.matches));
  const ticks = ticked ?? own;
  const tick = onTick ?? ((line: number, invoiceId: string | null) => setOwn((current) => withTick(current, line, invoiceId)));
  const outLines = found.lines.flatMap((line, index) => (line.minor < 0 ? [{ line, match: found.matches[index] }] : []));
  const moneyIn = found.lines.filter((line) => line.minor > 0).length;
  const chosenBills = new Set(Object.values(ticks));
  const toSave = Object.keys(ticks).length;
  return (
    <div className="space-y-3">
      {outLines.length === 0 ? (
        <p className="text-sm text-ink-2">No line of money out to match.</p>
      ) : (
        <Table label="Statement lines and the bills they paid" containerClassName="max-h-[48rem] overflow-auto rounded-xl border border-line" className="min-w-[40rem] text-xs">
          <TableHeader className="sticky top-0 z-10 bg-ground">
            <TableRow>
              <TableHead className="px-3 py-2">Save</TableHead>
              <TableHead className="px-3 py-2">Line</TableHead>
              <TableHead className="px-3 py-2">Paid</TableHead>
              <TableHead className="px-3 py-2">Bill</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outLines.map(({ line, match }) => {
              const choice = ticks[line.line];
              return (
                <TableRow key={line.line}>
                  <TableCell className="px-3 py-2 align-top">
                    {(match.status === "matched" || match.status === "choose") && (
                      <Checkbox
                        label={<span className="sr-only">Save line {line.line}</span>}
                        checked={choice !== undefined}
                        // A line with bills to choose from is ticked by choosing one.
                        disabled={match.status === "choose" && choice === undefined}
                        onCheckedChange={(checked) => tick(line.line, checked === true && match.status === "matched" ? match.candidate.invoiceId : null)}
                      />
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top">
                    <p className="font-mono tabular-nums">{line.line}</p>
                    {line.lookalike && (
                      <Badge size="sm" tone="neutral">
                        Looks the same as another line
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top">
                    <p className="tabular-nums text-ink">
                      {minorText(-line.minor, line.currency)} on {day(line.bookedOn)}
                    </p>
                    <p className="text-ink-2">{[line.description, line.payee, line.reference].filter(Boolean).join(" · ")}</p>
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top">
                    {match.status === "matched" && (
                      <div className="space-y-1">
                        <p className="flex flex-wrap items-center gap-2 tabular-nums text-ink">
                          {billText(match.candidate)}
                          {!match.candidate.exact && (
                            <Badge size="sm" tone="held">
                              Amount differs
                            </Badge>
                          )}
                        </p>
                        <Why candidate={match.candidate} />
                      </div>
                    )}
                    {match.status === "choose" && (
                      <div className="space-y-1">
                        <Badge size="sm" tone="held">
                          Choose the bill
                        </Badge>
                        <Select value={choice ?? ""} onValueChange={(next) => tick(line.line, next)}>
                          <SelectTrigger size="sm" aria-label={`The bill line ${line.line} paid`}>
                            <SelectValue placeholder="Choose the bill" />
                          </SelectTrigger>
                          <SelectContent>
                            {match.candidates.map((candidate) => (
                              <SelectItem key={candidate.invoiceId} value={candidate.invoiceId} disabled={chosenBills.has(candidate.invoiceId) && choice !== candidate.invoiceId}>
                                {billText(candidate)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {choice && <Why candidate={match.candidates.find((candidate) => candidate.invoiceId === choice)!} />}
                      </div>
                    )}
                    {match.status === "used" && (
                      <p className="text-ink-2">
                        <Badge size="sm" tone="neutral">
                          Already used
                        </Badge>{" "}
                        for {match.payee}
                      </p>
                    )}
                    {match.status === "recorded" && (
                      <p className="text-ink-2">
                        <Badge size="sm" tone="neutral">
                          Already recorded
                        </Badge>{" "}
                        for {match.payee}
                      </p>
                    )}
                    {match.status === "none" && <p className="text-ink-3">No bill matches</p>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {moneyIn > 0 && (
        <p className="text-xs text-ink-3">
          <span className="tabular-nums">{moneyIn}</span> {plural(moneyIn, "line of money in is", "lines of money in are")} not matched: receivables are not part of this import.
        </p>
      )}
      <div className="flex justify-end">
        <Button icon={<Upload />} loading={saving} disabled={toSave === 0} onClick={onSave}>
          {toSave === 0 ? "Nothing ticked" : `Save ${toSave} ${toSave === 1 ? "payment" : "payments"}`}
        </Button>
      </div>
    </div>
  );
}

export default function BankStatementImport({ orgSlug, accounts, initial }: { orgSlug: string; accounts: string[]; initial?: StatementStart }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [account, setAccount] = useState(initial?.account ?? accounts[0] ?? "");
  const [source, setSource] = useState<Source | null>(initial ? { text: initial.text, name: initial.name } : null);
  const [pasted, setPasted] = useState("");
  const [choices, setChoices] = useState<StatementChoices>(initial?.choices ?? {});
  const [found, setFound] = useState<Found | null>(initial?.found ?? null);
  const [ticked, setTicked] = useState<Ticks>(initial?.found ? defaultTicks(initial.found.matches) : {});
  const [note, setNote] = useState<Note>(null);
  const [pending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);
  const { read, error } = useMemo(() => readOrError(source, choices, today), [source, choices, today]);

  // Any change to what is read, or to the account, sets the matches aside: they are found again.
  const forget = () => {
    setFound(null);
    setTicked({});
  };
  const choose = (change: Partial<StatementChoices>) => {
    setChoices((current) => ({ ...current, ...change }));
    forget();
  };
  const nameAccount = (name: string) => {
    setAccount(name);
    forget();
  };
  const start = (next: Source | null) => {
    setSource(next);
    setChoices({});
    forget();
    setNote(null);
  };

  function chooseFile(file: File | undefined) {
    if (!file) return start(null);
    if (file.size > STATEMENT_MAX_BYTES) {
      start(null);
      setNote({ tone: "error", text: "Choose a statement smaller than 2 MB." });
      return;
    }
    void file.text().then((text) => start({ text, name: file.name }));
  }

  const named = account.trim() !== "" && account.trim().length <= ACCOUNT_MAX;

  function find() {
    if (!source || !read) return;
    startTransition(async () => {
      setNote(null);
      const result = await previewStatementAction(orgSlug, { account, text: source.text, choices });
      if (!result.ok || !result.lines || !result.matches) {
        setNote({ tone: "error", text: result.message });
        return;
      }
      setFound({ lines: result.lines, matches: result.matches });
      setTicked(defaultTicks(result.matches));
    });
  }

  function save() {
    if (!source) return;
    const pairs = Object.entries(ticked).map(([line, invoiceId]) => ({ line: Number(line), invoiceId }));
    startTransition(async () => {
      const result = await importStatementAction(orgSlug, { account, text: source.text, choices, pairs });
      const reasons = result.notSaved.map((line) => `Line ${line.line}: ${line.why}`).join(" ");
      setNote({ tone: result.ok ? "success" : "error", text: [result.message, reasons].filter(Boolean).join(" ") });
      // What is left, read again: the lines saved now read as already used.
      const again = await previewStatementAction(orgSlug, { account, text: source.text, choices });
      setFound(again.ok && again.lines && again.matches ? { lines: again.lines, matches: again.matches } : null);
      setTicked({});
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Field id="statement-account" label="Account" description="The bank account the statement is from, as you name it. A line saved once is known again by its account.">
        <Input value={account} maxLength={ACCOUNT_MAX} onChange={(event) => nameAccount(event.target.value)} placeholder="DBS operating" />
      </Field>
      {accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>Named before:</span>
          {accounts.slice(0, 6).map((name) => (
            <Button key={name} size="sm" variant="ghost" onClick={() => nameAccount(name)}>
              {name}
            </Button>
          ))}
        </div>
      )}
      <FileInput
        id="statement-csv"
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        label="Choose a statement CSV, or drop one here"
        description="Your bank's CSV export of the account, up to 2,000 lines and 2 MB. Nothing is saved until you tick the lines."
        inputRef={inputRef}
        onFile={chooseFile}
      />
      <Disclosure summary="Or paste the cells from a spreadsheet">
        <div className="space-y-2">
          <Field id="statement-paste" label="Cells, header row included">
            <Textarea rows={5} value={pasted} onChange={(event) => setPasted(event.target.value)} className="font-mono text-xs" />
          </Field>
          <Button size="sm" variant="secondary" disabled={pasted.trim() === ""} onClick={() => start({ text: pasted, name: "Pasted cells" })}>
            Read the pasted cells
          </Button>
        </div>
      </Disclosure>
      <FormMessage tone={error ? "error" : (note?.tone ?? "neutral")}>{error ?? note?.text}</FormMessage>

      {read && source && (
        <StatementReadPanel
          name={source.name}
          read={read}
          choices={choices}
          onChoose={choose}
          findBlocked={named ? null : "Name the account first."}
          finding={pending && !found}
          busy={pending}
          onFind={find}
        />
      )}

      {found && <StatementMatches found={found} ticked={ticked} onTick={(line, invoiceId) => setTicked((current) => withTick(current, line, invoiceId))} onSave={save} saving={pending} />}
    </div>
  );
}
