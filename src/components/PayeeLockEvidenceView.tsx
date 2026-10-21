import { ArrowUpRight, FileJson, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PrintButton } from "@/components/PrintButton";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import type { PayeeLockEvidence, Period } from "@/lib/payee-lock-evidence";
import { ANSWER_WORDS, whoWords, type Answer, type QuestionAnswer } from "@/lib/payee-lock-evidence-report";

/**
 * The payee lock's evidence pack as a page (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP7, EP8,
 * EP10): the period, its downloads and the print view, the lock, the counts, what the records answer to the questions
 * insurers ask, and every address change with what it rests on. Read-only, and laid out to print as the PDF.
 */

const HOLD_WORDS: Record<string, string> = {
  "counterparty.address_unconfirmed": "address not yet confirmed",
  "counterparty.cooling_off": "the payee lock's wait",
  "counterparty.new_payee": "new payee check",
};

const ANSWER_TONE: Record<Answer, "proof" | "held" | "refused" | "neutral"> = { yes: "proof", partly: "held", no: "refused", not_seen: "neutral" };

/** A timestamp as the pack reads in print: "2026-10-20 14:03 UTC". */
export function utc(ts: string): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The period in days, as the file names it: "2026-10-01 to 2026-10-31", "from 2026-10-01", "all time". */
export function periodWords(period: Period): string {
  if (period.from && period.to) return `${period.from} to ${period.to}`;
  if (period.from) return `from ${period.from}`;
  if (period.to) return `until ${period.to}`;
  return "all time";
}

const yesNo = (value: boolean | null) => (value === true ? "Yes" : value === false ? "No" : "Not known");

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 break-inside-avoid">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

const Address = ({ value }: { value: string | null }) =>
  value ? <span className="break-all font-mono text-[0.8125rem]">{value}</span> : <span className="text-ink-3">none</span>;

const Entries = ({ seqs }: { seqs: number[] }) => <span className="font-mono text-[0.8125rem] text-ink-2">{seqs.map((seq) => `#${seq}`).join(" ")}</span>;

