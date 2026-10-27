"use client";

import { CircleCheck, CirclePause, ExternalLink, FileSearch, OctagonX, RotateCcw } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { columnLetter, columnNames, sampleValues } from "@/lib/bill-import/columns";
import { decodeList, TableError, type Table } from "@/lib/bill-import/table";
import { plural } from "@/lib/copy";
import {
  detectVendorColumns,
  EXAMPLE_LIST,
  listWords,
  looksLikeVendorHeader,
  nameNotCompared,
  needsALook,
  readVendorList,
  VENDOR_FIELD_LABELS,
  VENDOR_FIELDS,
  VENDOR_FILE_MAX_BYTES,
  VENDOR_ROWS_MAX,
  vendorResultsCsv,
  vendorRowChecker,
  vendorRows,
  vendorSummary,
  walletWords,
  type VendorColumns,
  type VendorField,
  type VendorResult,
} from "@/lib/vendor-check/list";
import { matchName, nameWords, nonLatinWords, type CountryAgreement, type NameMatch } from "@/lib/vendor-check/match";
import { loadNameIndex } from "./load-index";

/**
 * The vendor check (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV6, CV7): one name, or a whole list,
 * checked against OFAC's SDN list in the browser. The list loads when the first check runs; there is no form, and
 * nothing typed or pasted goes into a request, the address bar or storage. A result is a reason to look closer or the
 * absence of one, never more.
 */

const TREASURY_ENTRY = "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=";
const LOAD_FAILED = "OFAC's list could not be loaded. Check your connection, then try again.";
/** Rows checked between two paints, so a long list shows how far it has got. */
const CHUNK = 250;
const OTHER_NAMES_SHOWN = 6;
const ADDRESSES_SHOWN = 4;
const NONE = "none";

const TYPE_WORDS: Record<NameMatch["entry"]["type"], string> = { entity: "Entity", individual: "Individual", vessel: "Vessel", aircraft: "Aircraft" };

/** Why a name matched an entry, in words (CV4). */
export function reasonWords(match: NameMatch): string {
  const lead = match.via === "name" ? "Matched its name" : `Matched another of its names, ${match.matched}`;
  if (match.spacing) return `${lead}: the same letters, spaced another way.`;
  const same = match.pairs.filter((pair) => pair.how === "same").map((pair) => pair.typed);
  const parts = same.length > 0 ? [`${listWords(same)} ${same.length === 1 ? "is the same word" : "are the same words"}`] : [];
  for (const pair of match.pairs.filter((each) => each.how === "alike")) parts.push(`${pair.typed} is spelled another way as ${pair.listed}`);
  for (const pair of match.pairs.filter((each) => each.how === "close")) parts.push(`${pair.typed} is close to ${pair.listed}`);
  const typedOnly = match.typedOnly.length > 0 ? ` Not in that name: ${match.typedOnly.join(", ")}.` : "";
  const listedOnly = match.listedOnly.length > 0 ? ` Only in that name: ${match.listedOnly.join(", ")}.` : "";
  const rare = match.rare ? " Every word typed is rare on the list, so it is a possible match at least." : "";
  return `${lead}: ${parts.join("; ")}.${typedOnly}${listedOnly}${rare}`;
}

/** What is said of a name with no word in Latin letters, which is not compared (CV2). */
const NOT_COMPARED = "Not compared: OFAC's SDN list writes every name in Latin letters.";

/** The words of a name left out for not being in Latin letters, when some of it was compared (CV2). */
function LeftOut({ words }: { words: readonly string[] }) {
  if (words.length === 0) return null;
  return <p className="break-words text-sm text-ink-2">Left out, as they are not in Latin letters: {words.join(" ")}.</p>;
}

function countryWords(country: CountryAgreement): string | null {
  if (country.kind === "agrees") return `The country agrees: ${country.country}.`;
  if (country.kind === "differs") return `The country differs: it lists ${listWords(country.listed)}.`;
  if (country.kind === "not_listed") return "It lists no country to compare.";
  return null;
}

