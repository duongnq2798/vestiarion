import Link from "next/link";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/DocsLink";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { plural, utcDay } from "@/lib/copy";
import type { CurrencyReport } from "@/lib/currency-report";
import { formatMoney, formatRateValue, rateEquation, rateTime, rateWords, RATE_KIND_WORDS, type ReportingTotals, type ReportingValue } from "@/lib/money";

/**
 * The report's **Currencies and rates** (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M8): each
 * figure in its own currency, then in the reporting currency with the rates that took it there, or unknown with why;
 * the FX variance on paid bills; every rate used, with its kind, source and time; and the two KPIs. Presentational: the
 * page reads and `buildCurrencyReport` works it out.
 */

function valueText(value: ReportingValue): ReactNode {
  if (value.state === "same" || value.state === "converted") return formatMoney(value.money);
  if (value.state === "unknown") return <span className="text-held">Unknown</span>;
  return "—";
}

function TotalLine({ totals }: { totals: ReportingTotals }) {
  if (!totals.reporting || totals.rows.length === 0) return null;
  const { total } = totals;
  if (total.state === "known") {
    return (
      <p className="text-sm text-ink">
        Total in {totals.reporting}: <span className="font-semibold tabular-nums">{formatMoney(total.money)}</span>
      </p>
    );
  }
  if (total.state !== "unknown") return null;
  const missing = total.missing.join(" and ");
  return (
    <p className="text-sm text-ink">
      Total in {totals.reporting}: <span className="font-semibold text-held">unknown</span>, since no {missing} rate was recorded.
      {total.known && (
        <span className="text-ink-2">
          {" "}
          Without {missing}: <span className="tabular-nums">{formatMoney(total.known)}</span>.
        </span>
      )}
    </p>
  );
}

