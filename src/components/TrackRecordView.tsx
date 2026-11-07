import type { ReactNode } from "react";
import { AgreementLadder } from "@/components/vx/AgreementLadder";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { plural, utcDay } from "@/lib/copy";
import type { TrackRecord } from "@/lib/track-record/build";

/**
 * The agent's track record as a page (docs/superpowers/specs/2026-11-07-track-record-design.md TR7): the totals, How
 * often you agreed with the report's own component, the earned vendors as the report words them, the verdicts with the
 * entries they rest on, and the record itself: its SHA-256, the download, the confirmations and Confirm (`confirm`).
 */

const seq = (n: number) => `#${String(n).padStart(4, "0")}`;
const usdc = (amount: number) => amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function TrackRecordView({ record, download, confirm }: { record: TrackRecord | null; download: string; confirm: ReactNode }) {
  if (!record) return null;
  const { totals } = record;
  const failed = record.entries.filter((entry) => entry.check?.ok === false).length;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
        Each verdict this business gave on one of the agent&apos;s decisions about a real bill, in shadow mode, and the vendors that earned the
        owner&apos;s rule. Every verdict is carried with the signed entries it rests on, so anyone can check it with the workspace&apos;s public keys.
        It only measures: it promises nothing about payments to come.
      </p>

      <dl className="grid grid-cols-3 gap-3 sm:max-w-xl">
        {[
          ["Verdicts", totals.given],
          ["Agreed", totals.agreed],
          ["Disagreed", totals.disagreed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line px-3 py-2.5">
            <dt className="text-xs text-ink-3">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {totals.given === 0 ? (
        <p className="text-sm text-ink-2">No verdict on a real bill yet, so there is nothing to confirm. Give one on a decision in Bills & receivables.</p>
      ) : (
        <>
          <Card className="p-4 sm:p-5">
            <AgreementLadder
              ladder={{ ...totals, byKind: record.byKind, byVendor: record.byVendor }}
              ruled={record.earned !== null && record.earned.streak !== null}
            />
          </Card>

          <Card className="space-y-3 p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-ink">Earned vendors</h3>
            {record.earned === null ? (
              <p className="text-xs text-ink-3">Earned vendors could not be read just now, so the record leaves them out and says so.</p>
            ) : record.earned.streak === null ? (
              <p className="text-xs text-ink-3">No rule is set. An owner sets one in Settings, under Earned vendors.</p>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-ink-3">
                  {`Under the owner's rule: ${record.earned.streak} agreed verdicts in a row on a vendor's payments. `}
                  {record.earned.payments ? "The agent pays an earned vendor on its own, and a person gives a verdict after." : "Earning changes nothing the agent may do."}
                </p>
                <ul aria-label="Earned vendors" className="divide-y divide-line rounded-xl border border-line text-sm">
                  {record.earned.vendors.map((vendor) => (
                    <li key={vendor.vendorId} className="space-y-1 px-3 py-2.5">
                      <p className="min-w-0 break-words">
                        <span className="font-medium text-ink">{vendor.name}</span> <span className="text-ink-2">{vendor.words}</span>
                      </p>
                      {vendor.waiting && <p className="text-xs text-ink-2">{vendor.waiting}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <section aria-labelledby="track-record-verdicts" className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 id="track-record-verdicts" className="text-sm font-semibold text-ink">
                The verdicts
              </h3>
              <span className="text-xs text-ink-3">
                {record.cut ? `The newest ${totals.given}: older ones are left out of this record` : "Oldest decision first"}
              </span>
            </div>
            <Table label="The verdicts">
              <TableHeader>
                <TableRow>
                  <TableHead>Decided</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Entries</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {record.verdicts.map((verdict) => (
                  <TableRow key={verdict.decisionSeq}>
                    <TableCell className="whitespace-nowrap tabular-nums">{utcDay(verdict.decidedAt)}</TableCell>
                    <TableCell>{verdict.kind}</TableCell>
                    <TableCell className="break-words">{verdict.vendor.name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{`${usdc(verdict.amount)} ${verdict.currency}`}</TableCell>
                    <TableCell className={verdict.verdict === "agree" ? "text-ink" : "text-refused"}>{verdict.verdict === "agree" ? "Agreed" : "Disagreed"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-ink-2">
                      {verdict.verdictSeq === null ? seq(verdict.decisionSeq) : `${seq(verdict.decisionSeq)}, ${seq(verdict.verdictSeq)}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">This record</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
            Its SHA-256 is worked out from the verdicts and the earned vendors above, not from when it was read, so the same verdicts give the same
            hash. An accountant&apos;s confirmation names it, in a signed ledger entry.
          </p>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-ink-3">SHA-256</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 break-all font-mono text-xs text-ink">{record.contentSha256}</span>
            <CopyButton value={record.contentSha256} label="Copy the record's SHA-256" size="icon-sm" />
          </dd>
          <dt className="text-ink-3">Read</dt>
          <dd className="text-ink-2">
            {utcDay(record.readAt)}
            {record.ledgerHead ? `, at ledger entry ${seq(record.ledgerHead.seq)}` : ""}
          </dd>
          <dt className="text-ink-3">Signed entries</dt>
          <dd className="text-ink-2">
            {`${record.entries.length} ${plural(record.entries.length, "entry", "entries")} carried in full`}
            {failed > 0 ? `, ${failed} of which did not check against the workspace's keys` : ""}
          </dd>
        </dl>
        <p className="text-sm print:hidden">
          <a href={download} download className="font-medium text-agent underline-offset-4 hover:underline">
            Download JSON
          </a>
          <span className="text-ink-3"> · the record, its entries and the workspace&apos;s public keys</span>
        </p>
        <div className="print:hidden">{confirm}</div>
      </Card>

      <section aria-labelledby="track-record-confirmations" className="space-y-2">
        <h3 id="track-record-confirmations" className="text-sm font-semibold text-ink">
          Confirmations
        </h3>
        {record.confirmations.length === 0 ? (
          <p className="text-sm text-ink-2">No accountant has confirmed a track record of this workspace yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-sm">
            {record.confirmations.map((confirmation) => (
              <li key={confirmation.seq} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                <span className="min-w-0 break-words text-ink">
                  {`${utcDay(confirmation.at)}, by ${confirmation.who ?? "a member"} `}
                  <span className="text-ink-3">{confirmation.current ? "This record" : "An earlier record"}</span>
                </span>
                <span className="min-w-0 break-all font-mono text-xs text-ink-3">{`${seq(confirmation.seq)} · ${confirmation.sha256.slice(0, 16)}…`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
