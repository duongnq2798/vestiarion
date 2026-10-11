import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { SignatureCheck } from "@/components/landing/SignatureCheck";
import { amountText, daysApart } from "@/components/vx/ActualsComparison";
import { Hash } from "@/components/vx/Primitives";
import { ReportValue } from "@/components/vx/ReportValue";
import { StatTile } from "@/components/vx/StatTile";
import { minutesInWords } from "@/components/vx/WorkspaceReport";
import { plural, utcDay, utcMinute } from "@/lib/copy";
import { networkProfile } from "@/lib/network";
import { txUrl } from "@/lib/payee-chains";
import type { SharedReportShown } from "@/lib/platform/shared-report";
import type { SharedComparison, SharedDecision, SharedPayment } from "@/lib/shared-report";
import type { CurrencyAmount } from "@/lib/workspace-report";

/**
 * A shared copy of a workspace report, where its public link opens (docs/superpowers/specs/2026-10-10-shared-report-
 * design.md S6, S11): the title, the period and the network, live; the money box; the figures; value, in its three
 * groups; agent vs what really happened as totals; each decided bill's newest decision with its signature checked in the
 * reader's browser; and the newest payments with their transactions. It names the workspace only when the share shows
 * its name. Presentational: `readSharedReport` reads and builds what it shows.
 */

const sums = (items: CurrencyAmount[]) => items.map((item) => amountText(item.amount, item.currency)).join(" + ");
const day = (date: string) => utcDay(`${date.slice(0, 10)}T00:00:00Z`);

function stanceWords(decision: SharedDecision, simulated: boolean): { word: string; tone: "proof" | "agent" | "held" | "neutral" } {
  switch (decision.stance) {
    case "paid":
      return { word: simulated ? "Paid (simulated)" : "Paid on Arc", tone: "proof" };
    case "pay":
      return { word: "Would pay", tone: "agent" };
    case "schedule":
      return { word: decision.payOn ? `Scheduled for ${day(decision.payOn)}` : "Scheduled", tone: "agent" };
    case "waited":
      return { word: "Waited", tone: "neutral" };
    default:
      return { word: "Held", tone: "held" };
  }
}

const DECIDED_BY: Record<SharedPayment["decidedBy"], string> = {
  agent: "The agent",
  person: "A person",
  verdict: "A person's verdict",
};

export function SharedReport({ view }: { view: SharedReportShown }) {
  const profile = networkProfile(view.network);
  return (
    <article className="space-y-10">
      <SharedReportHead view={view} />

      {view.figures.handled === 0 ? (
        <EmptyState icon={<FileText />} title="No bills yet" body="This business has not added a bill yet. The report counts what the agent does from its first one." />
      ) : (
        <>
          <SharedReportFigures view={view} />
          <ReportValue value={view.value} audience="public" />
          <Comparison comparison={view.comparison} label={profile.label} />
          <SharedDecisions view={view} />
          <Payments view={view} />
        </>
      )}

      <footer className="space-y-2 border-t border-line pt-6 text-xs leading-relaxed text-ink-3">
        <p>
          Shared by the business from its Vestiarion workspace. It leaves out memos, notes, references, invoice ids, and the names and emails of the
          business&apos;s people. The agent&apos;s reasoning is its first sentence, with any email, 0x address or id hidden.
          {view.options.names === "labels" ? " Suppliers are shown as labels, in the order each one's first bill arrived." : ""}
          {view.options.amounts === "hidden" ? " Amounts are hidden, and transactions are not linked." : ""}
        </p>
        <p>
          Each decision is a signed entry in the business&apos;s ledger. <strong className="font-medium text-ink-2">Check its signature</strong> runs in your
          browser: it checks that the business&apos;s key signed the entry and that it follows the entry before it. The entry&apos;s content stays private.
        </p>
      </footer>
    </article>
  );
}

/** The title, the period and the network, and that it is live. */
export function SharedReportHead({ view }: { view: SharedReportShown }) {
  const profile = networkProfile(view.network);
  return (
    <header className="space-y-3">
      <Eyebrow>Shared report</Eyebrow>
      <h1 className="text-pretty font-serif text-3xl leading-tight text-ink sm:text-4xl">{view.title}</h1>
      <p className="max-w-3xl text-[0.9375rem] leading-relaxed text-ink-2">
        {`What Vestiarion's agent did with ${view.named ? "this business's" : "the business's"} bills on ${profile.label}, ${
          view.openedAt ? `from ${utcDay(view.openedAt)}` : "since its workspace opened"
        } to now.`}
      </p>
      <p className="text-xs text-ink-3">
        <span className="font-medium text-ink-2">Live: recomputed each time this page opens.</span>{" "}
        <time dateTime={view.computedAt}>{`Computed ${utcMinute(view.computedAt)}.`}</time>{" "}
        {`Shared since ${utcDay(view.sharedAt)}.`}
      </p>
    </header>
  );
}