/** A list cut to its first few, and how many more. */
function firstOf(values: readonly string[], shown: number): string {
  return values.length > shown ? `${values.slice(0, shown).join(", ")}, and ${values.length - shown} more` : values.join(", ");
}

function MatchCard({ match }: { match: NameMatch }) {
  const { entry } = match;
  const country = countryWords(match.country);
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold text-ink">{entry.name}</p>
        <Badge tone={match.band === "strong" ? "refused" : "held"} size="sm">
          {match.band === "strong" ? "Strong match" : "Possible match"}
        </Badge>
      </div>
      <p className="text-xs text-ink-3">
        {TYPE_WORDS[entry.type]} · {entry.programs.join(", ")} · Score {match.score.toFixed(2)}
      </p>
      <p className="text-sm leading-relaxed text-ink-2">{reasonWords(match)}</p>
      {country && <p className="text-sm text-ink-2">{country}</p>}
      {entry.otherNames.length > 0 && <p className="break-words text-xs leading-relaxed text-ink-3">Other names: {firstOf(entry.otherNames, OTHER_NAMES_SHOWN)}</p>}
      {entry.countries.length > 0 && <p className="text-xs text-ink-3">Countries it lists: {entry.countries.join(", ")}</p>}
      {entry.addresses.length > 0 && (
        <p className="break-all font-mono text-xs leading-relaxed text-ink-3">Digital-currency addresses: {firstOf(entry.addresses, ADDRESSES_SHOWN)}</p>
      )}
      <a
        href={`${TREASURY_ENTRY}${entry.number}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm font-medium text-agent underline-offset-4 hover:underline"
      >
        Check it on Treasury&apos;s search
        <ExternalLink aria-hidden className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </div>
  );
}

/** The headline for one name: strong, possible, none, or not compared, and the list's date (CV7). */
function NameHeadline({ typed, matches, compared, listDate }: { typed: string; matches: NameMatch[]; compared: boolean; listDate: string }) {
  if (!compared) {
    return (
      <Callout tone="held" title={NOT_COMPARED}>
        A name written in another script cannot match any of them. Write the vendor&apos;s name in Latin letters, as it is written in English, then
        check it again.
      </Callout>
    );
  }
  if (matches.length === 0) {
    return (
      <Callout title={`No match in OFAC's SDN list as of ${listDate}.`}>
        This checks OFAC&apos;s SDN list only. It is a first look, not a compliance decision.
      </Callout>
    );
  }
  const strong = matches[0].band === "strong";
  return (
    <Callout tone={strong ? "refused" : "held"} title={strong ? "Strong match: review it before you pay" : "Possible match: review it"}>
      &ldquo;{typed}&rdquo; is close to {plural(matches.length, "an entry", `${matches.length} entries`)} on OFAC&apos;s SDN list as of {listDate}. Compare the
      details below, and look the entry up on Treasury&apos;s search before you pay.
    </Callout>
  );
}