function Change({ row }: { row: PayeeLockEvidence["changes"][number] }) {
  const confirmation = row.confirmation;
  const payment = row.firstPayment;
  const seqs = [row.change.entry, ...(confirmation ? [confirmation.entry] : []), ...row.holds.map((hold) => hold.entry), ...(payment ? [payment.entry] : [])];
  return (
    <Card elevation="flat" className="break-inside-avoid p-4 sm:p-5">
      <h3 className="text-base font-semibold text-ink">{row.counterparty.name ?? row.counterparty.id}</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label="Changed">
          {utc(row.change.at)}, by {whoWords(row.change.enteredBy)}
          {row.change.chain ? `, on ${row.change.chain}` : ""}
        </Fact>
        <Fact label="From">
          <Address value={row.change.from} />
        </Fact>
        <Fact label="To">
          <Address value={row.change.to} />
        </Fact>
        <Fact label="Confirmed">
          {confirmation ? `${utc(confirmation.at)}, by ${whoWords(confirmation.by)}` : <span className="text-held">Not confirmed</span>}
        </Fact>
        {confirmation && (
          <>
            <Fact label="How it was checked">
              {confirmation.record ? (
                <>
                  {confirmation.record.methodLabel ?? "Not said"}
                  {confirmation.record.contact ? `, ${confirmation.record.contact}` : ""}
                  {confirmation.record.note ? `. ${confirmation.record.note}` : ""}
                </>
              ) : (
                <span className="text-ink-3">Not recorded</span>
              )}
            </Fact>
            <Fact label="Contact on file before the change">{yesNo(row.checks.contactOnFileBefore)}</Fact>
            <Fact label="Confirmed by a second person">
              {yesNo(row.checks.secondPerson)}
              {confirmation.soloConfirmation ? " (no one else could confirm it)" : ""}
            </Fact>
            {confirmation.waitHours !== null && (
              <Fact label="Payee lock wait">
                {confirmation.waitHours} hours, payable from {utc(confirmation.payableFrom!)}
              </Fact>
            )}
            {(confirmation.lookalikeOf.length > 0 || confirmation.looksLikeEarlier) && (
              <Fact label="Lookalike warning">
                {[
                  ...confirmation.lookalikeOf.map((other) => `looks like ${other.name ?? other.id}'s address`),
                  ...(confirmation.looksLikeEarlier ? [`looks like an earlier address of this payee (${confirmation.looksLikeEarlier})`] : []),
                ].join("; ")}
              </Fact>
            )}
          </>
        )}
        <Fact label="Held for the address">
          {row.holds.length === 0 ? "No payment was held" : row.holds.map((hold) => `${utc(hold.at)}, ${HOLD_WORDS[hold.rule] ?? hold.rule}`).join("; ")}
        </Fact>
        <Fact label="First payment">
          {payment ? (
            <>
              {payment.amount !== null ? `${payment.amount} ${payment.currency}` : payment.currency}, {utc(payment.at)}, {payment.decidedBy === "person" ? "approved by a person" : "by the agent"}
              {payment.txUrl && (
                <>
                  {" "}
                  <a href={payment.txUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-agent underline-offset-4 hover:underline">
                    transaction
                    <ArrowUpRight aria-hidden className="size-3.5" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </>
              )}
            </>
          ) : (
            <span className="text-ink-3">Not paid yet</span>
          )}
        </Fact>
        <Fact label="Signed entries">
          <Entries seqs={seqs} />
        </Fact>
      </dl>
    </Card>
  );
}

export function PayeeLockEvidenceView({
  pack,
  questions,
  slug,
  presets,
}: {
  pack: PayeeLockEvidence;
  questions: QuestionAnswer[];
  slug: string;
  /** The period links above the form: a name and its `from`/`to`. */
  presets: Array<{ label: string; period: Period }>;
}) {
  const query = (period: Period, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      org: slug,
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
      ...extra,
    }).toString();
  const pageHref = (period: Period) => {
    const params = new URLSearchParams({ ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) }).toString();
    return params ? `?${params}` : "?";
  };
  const { summary, lock } = pack;
  const verified = pack.entries.filter((entry) => entry.check?.ok === true).length;
  const heldChanges = pack.changes.filter((row) => row.holds.length > 0).length;
  const lockWords = lock.now.on
    ? lock.now.coolingHours > 0
      ? `The payee lock is on, with a ${lock.now.coolingHours}-hour wait after an address changes.`
      : "The payee lock is on, with no wait after an address changes."
    : "The payee lock is off.";

  return (
    <div className="space-y-8">
      <p className="hidden text-sm text-ink-2 print:block">
        Vestiarion payee lock evidence · {pack.workspace.name} ({pack.network.label}) · {periodWords(pack.period)} · read {utc(pack.exportedAt)}
      </p>

      <div className="flex flex-col gap-4 print:hidden">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field id="evidence-from" label="From">
            <Input type="date" name="from" size="sm" defaultValue={pack.period.from ?? ""} />
          </Field>
          <Field id="evidence-to" label="To">
            <Input type="date" name="to" size="sm" defaultValue={pack.period.to ?? ""} />
          </Field>
          <Button type="submit" size="sm" variant="secondary">
            Show this period
          </Button>
          <span className="flex flex-wrap gap-3 text-sm">
            {presets.map((preset) => (
              <Link key={preset.label} href={pageHref(preset.period)} className="font-medium text-agent underline-offset-4 hover:underline">
                {preset.label}
              </Link>
            ))}
          </span>
        </form>
        <div className="flex flex-wrap gap-2">
          <PrintButton />
          <Button asChild size="sm" variant="secondary">
            <a href={`/api/evidence/payee-lock?${query(pack.period, { format: "csv" })}`} download>
              <FileSpreadsheet aria-hidden />
              Download CSV
            </a>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <a href={`/api/evidence/payee-lock?${query(pack.period)}`} download>
              <FileJson aria-hidden />
              Download signed JSON
            </a>
          </Button>
        </div>
      </div>

      <section aria-labelledby="pack-summary" className="space-y-3">
        <h2 id="pack-summary" className="text-lg font-semibold text-ink">
          {periodWords(pack.period).replace(/^./, (first) => first.toUpperCase())}
        </h2>
        <p className="text-sm text-ink-2">{lockWords}</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
          {[
            ["Address changes", String(summary.changes)],
            ["Confirmed with a record", `${summary.confirmedWithRecord} of ${summary.confirmed}`],
            ["By a second person", `${summary.confirmedBySecondPerson} of ${summary.confirmed}`],
            ["With a payment held", String(heldChanges)],
            ["Paid only after confirming", `${summary.paidOnlyAfterConfirmation} of ${summary.paid}`],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>
                <Eyebrow>{label}</Eyebrow>
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="pack-questions" className="space-y-3">
        <h2 id="pack-questions" className="text-lg font-semibold text-ink">
          What insurers ask, and what these records show
        </h2>
        <p className="text-sm text-ink-3">
          The questions paraphrase the controls on changed payment details that insurers&apos; questionnaires commonly ask about; each insurer words its
          own. The answers count this period&apos;s address changes.
        </p>
        <ol className="space-y-3">
          {questions.map((item) => (
            <li key={item.id} className="break-inside-avoid rounded-xl border border-line px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{item.question}</p>
                <Badge tone={ANSWER_TONE[item.answer]} size="sm">
                  {ANSWER_WORDS[item.answer]}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-ink-2">{item.evidence}</p>
              <p className="mt-1 text-xs text-ink-3">{item.how}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pack-changes" className="space-y-3">
        <h2 id="pack-changes" className="text-lg font-semibold text-ink">
          Address changes
        </h2>
        {pack.changes.length === 0 ? (
          <EmptyState titleAs="h3" title="No payout address changed in this period" body="Changes appear here once a payee's address is changed, on Counterparties, a payee link or GitHub." />
        ) : (
          <div className="space-y-3">
            {pack.changes.map((row) => (
              <Change key={row.change.entry} row={row} />
            ))}
          </div>
        )}
      </section>

      {lock.changes.length > 0 && (
        <section aria-labelledby="pack-lock" className="space-y-2">
          <h2 id="pack-lock" className="text-lg font-semibold text-ink">
            Changes to the payee lock
          </h2>
          <ul className="space-y-1 text-sm text-ink-2">
            {lock.changes.map((change) => (
              <li key={change.entry}>
                {utc(change.at)}, by {whoWords(change.by)} <Entries seqs={[change.entry]} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="border-t border-line pt-4 text-sm text-ink-2">
        {verified} of {pack.entries.length} signed ledger entries this pack cites verified against the workspace&apos;s keys. The signed JSON carries
        each of them with the public keys, so anyone can check them offline.
      </p>
    </div>
  );
}