function TotalsTable({ title, note, totals, countLabel }: { title: string; note: string; totals: ReportingTotals; countLabel: string }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs leading-relaxed text-ink-3">{note}</p>
      </div>
      {totals.rows.length === 0 ? (
        <p className="text-sm text-ink-2">None yet.</p>
      ) : (
        <>
          <Table label={title} containerClassName="rounded-xl border border-line">
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">{countLabel}</TableHead>
                <TableHead className="text-right">As written</TableHead>
                {totals.reporting && <TableHead className="text-right">{`In ${totals.reporting}`}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {totals.rows.map((row) => (
                <TableRow key={row.total.currency}>
                  <TableCell className="py-2 font-medium">{row.total.currency}</TableCell>
                  <TableCell className="py-2 text-right tabular-nums">{row.count}</TableCell>
                  <TableCell className="py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(row.total)}</TableCell>
                  {totals.reporting && (
                    <TableCell className="py-2 text-right tabular-nums whitespace-nowrap">
                      {valueText(row.value)}
                      {row.value.state === "converted" && (
                        <span className="block text-[0.6875rem] font-normal text-ink-3">{row.value.rates.filter((rate) => rate.kind !== "peg").map(rateEquation).join(", ") || "at par"}</span>
                      )}
                      {row.value.state === "unknown" && <span className="block max-w-56 text-[0.6875rem] font-normal whitespace-normal text-ink-3">{row.value.reason}</span>}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TotalLine totals={totals} />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-ground/40 p-3.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</dd>
      <dd className="mt-0.5 text-xs leading-relaxed text-ink-2">{note}</dd>
    </div>
  );
}

export function CurrencyReport({ report, settingsHref }: { report: CurrencyReport; settingsHref: string }) {
  const { provenance, variance } = report;
  const share = provenance.total === 0 ? null : Math.round((provenance.full / provenance.total) * 100);
  return (
    <section aria-labelledby="currencies-title" id="currencies" className="scroll-mt-24">
      <SectionHeader id="currencies-title" title="Currencies and rates" meta="each amount in its own currency first" action={<DocsLink href="/docs/guides/currencies" topic="currencies and rates" />} />
      <Card className="space-y-6 p-4 sm:p-5">
        <p className="text-sm text-ink-2">
          {!report.available ? (
            "The reporting currency is not set up on this deployment yet, so each amount stays in its own currency."
          ) : report.reporting ? (
            <>
              Reporting currency: <span className="font-semibold text-ink">{report.reporting}</span>. Totals in it use the reference rates listed below; a rate not recorded
              makes a figure unknown, never a guess. Payments still settle in USDC.
            </>
          ) : (
            <>
              No reporting currency is set, so each amount stays in its own currency and nothing is added across currencies. An owner or admin sets one in{" "}
              <Link href={settingsHref} className="font-medium text-agent underline-offset-2 hover:underline">
                Settings
              </Link>
              .
            </>
          )}
        </p>

        <dl className="grid gap-3 sm:grid-cols-3">
          <Kpi
            label="Amounts with full provenance"
            value={provenance.total === 0 ? "None yet" : `${provenance.full} of ${provenance.total}`}
            note={
              share === null
                ? "No bill is counted yet."
                : `${share}%: the amount as written and where it came from, the conversion's rate and time, ${report.reporting ? `its value in ${report.reporting}, ` : ""}and the rate on the day it was paid.`
            }
          />
          <Kpi
            label="Manual FX adjustments"
            value={report.manualAdjustments === null ? "Not set up" : String(report.manualAdjustments)}
            note="Rates a person typed into a saved cash scenario. Bills and payments keep their own rates."
          />
          <Kpi
            label="FX variance on paid bills"
            value={variance.totals.length === 0 ? "None yet" : variance.totals.map(({ total }) => formatMoney(total, { sign: true })).join(" + ")}
            note={`${plural(variance.rows.length, "bill", "bills")} paid at a rate that moved since the bill${variance.unknown.length > 0 ? `; ${variance.unknown.length} unknown` : ""}. Above zero, more was paid than the bill was worth that day.`}
          />
        </dl>

        <TotalsTable title="Bills, as written" note="Each bill in the currency on it, from the bills this report counts." totals={report.billsAsWritten} countLabel="Bills" />
        <TotalsTable title="Paid on Arc" note="What each transfer carried, in the token it moved in." totals={report.paidOnArc} countLabel="Payments" />
        {report.paidByBusiness && (
          <TotalsTable title="Paid by the business" note="What the business recorded paying outside Vestiarion, in the currency it paid in." totals={report.paidByBusiness} countLabel="Records" />
        )}

        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">FX variance on paid bills</h3>
            <p className="text-xs leading-relaxed text-ink-3">
              A bill in another currency was converted to USDC on the day it was added. When it was paid, the same part of the bill was worth more or less USDC at that
              day&apos;s rate. The difference is its FX variance.
            </p>
          </div>
          {variance.rows.length === 0 && variance.unknown.length === 0 ? (
            <p className="text-sm text-ink-2">
              No bill converted at a rate has been paid yet{variance.inDollars > 0 ? `; ${plural(variance.inDollars, "bill", "bills")} in US dollars carry none` : ""}.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {variance.rows.map((row) => (
                <li key={row.invoiceId} className="space-y-1 px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-medium text-ink">{row.payee}</span>
                    <Badge size="sm" tone={row.variance.minor > BigInt(0) ? "held" : "neutral"}>
                      {`${formatMoney(row.variance, { sign: true })} FX variance`}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-2">
                    {`${formatMoney(row.covered)} of the bill, paid with ${formatMoney(row.paid)} on ${utcDay(row.paidAt)}. Converted at ${formatRateValue(row.decision.value)} ${row.currency} per US dollar (published ${rateTime(row.decision.at)}); on the payment day the reference rate was ${formatRateValue(row.payment.value)} (published ${rateTime(row.payment.at)}), so the bill was worth ${formatMoney(row.valueAtPayment)}.`}
                  </p>
                </li>
              ))}
              {variance.unknown.map((row) => (
                <li key={row.invoiceId} className="space-y-1 px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-medium text-ink">{row.payee}</span>
                    <Badge size="sm" tone="held">
                      FX variance unknown
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-2">{`Paid on ${utcDay(row.paidAt)}. ${row.reason}`}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Rates used</h3>
          {report.rates.length === 0 ? (
            <p className="text-sm text-ink-2">No figure here needed a rate.</p>
          ) : (
            <ul className="space-y-1 text-xs leading-relaxed text-ink-2">
              {report.rates.map((rate) => (
                <li key={`${rate.kind}-${rate.from}-${rate.to}-${rate.source}-${rate.at}-${rate.value}`}>
                  <span className="font-medium text-ink">{RATE_KIND_WORDS[rate.kind].replace(/^./, (first) => first.toUpperCase())}</span>: {rateWords(rate)}.
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-relaxed text-ink-3">
            Reference rates are ExchangeRate-API&apos;s daily rates (
            <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" className="text-agent underline-offset-2 hover:underline">
              Rates By Exchange Rate API
            </a>
            ). The provider&apos;s quote and the books&apos; accounting rate are other rates, and none of them stands in for another.
          </p>
        </div>
      </Card>
    </section>
  );
}