function WalletLine({ result }: { result: VendorResult }) {
  if (!result.wallet) return null;
  const { tone, text } = walletWords(result.wallet);
  const Icon = tone === "stop" ? OctagonX : tone === "note" ? CirclePause : CircleCheck;
  const color = tone === "stop" ? "text-refused" : tone === "note" ? "text-held" : "text-ink-3";
  return (
    <div className="space-y-1">
      <p className="break-all font-mono text-xs text-ink-3">{result.row.wallet}</p>
      <p className="flex gap-2 text-sm leading-relaxed text-ink-2">
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${color}`} />
        <span className="min-w-0 break-words">{text}</span>
      </p>
    </div>
  );
}

function RowCard({ result, listDate }: { result: VendorResult; listDate: string }) {
  const { row, matches } = result;
  const notCompared = nameNotCompared(result);
  return (
    <li className="space-y-3 rounded-2xl border border-line px-4 py-4">
      <p className="text-sm">
        <span className="font-semibold text-ink">{row.name || `Row ${row.line}`}</span>
        <span className="text-ink-3">
          {row.name ? ` · row ${row.line}` : ""}
          {row.country ? ` · ${row.country}` : ""}
        </span>
      </p>
      {notCompared && <p className="text-sm text-ink-2">{NOT_COMPARED}</p>}
      {matches && matches.length === 0 && !notCompared && <p className="text-sm text-ink-2">No match in OFAC&apos;s SDN list as of {listDate}.</p>}
      {!notCompared && <LeftOut words={result.notLatin} />}
      {matches?.map((match) => (
        <MatchCard key={match.entry.number} match={match} />
      ))}
      <WalletLine result={result} />
    </li>
  );
}

/** Saves text as a file in the browser, as the bill import saves its rows. */
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

interface ReadList {
  table: Table;
  source: string;
  legacy: boolean;
}

interface Checked {
  results: VendorResult[];
  more: number;
  header: string[];
}

export function VendorChecker({ listDate, listDay }: { listDate: string; listDay: string }) {
  const id = useId();
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [one, setOne] = useState<{ typed: string; matches: NameMatch[]; notLatin: string[]; compared: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");

  const [pasted, setPasted] = useState("");
  const [list, setList] = useState<ReadList | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState<VendorColumns>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [listProblem, setListProblem] = useState("");
  /** The list check under way: a newer list or check makes an older one stop. */
  const run = useRef(0);

  async function checkName() {
    const typed = name.trim();
    if (typed === "") return;
    setLoading(true);
    setProblem("");
    try {
      const index = await loadNameIndex();
      const notLatin = nonLatinWords(typed);
      setOne({ typed, matches: matchName(index, typed, country), notLatin, compared: notLatin.length === 0 || nameWords(typed).length > 0 });
    } catch {
      setProblem(LOAD_FAILED);
    } finally {
      setLoading(false);
    }
  }

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void checkName();
  };

  /** Drops a check of the list under way, and the results of the last one, when the list or its columns change. */
  function forget() {
    run.current += 1;
    setChecked(null);
    setProgress(null);
  }

  function readList(text: string, source: string, legacy: boolean) {
    forget();
    setListProblem("");
    try {
      const table = readVendorList(text);
      const header = looksLikeVendorHeader(table.rows[0].cells);
      setList({ table, source, legacy });
      setHasHeader(header);
      setColumns(detectVendorColumns(header ? table.rows[0].cells : [], header));
    } catch (error) {
      setList(null);
      setListProblem(error instanceof TableError ? error.message : "The list could not be read.");
    }
  }

  async function chose(file: File | undefined) {
    if (!file) return;
    if (file.size > VENDOR_FILE_MAX_BYTES) {
      setListProblem("Choose a file of at most 2 MB.");
      return;
    }
    const { text, legacy } = decodeList(await file.arrayBuffer());
    readList(text, file.name, legacy);
  }

  async function checkList() {
    if (!list) return;
    const mine = (run.current += 1);
    setChecked(null);
    setListProblem("");
    const { rows, more } = vendorRows(list.table, hasHeader, columns);
    setProgress({ done: 0, total: rows.length });
    try {
      const check = vendorRowChecker(await loadNameIndex(), rows);
      const results: VendorResult[] = [];
      for (let at = 0; at < rows.length; at += CHUNK) {
        if (run.current !== mine) return;
        for (const row of rows.slice(at, at + CHUNK)) results.push(check(row));
        setProgress({ done: results.length, total: rows.length });
        if (at + CHUNK < rows.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (run.current !== mine) return;
      setChecked({ results, more, header: columnNames(list.table, hasHeader) });
    } catch {
      setListProblem(LOAD_FAILED);
    } finally {
      if (run.current === mine) setProgress(null);
    }
  }

  function clearList() {
    forget();
    setPasted("");
    setList(null);
    setListProblem("");
  }

  const names = list ? columnNames(list.table, hasHeader) : [];
  const rowCount = list ? list.table.rows.length - (hasHeader ? 1 : 0) : 0;
  const choose = (field: VendorField, value: string) => {
    const next = { ...columns };
    if (value === NONE) delete next[field];
    else next[field] = Number(value);
    setColumns(next);
    forget();
  };

  const { summary, toLook, nothing } = useMemo(
    () => ({
      summary: checked ? vendorSummary(checked.results) : null,
      toLook: checked ? checked.results.filter(needsALook) : [],
      nothing: checked ? checked.results.filter((result) => !needsALook(result)) : [],
    }),
    [checked]
  );
  const walletsToLook = summary ? summary.walletStops + summary.walletNotes : 0;

  return (
    <div className="space-y-12">
      <section aria-labelledby={`${id}-one`} className="space-y-5">
        <h2 id={`${id}-one`} className="text-lg font-semibold tracking-[-0.01em] text-ink">
          Check one vendor
        </h2>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field id={`${id}-name`} label="Vendor name" description="A company or a person, as it is written on their invoices.">
            <Input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={onEnter} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={`${id}-country`} label="Country" optional description="A name or a two-letter code, such as DE.">
            <Input value={country} onChange={(event) => setCountry(event.target.value)} onKeyDown={onEnter} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" icon={<FileSearch />} loading={loading} onClick={() => void checkName()}>
            Check this name
          </Button>
          <FormMessage tone="error">{problem}</FormMessage>
        </div>
        <section aria-label="What the check found for one name" className="space-y-3">
          <div aria-live="polite">{one && <NameHeadline typed={one.typed} matches={one.matches} compared={one.compared} listDate={listDate} />}</div>
          {one?.compared && <LeftOut words={one.notLatin} />}
          {one?.matches.map((match) => (
            <MatchCard key={match.entry.number} match={match} />
          ))}
        </section>
      </section>

      <section aria-labelledby={`${id}-list`} className="space-y-5">
        <div>
          <h2 id={`${id}-list`} className="text-lg font-semibold tracking-[-0.01em] text-ink">
            Check a whole list
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            A CSV file, or rows pasted from Excel or Google Sheets, with a column for each vendor&apos;s name and, if you have them, its country and
            wallet address. Up to {VENDOR_ROWS_MAX.toLocaleString("en-US")} rows.
          </p>
        </div>
        {!list && (
          <div className="space-y-4">
            <FileInput
              id={`${id}-file`}
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              label="Choose a CSV file, or drop one here"
              description="Up to 2 MB. It is read in this page."
              onFile={(file) => void chose(file)}
            />
            <Field id={`${id}-paste`} label="Or paste rows from Excel or Google Sheets" description="Copy the rows with their column names, then paste them here.">
              <Textarea value={pasted} onChange={(event) => setPasted(event.target.value)} rows={5} autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" disabled={pasted.trim() === ""} onClick={() => readList(pasted, "Pasted rows", false)}>
                Read the list
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPasted(EXAMPLE_LIST);
                  readList(EXAMPLE_LIST, "Example list", false);
                }}
              >
                Try an example
              </Button>
            </div>
          </div>
        )}
        <FormMessage tone="error">{listProblem}</FormMessage>

        {list && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-2">
                <span className="font-semibold text-ink">{list.source}</span>: {plural(rowCount, "1 row", `${rowCount} rows`)},{" "}
                {plural(names.length, "1 column", `${names.length} columns`)}.
              </p>
              <Button type="button" variant="link" icon={<RotateCcw />} onClick={clearList}>
                Choose another list
              </Button>
            </div>
            {list.legacy && (
              <Callout tone="held">
                This file is not saved as UTF-8. If names look wrong, save it from Excel as &ldquo;CSV UTF-8&rdquo;, or paste the rows instead.
              </Callout>
            )}
            <Checkbox
              label="The first row holds column names"
              checked={hasHeader}
              onCheckedChange={(value) => {
                const header = value === true;
                setHasHeader(header);
                setColumns(detectVendorColumns(header ? list.table.rows[0].cells : [], header));
                forget();
              }}
            />
            <div>
              <p className="text-sm font-medium text-ink">Which column is which</p>
              <p className="mt-1 text-xs text-ink-3">Check each match, and change any that is wrong.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {VENDOR_FIELDS.map((field) => {
                const column = columns[field];
                const samples = column === undefined ? [] : sampleValues(list.table, hasHeader, column);
                return (
                  <Field
                    key={field}
                    id={`${id}-column-${field}`}
                    label={VENDOR_FIELD_LABELS[field]}
                    optional={field !== "name"}
                    description={column === undefined ? "Not in the list." : samples.length > 0 ? `Reads: ${samples.join(" · ")}` : "This column is empty."}
                  >
                    <Select value={column === undefined ? NONE : String(column)} onValueChange={(value) => choose(field, value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not in the list</SelectItem>
                        {names.map((heading, at) => (
                          <SelectItem key={at} value={String(at)}>
                            {columnLetter(at)} · {heading}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                icon={<FileSearch />}
                loading={progress !== null}
                disabled={columns.name === undefined && columns.wallet === undefined}
                onClick={() => void checkList()}
              >
                Check the list
              </Button>
              {columns.name === undefined && columns.wallet === undefined && <p className="text-sm text-ink-3">Choose the column with the vendors&apos; names.</p>}
            </div>
            {progress && progress.total > CHUNK && (
              <div className="space-y-1.5">
                <ProgressBar value={(progress.done / progress.total) * 100} label="How much of the list is checked" />
                <p className="text-xs text-ink-3">
                  Checked {progress.done.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")} rows.
                </p>
              </div>
            )}
          </div>
        )}

        <section aria-label="What the check found in the list" className="space-y-4">
          <div aria-live="polite">
            {checked && summary && (
              <Callout
                tone={summary.strong > 0 || summary.walletStops > 0 ? "refused" : summary.possible > 0 || summary.walletNotes > 0 ? "held" : "neutral"}
                title={`Checked against OFAC's SDN list as of ${listDate}`}
              >
                {plural(summary.rows, "1 row", `${summary.rows} rows`)} checked: {summary.strong} strong {plural(summary.strong, "match", "matches")},{" "}
                {summary.possible} possible {plural(summary.possible, "match", "matches")}, {summary.noMatch} with no match
                {summary.notCompared > 0 && `, ${summary.notCompared} not compared (not in Latin letters)`}.
                {summary.wallets > 0 && ` ${plural(walletsToLook, "1 wallet", `${walletsToLook} wallets`)} to look at.`}
                {checked.more > 0 && ` Only the first ${VENDOR_ROWS_MAX.toLocaleString("en-US")} rows were checked: ${checked.more.toLocaleString("en-US")} more were left out.`}
              </Callout>
            )}
          </div>
          {checked && list && (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => download(vendorResultsCsv(checked.header, checked.results, listDay), `ofac-vendor-check-${listDay}.csv`)}
              >
                Download the results (CSV)
              </Button>
              {toLook.length > 0 && (
                <ul className="space-y-4">
                  {toLook.map((result) => (
                    <RowCard key={result.row.line} result={result} listDate={listDate} />
                  ))}
                </ul>
              )}
              {nothing.length > 0 && (
                <Disclosure summary={`${plural(nothing.length, "1 row", `${nothing.length} rows`)} with no match in OFAC's SDN list as of ${listDate}`}>
                  <ul className="space-y-2 pt-1">
                    {nothing.map((result) => (
                      <li key={result.row.line} className="text-sm text-ink-2">
                        <span className="text-ink">{result.row.name || `Row ${result.row.line}`}</span>
                        {result.wallet && <span className="text-ink-3"> · {walletWords(result.wallet).text}</span>}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </>
          )}
        </section>
      </section>
    </div>
  );
}