/** The money box and the figures. */
export function SharedReportFigures({ view }: { view: SharedReportShown }) {
  const profile = networkProfile(view.network);
  return (
    <div className="space-y-10">
      <MoneyBox view={view} label={profile.label} />
      <Figures view={view} />
    </div>
  );
}

function MoneyBox({ view, label }: { view: SharedReportShown; label: string }) {
  return (
    <Callout tone={view.realMoney ? "proof" : "neutral"} title={view.simulated ? "Sandbox: payments here are simulated." : `Payments on ${label}, in ${view.realMoney ? "real" : "test"} USDC.`}>
      {view.simulated && <p>Nothing moved on chain.</p>}
      {view.source === "sample" && <p>This workspace has no real bill yet, so the report counts its sample data.</p>}
      {view.shadow && (
        <p>
          {`Shadow mode since ${utcDay(view.shadow.startedAt)}: the business paid these bills itself, in ${view.shadow.currency}. A payment marked Mirror is its copy on ${label}.`}
        </p>
      )}
      <p>Counted from the business&apos;s signed ledger and its confirmed transfers.</p>
    </Callout>
  );
}

function Figures({ view }: { view: SharedReportShown }) {
  const { figures } = view;
  const given = figures.verdicts ? figures.verdicts.agreed + figures.verdicts.disagreed : 0;
  const paidSub =
    figures.paid.count === 0
      ? "Nothing paid yet"
      : `${figures.paid.byCurrency ? `${sums(figures.paid.byCurrency)} · ` : "Amounts hidden · "}${figures.paid.onTime} on or before the due day`;
  return (
    <section aria-label="Figures" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
      <StatTile label="Bills handled" sub={`${figures.decided} decided by the agent`}>
        {figures.handled}
      </StatTile>
      <StatTile label="Time to decide" sub="Median, from a bill arriving to the agent's first decision">
        {figures.medianMinutesToDecision === null ? "—" : minutesInWords(figures.medianMinutesToDecision)}
      </StatTile>
      <StatTile label={view.simulated ? "Paid (simulated)" : "Paid on Arc"} sub={paidSub}>
        {figures.paid.count}
      </StatTile>
      <StatTile
        label="Stopped before paying"
        sub={`${figures.stopped.byCode} refused by code · ${figures.stopped.byAgent} the agent's call · ${figures.stopped.waited} waited${figures.stopped.notSent > 0 ? ` · ${figures.stopped.notSent} not sent` : ""}`}
      >
        {figures.stopped.total}
      </StatTile>
      {figures.verdicts && (
        <StatTile label="People's verdicts" sub={figures.verdicts.rate === null ? "None given yet" : `${figures.verdicts.rate}% agreed with the agent`}>
          {figures.verdicts.agreed} of {given}
        </StatTile>
      )}
    </section>
  );
}

function Comparison({ comparison, label }: { comparison: SharedComparison; label: string }) {
  return (
    <section aria-labelledby="shared-actuals" className="space-y-3">
      <SectionHeader id="shared-actuals" title="Agent vs what really happened" meta="Totals only" />
      {comparison.kind === "not_ready" ? (
        <p className="text-sm text-ink-2">What the business paid outside Vestiarion is not recorded here yet.</p>
      ) : comparison.kind === "none" ? (
        <p className="text-sm text-ink-2">
          {`The business has not recorded what it paid for any bill yet${comparison.notRecorded > 0 ? `: ${comparison.notRecorded} decided ${plural(comparison.notRecorded, "bill waits", "bills wait")} for a record` : ""}.`}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Bills compared" sub={`${comparison.notRecorded} decided ${plural(comparison.notRecorded, "bill", "bills")} not recorded yet`}>
              {comparison.compared}
            </StatTile>
            <StatTile label="Same outcome" sub="Both paid it, or neither did">
              {comparison.same}
            </StatTile>
            <StatTile label="Different outcome" sub="One paid it and the other did not">
              {comparison.different}
            </StatTile>
            <StatTile
              label="Days apart"
              sub={comparison.daysCompared === 0 ? "No bill paid by both yet" : `The median over ${comparison.daysCompared} ${plural(comparison.daysCompared, "bill", "bills")}, from the agent's side`}
            >
              {daysApart(comparison.medianDays)}
            </StatTile>
          </div>
          <p className="text-xs text-ink-3">
            {`What the agent decided on ${label} beside what the business recorded paying from its own accounts. Only bills with a record are compared.`}
          </p>
        </>
      )}
    </section>
  );
}

