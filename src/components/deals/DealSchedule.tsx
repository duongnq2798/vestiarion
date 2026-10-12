import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { utcDay } from "@/lib/copy";
import { inForce, lineState, releaseRefusal, type DealLine, type LineState } from "@/lib/deals/lines";
import { formatMinor } from "@/lib/deals/money";
import type { DealRecord, DealVersion } from "@/lib/deals/read";
import { changeWords } from "@/lib/deals/words";
import { ReleaseLineButton } from "./DealControls";
import { DealMoney } from "./DealMoney";

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** Each line's state, in a word or two. */
export const LINE_STATE: Record<LineState, { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  planned: { label: "Planned", tone: "neutral" },
  released: { label: "Released", tone: "agent" },
  overdue: { label: "Overdue", tone: "held" },
  paid: { label: "Paid", tone: "proof" },
  not_made: { label: "Receivable not made", tone: "held" },
  credit: { label: "Credit owed", tone: "neutral" },
  superseded: { label: "Replaced", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const VERSION_KIND: Record<DealVersion["kind"], string> = { signed: "Signed", revised: "Changed", cancelled: "Cancelled", reopened: "Reopened" };

function LineRow({ line, deal, today, orgSlug, canWrite }: { line: DealLine; deal: DealRecord; today: string; orgSlug: string; canWrite: boolean }) {
  const state = lineState(line, today);
  const { label, tone } = LINE_STATE[state];
  const releasable = canWrite && releaseRefusal(deal.facts, line) === null;
  const replaced = line.replaces ? deal.facts.lines.find((candidate) => candidate.id === line.replaces) : undefined;
  return (
    <TableRow>
      <TableCell className="px-3 py-2.5">
        <span className="block text-[0.8125rem] font-medium text-ink">{line.label}</span>
        {line.roundingMinor > 0 && <span className="block text-[0.6875rem] text-ink-3">Includes {formatMinor(line.roundingMinor, deal.digits)} from rounding</span>}
        {replaced && <span className="block text-[0.6875rem] text-ink-3">Replaces the version {line.addedIn - 1} line of {formatMinor(replaced.amountMinor, deal.digits)}, invoiced {dayWords(replaced.invoiceOn)}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-ink-2">{line.kind === "credit" ? "—" : dayWords(line.invoiceOn)}</TableCell>
      <TableCell className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-ink-3">{line.kind === "credit" ? "—" : dayWords(line.dueOn)}</TableCell>
      <TableCell className="px-3 py-2.5 text-right">
        <DealMoney minor={line.amountMinor} digits={deal.digits} currency={deal.facts.currency} className="text-[0.8125rem] text-ink" />
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <Badge size="sm" tone={tone} dot>
          {label}
        </Badge>
        {state === "planned" && deal.facts.autoRelease && deal.facts.status === "active" && (
          <span className="mt-1 block text-[0.6875rem] text-ink-3">The agent releases it on {dayWords(line.invoiceOn)}</span>
        )}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right">
        {releasable ? <ReleaseLineButton orgSlug={orgSlug} dealId={deal.facts.id} lineId={line.id} label={line.label} again={state === "not_made"} /> : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * A deal's schedule: the lines in force by invoice day, each with its state and, for an owner or admin, Release now; the
 * lines later versions replaced or cancelled folded under it. A released line not paid is money expected, never cash.
 */
export function DealSchedule({ orgSlug, deal, today, canWrite }: { orgSlug: string; deal: DealRecord; today: string; canWrite: boolean }) {
  const lines = inForce(deal.facts.lines).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "credit" ? 1 : -1) || a.invoiceOn.localeCompare(b.invoiceOn) || a.position - b.position);
  const ended = deal.facts.lines.filter((line) => line.status === "superseded" || line.status === "cancelled");
  const head = (
    <TableHeader>
      <TableRow>
        <TableHead className="px-3">Line</TableHead>
        <TableHead className="px-3">Invoice day</TableHead>
        <TableHead className="px-3">Due</TableHead>
        <TableHead className="px-3 text-right">Amount</TableHead>
        <TableHead className="px-3">State</TableHead>
        <TableHead className="px-3">
          <span className="sr-only">Action</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
  return (
    <section aria-labelledby="deal-schedule-title">
      <SectionHeader id="deal-schedule-title" title="Schedule" meta="each line becomes a receivable when it is released" />
      <Card className="overflow-hidden">
        <Table label="The deal's schedule">
          {head}
          <TableBody>
            {lines.map((line) => (
              <LineRow key={line.id} line={line} deal={deal} today={today} orgSlug={orgSlug} canWrite={canWrite} />
            ))}
          </TableBody>
        </Table>
        <p className="border-t border-line px-3 py-2.5 text-xs text-ink-3">
          A released line is a receivable on Bills & receivables, with its pay link and reminders. Until it is paid it is money expected on Treasury, never cash; a
          line not released yet is planned, and counted in no balance.
        </p>
      </Card>
      {ended.length > 0 && (
        <Disclosure className="mt-3" summary={<span className="text-sm text-ink">Replaced and cancelled lines ({ended.length})</span>}>
          <Table label="Lines later versions replaced or cancelled">
            {head}
            <TableBody>
              {ended.map((line) => (
                <LineRow key={line.id} line={line} deal={deal} today={today} orgSlug={orgSlug} canWrite={false} />
              ))}
            </TableBody>
          </Table>
        </Disclosure>
      )}
    </section>
  );
}

/** Every version, newest first: what it changed, its total and the difference, its reason. Each is a signed entry. */
export function DealVersions({ deal }: { deal: DealRecord }) {
  const money = (minor: number) => `${formatMinor(minor, deal.digits)} ${deal.facts.currency}`;
  const versions = [...deal.versions].reverse();
  return (
    <section aria-labelledby="deal-versions-title">
      <SectionHeader id="deal-versions-title" title="Versions" meta="each one a signed entry in the audit log; released lines are never rewritten" />
      <Card className="overflow-hidden">
        <ol className="divide-y divide-line">
          {versions.map((version) => {
            const previous = deal.versions.find((candidate) => candidate.version === version.version - 1);
            const difference = previous ? version.totalMinor - previous.totalMinor : 0;
            return (
              <li key={version.version} className="px-4 py-3 sm:px-5">
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="font-medium text-ink">Version {version.version}</span>
                  <Badge size="sm" tone={version.kind === "cancelled" ? "neutral" : "agent"}>
                    {VERSION_KIND[version.kind]}
                  </Badge>
                  <span className="font-mono text-xs text-ink-3">{utcDay(version.createdAt)}</span>
                </p>
                <p className="mt-0.5 text-[0.8125rem] text-ink-2">
                  Total <DealMoney minor={version.totalMinor} digits={deal.digits} currency={deal.facts.currency} />
                  {previous && (
                    <>
                      {" "}
                      (difference <DealMoney minor={difference} digits={deal.digits} currency={deal.facts.currency} sign />)
                    </>
                  )}
                </p>
                {version.reason && <p className="mt-0.5 text-xs text-ink-3">Reason: {version.reason}</p>}
                {version.changes.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                    {version.changes.map((change, index) => (
                      <li key={index}>{changeWords(change, money)}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </section>
  );
}
