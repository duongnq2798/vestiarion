"use client";

import { FileSpreadsheet } from "lucide-react";
import { useState, useTransition } from "react";
import { checkVendorStatementAction } from "@/app/actions/vendor-statement";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { Input, Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { fmt } from "@/components/vx/Primitives";
import type { Role } from "@/lib/bank-statement/columns";
import type { StatementChoices, StatementRead } from "@/lib/bank-statement/lines";
import { decodeList } from "@/lib/bill-import/table";
import type { VendorStatementResult } from "@/lib/vendor-statement/check";
import { readVendorStatement } from "@/lib/vendor-statement/read";

/**
 * Check their statement (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS1-VS4): a vendor's statement of
 * account, pasted or chosen as a file, read here as the server will read it again, then checked against the vendor's
 * bills and the payments made to them. What is left is listed, each missing bill with an Add of its own for whoever may
 * add bills. It pays nothing and changes nothing.
 */

/** The columns a person can name, in the words of a vendor's statement. */
const COLUMNS: ReadonlyArray<readonly [Role, string]> = [
  ["bookingDate", "Date"],
  ["reference", "Invoice number"],
  ["description", "Description"],
  ["moneyOut", "Charges"],
  ["moneyIn", "Payments"],
  ["amount", "Amount, in one column"],
  ["balance", "Balance"],
  ["currency", "Currency"],
];

const todayNow = () => new Date().toISOString().slice(0, 10);
/** A statement in US dollars or euros is added as a bill in USDC or EURC; any other currency as written. */
const billCurrency = (currency: string) => (currency === "USD" ? "USDC" : currency === "EUR" ? "EURC" : currency);

export function VendorStatementCheck({ orgSlug, vendor, canAddBills }: { orgSlug: string; vendor: { id: string; name: string }; canAddBills: boolean }) {
  const [source, setSource] = useState("");
  const [choices, setChoices] = useState<StatementChoices>({ currency: "USD" });
  const [read, setRead] = useState<StatementRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; message?: string; result?: VendorStatementResult } | null>(null);
  const [pending, startTransition] = useTransition();

  function reread(text: string, next: StatementChoices) {
    setAnswer(null);
    if (text.trim() === "") {
      setRead(null);
      setReadError(null);
      return;
    }
    try {
      setRead(readVendorStatement(text, next, todayNow()));
      setReadError(null);
    } catch (error) {
      setRead(null);
      setReadError(error instanceof Error ? error.message : "This is not a table that can be read.");
    }
  }

  function choose(next: StatementChoices) {
    setChoices(next);
    reread(source, next);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const { text, legacy: oldEncoding } = decodeList(await file.arrayBuffer());
    setLegacy(oldEncoding);
    setSource(text);
    reread(text, choices);
  }

  const ready = read !== null && read.problems.length === 0 && read.questions.length === 0 && read.lines.length > 0;

  function check() {
    startTransition(async () => {
      try {
        setAnswer(await checkVendorStatementAction(orgSlug, vendor.id, source, { ...choices, columns: read?.columns ?? null }));
      } catch {
        setAnswer({ ok: false, message: "The statement could not be checked. Try again in a moment." });
      }
    });
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" icon={<FileSpreadsheet />} className="shrink-0">
          Check their statement
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Check ${vendor.name}'s statement`}
        description="Paste the table of their statement of account, or choose its CSV. Each line is matched against your bills to them and what you paid them. Nothing is paid or changed."
      >
        <div className="grid gap-5">
          <FileInput id={`statement-${vendor.id}`} accept=".csv,.txt,text/csv,text/plain" label="Their statement, as a CSV" onFile={onFile} disabled={pending} />
          <Field id={`statement-text-${vendor.id}`} label="Or paste its table" description="From their portal, a spreadsheet or a PDF's table: the date, the invoice number and the amounts.">
            <Textarea
              rows={5}
              value={source}
              // What is being checked stays what was read until its answer is back (review 7).
              readOnly={pending}
              onChange={(event) => {
                setSource(event.target.value);
                setLegacy(false);
                reread(event.target.value, choices);
              }}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          {legacy && <p className="text-xs text-ink-3">The file was not UTF-8, so it was read as Windows-1252. If names look wrong, paste the cells instead.</p>}
          {readError && <Callout tone="refused">{readError}</Callout>}

          {read && (
            <div className="grid gap-4 rounded-lg border border-line p-3">
              <p className="text-sm text-ink-2">
                {read.lines.length} line{read.lines.length === 1 ? "" : "s"} read
                {read.period ? `, from ${read.period.from} to ${read.period.to}` : ""}.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {COLUMNS.map(([role, label]) => (
                  <Field key={role} id={`statement-${vendor.id}-${role}`} label={label}>
                    <Select
                      value={read.columns[role] === null ? "none" : String(read.columns[role])}
                      onValueChange={(value) => choose({ ...choices, columns: { ...read.columns, [role]: value === "none" ? null : Number(value) } })}
                    >
                      <SelectTrigger id={`statement-${vendor.id}-${role}`} size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {read.headers.map((header, index) => (
                          <SelectItem key={index} value={String(index)}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ))}
              </div>
              {read.columns.amount !== null && (
                <RadioGroup
                  legend="In the amount column, their charge (an invoice) is written"
                  value={read.outIs}
                  onValueChange={(value) => choose({ ...choices, outIs: value === "negative" ? "negative" : "positive" })}
                  options={[
                    { value: "positive", label: "As a positive amount" },
                    { value: "negative", label: "As a negative amount" },
                  ]}
                />
              )}
              {read.questions.map((question) =>
                question.kind === "dateOrder" ? (
                  <RadioGroup
                    key="dateOrder"
                    legend={`How is ${question.example} read?`}
                    value={choices.dateOrder ?? ""}
                    onValueChange={(value) => choose({ ...choices, dateOrder: value as StatementChoices["dateOrder"] })}
                    options={question.readings.map((reading) => ({ value: reading.order, label: reading.day }))}
                  />
                ) : (
                  <RadioGroup
                    key="decimalMark"
                    legend={`Is ${question.example} a whole number or a decimal?`}
                    value={choices.decimalMark ?? ""}
                    onValueChange={(value) => choose({ ...choices, decimalMark: value as StatementChoices["decimalMark"] })}
                    options={[
                      { value: ",", label: "A whole number: the comma groups thousands" },
                      { value: ".", label: "A decimal: the comma is the decimal mark" },
                    ]}
                  />
                )
              )}
              {read.needsCurrency && (
                <Field id={`statement-${vendor.id}-currency-typed`} label="Its currency" description="USD for US dollars or USDC, EUR for euros or EURC.">
                  <Input value={choices.currency ?? ""} maxLength={4} onChange={(event) => choose({ ...choices, currency: event.target.value.toUpperCase() })} className="w-28 font-mono" />
                </Field>
              )}
              {read.problems.map((problem) => (
                <p key={problem} className="text-sm text-refused">
                  {problem}
                </p>
              ))}
            </div>
          )}

          <div>
            <Button type="button" disabled={!ready || pending} loading={pending} onClick={check}>
              Check against your books
            </Button>
          </div>
          {answer && !answer.ok && <Callout tone="refused">{answer.message}</Callout>}
          {answer?.result && <StatementResults orgSlug={orgSlug} vendor={vendor} result={answer.result} canAddBills={canAddBills} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-3">({count})</span>
      </h3>
      <ul className="grid gap-2 text-sm text-ink-2">{children}</ul>
    </section>
  );
}

/** What the check found (VS4): the counts, then each group with something in it. */
export function StatementResults({ orgSlug, vendor, result, canAddBills }: { orgSlug: string; vendor: { id: string; name: string }; result: VendorStatementResult; canAddBills: boolean }) {
  const money = (amount: number | null) => (amount === null ? "in another currency" : `${fmt(amount)} ${result.currency}`);
  const { counts } = result;
  // Each line added from here stays said, so it is never offered twice (review 7).
  const [added, setAdded] = useState<ReadonlySet<number>>(new Set());
  const clean =
    result.missing.length +
      result.rejected.length +
      result.twice.length +
      result.differs.length +
      result.notCompared.length +
      result.paidNotListed.length +
      result.unknownPayments.length +
      result.notListed.length ===
    0;
  return (
    <div className="grid gap-4 border-t border-line pt-4">
      <p className="text-sm text-ink">
        {counts.matchedCharges} of {counts.charges} charge{counts.charges === 1 ? "" : "s"} and {counts.matchedPayments} of {counts.payments} payment
        {counts.payments === 1 ? "" : "s"} on their statement match your books
        {result.period ? `, ${result.period.from} to ${result.period.to}` : ""}.
      </p>
      {clean && <Callout tone="proof">Everything on their statement matches your books, and everything on your books for those days is on it.</Callout>}
      <Group title="Missing here" count={result.missing.length}>
        {result.missing.map((line) => (
          <li key={line.line} className="grid gap-1">
            <span>
              Line {line.line}, {line.on}: {line.number ? `${line.number}, ` : ""}
              {money(line.amount)}
              {line.description ? `, ${line.description}` : ""}
            </span>
            {added.has(line.line) ? (
              <span className="text-xs text-proof">Added.</span>
            ) : canAddBills ? (
              <Disclosure summary="Add this bill" summaryClassName="text-xs font-medium text-agent">
                <InvoiceIntake
                  orgSlug={orgSlug}
                  counterparties={[{ id: vendor.id, name: vendor.name, role: "vendor" }]}
                  idPrefix={`statement-line-${line.line}`}
                  initialDirection="payable"
                  initial={{
                    counterpartyId: vendor.id,
                    amount: String(line.amount),
                    currency: billCurrency(result.currency),
                    memo: line.description || null,
                    invoiceNumber: line.number,
                  }}
                  onAdded={() => setAdded((before) => new Set(before).add(line.line))}
                />
              </Disclosure>
            ) : (
              <span className="text-xs text-ink-3">An owner or admin adds it.</span>
            )}
          </li>
        ))}
      </Group>
      <Group title="Rejected here" count={result.rejected.length}>
        {result.rejected.map((entry) => (
          <li key={entry.line}>
            Line {entry.line}: {entry.number}, {money(entry.amount)}. You rejected this bill: tell them why, or ask them to take it off.
          </li>
        ))}
      </Group>
      <Group title="Listed twice" count={result.twice.length}>
        {result.twice.map((entry) => (
          <li key={entry.number}>
            {entry.number}:{entry.lines.length > 1 ? ` on their statement at lines ${entry.lines.join(", ")}` : ""}
            {entry.lines.length > 1 && entry.billIds.length > 1 ? ";" : ""}
            {entry.billIds.length > 1 ? ` ${entry.billIds.length} bills here carry it` : ""}
          </li>
        ))}
      </Group>
      <Group title="Amount differs" count={result.differs.length}>
        {result.differs.map((entry) => (
          <li key={entry.line}>
            {entry.number}: theirs {money(entry.theirs)}, yours {money(entry.ours)}, a difference of {money(Math.round((entry.theirs - entry.ours) * 100) / 100)}
          </li>
        ))}
      </Group>
      {result.notCompared.length > 0 && (
        <p className="text-sm text-ink-2">
          {result.notCompared.map((entry) => entry.number).join(", ")} matched {result.notCompared.length === 1 ? "a bill" : "bills"} in another currency, so{" "}
          {result.notCompared.length === 1 ? "its amount was" : "their amounts were"} not compared.
        </p>
      )}
      <Group title="Paid, not on their statement" count={result.paidNotListed.length}>
        {result.paidNotListed.map((entry) => (
          <li key={`${entry.billId}-${entry.paidOn}`}>
            {money(entry.amount)} paid {entry.paidOn}
            {entry.number ? ` for ${entry.number}` : ""}
            {entry.txUrl && (
              <>
                {": "}
                <a href={entry.txUrl} target="_blank" rel="noopener noreferrer" className="text-agent underline underline-offset-2">
                  the transaction
                </a>
                , to send them
              </>
            )}
          </li>
        ))}
      </Group>
      <Group title="A payment you have no record of" count={result.unknownPayments.length}>
        {result.unknownPayments.map((entry) => (
          <li key={entry.line}>
            Line {entry.line}, {entry.on}: {money(entry.amount)}
            {entry.description ? `, ${entry.description}` : ""}
          </li>
        ))}
      </Group>
      <Group title="Not on their statement" count={result.notListed.length}>
        {result.notListed.map((entry) => (
          <li key={entry.billId}>
            {entry.number ?? "A bill"} added {entry.addedOn}, {money(entry.amount)}, {entry.status}
          </li>
        ))}
      </Group>
      <p className="text-sm text-ink-2">
        {result.balance.theirs === null ? "Their statement prints no balance." : `Their balance: ${money(result.balance.theirs)}.`} What your open bills to{" "}
        {vendor.name} add up to: {money(result.balance.ours)}
        {result.balance.otherCurrency > 0
          ? `, leaving out ${result.balance.otherCurrency} open bill${result.balance.otherCurrency === 1 ? "" : "s"} in another currency`
          : ""}
        .
      </p>
    </div>
  );
}