/** Each decided bill's newest decision, with its signature check and its transaction. */
export function SharedDecisions({ view }: { view: SharedReportShown }) {
  return (
    <section aria-labelledby="shared-decisions" className="space-y-3">
      <SectionHeader
        id="shared-decisions"
        title="Decisions"
        meta={view.decisionCount > view.decisions.length ? `Newest ${view.decisions.length} of ${view.decisionCount}` : `${view.decisionCount} ${plural(view.decisionCount, "bill", "bills")}`}
      />
      {view.decisions.length === 0 ? (
        <EmptyState compact title="No decision yet" body="Each bill the agent decides shows here with its reasoning and its signed entry." />
      ) : (
        <Card className="overflow-hidden">
          <ol aria-label="The agent's newest decision on each bill" className="divide-y divide-line">
            {view.decisions.map((decision) => {
              const stance = stanceWords(decision, view.simulated);
              // Each Check its signature names its own decision to a screen reader: the day, the supplier, what the agent did.
              const describedBy = `shared-decision-${decision.seq}`;
              return (
                <li key={decision.seq} className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-6">
                  <div className="min-w-0 space-y-1.5">
                    <p id={describedBy} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <time dateTime={decision.at} className="whitespace-nowrap text-ink-3">
                        {utcDay(decision.at)}
                      </time>
                      <span className="font-medium text-ink">{decision.supplier}</span>
                      {decision.amount && <span className="tabular-nums text-ink-2">{amountText(decision.amount.amount, decision.amount.currency)}</span>}
                      <Badge size="sm" tone={stance.tone}>
                        {stance.word}
                      </Badge>
                      {decision.verdict && (
                        <Badge size="sm" tone={decision.verdict === "agree" ? "proof" : "refused"}>
                          {decision.verdict === "agree" ? "A person agreed" : "A person disagreed"}
                        </Badge>
                      )}
                    </p>
                    {decision.reasoning && <p className="text-sm leading-relaxed text-ink-2">{decision.reasoning}</p>}
                    {decision.rule && <p className="text-xs text-ink-3">{decision.rule}</p>}
                  </div>
                  <div className="grid content-start gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="font-mono text-xs text-ink-3">Ledger entry #{decision.seq}</span>
                      {decision.payment?.simulated ? (
                        <Badge size="sm" tone="simulated" title="A sandbox payment: nothing moved on chain">
                          Simulated
                        </Badge>
                      ) : decision.payment?.txHash ? (
                        <Hash value={decision.payment.txHash} href={txUrl(view.network, decision.payment.txHash)} />
                      ) : decision.payment && view.options.amounts === "hidden" ? (
                        <span className="text-xs text-ink-3">Transaction not linked</span>
                      ) : null}
                    </div>
                    {decision.link ? (
                      <SignatureCheck link={decision.link} publicKeys={view.publicKeys} describedBy={describedBy} />
                    ) : (
                      <p className="text-xs text-ink-3">Its signed entry could not be read.</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </section>
  );
}

function Payments({ view }: { view: SharedReportShown }) {
  return (
    <section aria-labelledby="shared-payments" className="space-y-3">
      <SectionHeader
        id="shared-payments"
        title="Payments and their proof"
        meta={view.figures.paid.count > view.payments.length ? `Newest ${view.payments.length} of ${view.figures.paid.count}` : undefined}
      />
      {view.payments.length === 0 ? (
        <EmptyState compact title="No payment yet" body="Each confirmed payment shows here with its transaction on the explorer." />
      ) : (
        <Card className="overflow-hidden">
          <Table label="Payments">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead>Transaction</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.payments.map((row, index) => (
                <TableRow key={`${row.at}-${index}`}>
                  <TableCell className="whitespace-nowrap text-ink-2">{utcDay(row.at)}</TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {row.supplier}
                      {row.mirror && (
                        <Badge size="sm" tone="simulated" title="A copy of a bill the business paid itself, in shadow mode">
                          Mirror
                        </Badge>
                      )}
                      {row.simulated && (
                        <Badge size="sm" tone="simulated" title="A sandbox payment: nothing moved on chain">
                          Simulated
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.amount ? amountText(row.amount.amount, row.amount.currency) : <span className="text-ink-3">Hidden</span>}
                    {row.bill && <span className="block text-xs text-ink-3">Bill: {amountText(row.bill.amount, row.bill.currency)}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-ink-2">{DECIDED_BY[row.decidedBy]}</TableCell>
                  <TableCell>
                    {row.txHash ? (
                      <Hash value={row.txHash} href={txUrl(view.network, row.txHash)} />
                    ) : !row.simulated && view.options.amounts === "hidden" ? (
                      <span className="text-xs text-ink-3">Not linked</span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {view.payments.length > 0 && view.options.amounts === "hidden" && (
        <p className="text-xs text-ink-3">Transactions are not linked while amounts are hidden: the public explorer shows what each one carried.</p>
      )}
    </section>
  );
}
