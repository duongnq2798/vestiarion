import { ArrowUpRight, FileJson, FileSpreadsheet, Minus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PrintButton } from "@/components/PrintButton";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { EvidenceLabel, evidenceIcon } from "@/components/vx/EvidenceChain";
import { closePackMonth, monthsBeside, type ClosePackMonth } from "@/lib/close-pack/month";
import type { ClosePack, ClosePackCheck, ClosePackChecks, ClosePackRow, ClosePackTotal } from "@/lib/close-pack/types";
import {
  addressLines,
  amountWords,
  approvedLines,
  billWords,
  booksWords,
  burnWords,
  CHECK_KIND_WORDS,
  decidedLines,
  escrowWords,
  openStateWords,
  paidToWords,
  recordWords,
  transactionWords,
  utcWords,
} from "@/lib/close-pack/words";

/**
 * The monthly close pack as a page (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP11, CP12, "Screens
 * and copy"): the month and its downloads, the figures, one card per payment settled in the month with what it rests
 * on, what was sent and not settled, and the escrow moves. Presentational: the page reads the pack (`readClosePack`),
 * and the guide's screenshot builds one from made-up records. Every sentence comes from the close pack's words, which
 * the CSV reads too, and every network name from the pack's own profile. Laid out to print as the PDF: the controls
 * and links drop out, a line says what the print is, and each card stays on one page where it fits.
 */

/** The six checks, in the order the CSV lists them, by the names the guide uses (CP8). */
const CHECKS: ReadonlyArray<readonly [keyof ClosePackChecks, string]> = [
  ["guardrails", "Guardrails"],
  ["screening", "Screening"],
  ["walletList", "OFAC address list"],
  ["payeeLock", "Payee lock"],
  ["payTo", "Invoice's own address"],
  ["milestone", "Milestone"],
];

const FEE_SOURCE: Record<string, string> = {
  chain_reported: "as the chain reported it",
  provider_estimate: "as Circle estimated it",
  simulated_profile: "simulated",
};

const LINK = "font-medium text-agent underline-offset-4 hover:underline";

const isZero = (amount: string) => /^0*(?:\.0*)?$/.test(amount);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sum = (totals: readonly ClosePackTotal[]) => totals.reduce((n, total) => n + total.payments, 0);

/** "2nd", "3rd", "11th". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** The month's heading: "October 2026", or "October 2026 so far" for a month not ended. */
const monthWords = (pack: ClosePack) => `${pack.month.label}${pack.ended ? "" : " so far"}`;

/**
 * A card's facts as a list: each label small and quiet, each value plain, kept whole in print. Set once on the list
 * rather than on each of a card's eleven facts, which a month of cards repeats (close pack page speed CS8).
 */
const FACTS = "grid gap-x-6 gap-y-3 sm:grid-cols-2 [&>div]:min-w-0 [&>div]:break-inside-avoid [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-ink-3 [&_dd]:mt-0.5 [&_dd]:text-sm [&_dd]:text-ink";

/** One fact, inside a list styled by `FACTS`. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The icons the cards and the escrow moves show: each check's kind, and the explorer link's arrow. */
type IconName = ClosePackCheck["kind"] | "explorer";

const iconId = (name: IconName) => `close-pack-icon-${name.replace("_", "-")}`;

function iconOf(name: IconName): LucideIcon {
  if (name === "explorer") return ArrowUpRight;
  if (name === "not_applicable") return Minus;
  return evidenceIcon(name);
}

/** The icons a pack shows: its rows' check kinds, and the arrow where a transaction links to its explorer. */
function iconsOf(pack: ClosePack): Set<IconName> {
  const names = new Set<IconName>(pack.rows.flatMap((row) => CHECKS.map(([key]) => row.checks[key].kind)));
  if (pack.rows.some((row) => row.transaction.explorerUrl) || pack.escrow.some((move) => move.explorerUrl)) names.add("explorer");
  return names;
}

/**
 * Each icon the page shows, drawn once (close pack page speed CS8). A month's cards repeat the same few, six check badges
 * and an explorer link a card, and an icon drawn where it shows is its whole SVG in the page and its drawing again in
 * the data React sends with it. Each badge and link points here instead (`IconUse`). Hidden: the words beside each say it.
 */
function IconSheet({ names }: { names: ReadonlySet<IconName> }) {
  if (names.size === 0) return null;
  return (
    <svg aria-hidden className="hidden">
      <defs>
        {[...names].map((name) => {
          const Icon = iconOf(name);
          return (
            <symbol key={name} id={iconId(name)} viewBox="0 0 24 24">
              <Icon />
            </symbol>
          );
        })}
      </defs>
    </svg>
  );
}

/** An icon from `IconSheet`, by reference: it takes the colour of the text around it, as a drawn icon does. */
function IconUse({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className}>
      <use href={`#${iconId(name)}`} />
    </svg>
  );
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </>
  );
}

/** A transaction on its chain's explorer, in a new tab: built by the reader from the chain's profile only (CP9). */
function ExplorerLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-0.5 ${LINK} print:hidden`}>
      View on the explorer
      <IconUse name="explorer" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function EvidenceLinkTo({ href }: { href: string }) {
  return (
    <Link href={href} className={`inline-block text-sm ${LINK} print:hidden`}>
      Open the payment&apos;s evidence
    </Link>
  );
}

/** How a check is known, in words beside its icon; a check with nothing to look at is neutral (CP8). */
function CheckKind({ check }: { check: ClosePackCheck }) {
  const icon = <IconUse name={check.kind} />;
  if (check.kind === "not_applicable") {
    return (
      <Badge size="sm" icon={icon}>
        {CHECK_KIND_WORDS.not_applicable}
      </Badge>
    );
  }
  return <EvidenceLabel kind={check.kind} icon={icon} />;
}

/** The month field, the months around it, the downloads and print (CP11, CP12). */
function MonthAndDownloads({ pack }: { pack: ClosePack }) {
  const now = new Date(pack.readAt);
  const last = closePackMonth(null, now) as ClosePackMonth;
  const current = closePackMonth(now.toISOString().slice(0, 7), now) as ClosePackMonth;
  const { previous, next } = monthsBeside(pack.month, now);
  const download = (format: "csv" | "json") => `/api/evidence/close-pack?${new URLSearchParams({ org: pack.workspace.slug, month: pack.month.key, format }).toString()}`;
  return (
    <>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <Field id="close-pack-month" label="Month">
          <Input type="month" name="month" size="sm" defaultValue={pack.month.key} min="2020-01" max={current.key} placeholder="YYYY-MM" />
        </Field>
        <Button type="submit" size="sm" variant="secondary">
          Show this month
        </Button>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link href={`?month=${last.key}`} className={LINK}>
            Last month
          </Link>
          <Link href={`?month=${current.key}`} className={LINK}>
            This month so far
          </Link>
          {previous && (
            <Link href={`?month=${previous.key}`} aria-label={`Previous month: ${previous.label}`} className={LINK}>
              {previous.label}
            </Link>
          )}
          {next && (
            <Link href={`?month=${next.key}`} aria-label={`Next month: ${next.label}`} className={LINK}>
              {next.label}
            </Link>
          )}
        </span>
      </form>
      <div className="flex flex-wrap gap-2">
        <PrintButton />
        <Button asChild size="sm" variant="secondary">
          <a href={download("csv")} download>
            <FileSpreadsheet aria-hidden />
            Download CSV
          </a>
        </Button>
        <Button asChild size="sm" variant="secondary">
          <a href={download("json")} download>
            <FileJson aria-hidden />
            Download signed JSON
          </a>
        </Button>
      </div>
    </>
  );
}

/**
 * The controls, none of them printed (CP11, CP12): the month, the downloads and print once the pack is read, and
 * between the downloads and their note, Export to Google Sheets where it is on (close pack Sheets GS5). `sheets` stays
 * at the same place in the tree whether the pack was read or not (see `ClosePackView`).
 */
export function ClosePackControls({ pack, sheets }: { pack: ClosePack | null; sheets?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 print:hidden">
      {pack && <MonthAndDownloads pack={pack} />}
      {sheets}
      {pack && (
        <p className="text-xs text-ink-3">
          Vestiarion records each download in the workspace&apos;s ledger with the file&apos;s SHA-256, so a copy can be matched to it later.
        </p>
      )}
    </div>
  );
}

/** The month's figures, and a line for each thing it lists apart, left out or could not read (CP2, CP6, CP15). */
export function ClosePackSummary({ pack }: { pack: ClosePack }) {
  const { totals } = pack;
  const paid = totals.onChain.map((total) => amountWords(total.amount, total.token));
  const withFees = totals.onChain.filter((total) => !isZero(total.routeFeesUsdc));
  // A route's fee is always in USDC; a second token's fees are named apart rather than added in.
  const routeFees = withFees.map((total) => `${amountWords(total.routeFeesUsdc, "USDC")}${withFees.length > 1 ? ` on ${total.token} payments` : ""}`);
  const simulated = sum(totals.simulated);
  const figures: Array<[string, ReactNode]> = [
    ["Payments settled", String(sum(totals.onChain))],
    ["Paid", paid.length > 0 ? <Lines lines={paid} /> : "None"],
    ["Route fees", routeFees.length > 0 ? <Lines lines={routeFees} /> : "None"],
    ["Not settled", String(pack.notSettled.length)],
    ["Signed entries verified", `${totals.entries.verified} of ${totals.entries.cited}`],
  ];
  const notes: string[] = [];
  if (simulated > 0) {
    const amounts = totals.simulated.map((total) => amountWords(total.amount, total.token)).join(" and ");
    notes.push(`${count(simulated, "simulated payment", "simulated payments")}, ${amounts}, listed apart: a sandbox's payments move nothing on chain.`);
  }
  if (totals.shadow === 1) notes.push("1 of these was made in shadow mode: it mirrors a bill the business paid its own way.");
  else if (totals.shadow > 1) notes.push(`${totals.shadow} of these were made in shadow mode: each mirrors a bill the business paid its own way.`);
  if (pack.rows.some((row) => row.transaction.networkFeeUsd !== null)) {
    notes.push("Network fees are listed with each payment, with where each figure came from. They are not added up: a batch's fee belongs to the whole batch.");
  }
  if (totals.withoutBill === 1) notes.push("1 payment whose bill was deleted is not listed. The audit export holds its entries.");
  else if (totals.withoutBill > 1) notes.push(`${totals.withoutBill} payments whose bill was deleted are not listed. The audit export holds their entries.`);
  if (pack.unread.includes("members")) notes.push("Members could not be read just now, so people are named by the first 8 characters of their id.");
  if (pack.unread.includes("screening")) notes.push("Some screening records could not be read just now. Those payments say so.");

  return (
    <section aria-labelledby="close-pack-summary" className="space-y-3">
      <h2 id="close-pack-summary" className="text-lg font-semibold text-ink">
        {monthWords(pack)}
      </h2>
      <p className="text-sm text-ink-2">Months are calendar months in UTC. A payment counts in the month Circle confirmed it.</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt>
              <Eyebrow>{label}</Eyebrow>
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {pack.cut && (
        <Callout tone="held">This month has more than 2,000 payments, so the pack shows the first 2,000. The audit export holds every entry.</Callout>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1 text-sm text-ink-2">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PaidTo({ row }: { row: ClosePackRow }) {
  const words = paidToWords(row);
  // An address on chain is written out in full, then its chain; a bank or a simulated payee is said in words.
  if (row.payee.address && words === row.payee.address) {
    return (
      <>
        <span className="break-all font-mono text-[0.8125rem]">{row.payee.address}</span>
        {row.transaction.chainLabel ? ` on ${row.transaction.chainLabel}` : ""}
      </>
    );
  }
  return <>{words}</>;
}

function documentLines(row: ClosePackRow): string[] {
  const bill = row.bill;
  if (bill.kind !== "invoice") return [];
  const lines = [
    ...(bill.document ? [`SHA-256 ${bill.document.sha256}; the document itself is not kept.`] : []),
    ...bill.vendorDocuments.map((document) => `Sent by the vendor on ${utcWords(document.at)}: SHA-256 ${document.sha256}.`),
  ];
  return lines.length > 0 ? lines : ["No document is recorded."];
}

function TransactionFact({ row }: { row: ClosePackRow }) {
  const transaction = row.transaction;
  const burn = burnWords(row);
  const fee = transaction.networkFeeUsd;
  const source = transaction.networkFeeSource ? FEE_SOURCE[transaction.networkFeeSource] : null;
  return (
    <Fact label="Transaction">
      <span className="block">{transactionWords(row)}</span>
      {/* The hash itself, so a printed copy keeps it. */}
      {transaction.txHash && <span className="block break-all font-mono text-[0.8125rem]">{transaction.txHash}</span>}
      {burn && <span className="block wrap-anywhere text-ink-2">{burn}</span>}
      {transaction.note && <span className="block text-held">{transaction.note}</span>}
      {transaction.explorerUrl && (
        <span className="block">
          <ExplorerLink href={transaction.explorerUrl} />
        </span>
      )}
      {fee !== null && <span className="block text-ink-2">{`Network fee: ${amountWords(fee, "USD")}${source ? `, ${source}` : ""}`}</span>}
      {transaction.routeFeeUsdc && <span className="block text-ink-2">{`Route fee: ${amountWords(transaction.routeFeeUsdc, "USDC")}`}</span>}
      {transaction.earlierAttempts > 0 && <span className="block text-ink-2">{`Paid on its ${ordinal(transaction.earlierAttempts + 1)} attempt`}</span>}
    </Fact>
  );
}

/** One payment settled in the month: its bill, who decided and approved it, its checks, its transaction and its signed entry. */
export function ClosePackPayment({ row }: { row: ClosePackRow }) {
  const bill = row.bill;
  const address = addressLines(row);
  return (
    <Card asChild elevation="flat" className="break-inside-avoid p-4 sm:p-5">
      <article>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="min-w-0 break-words text-base font-semibold text-ink">{row.payee.name ?? row.payee.counterpartyId}</h3>
          <span className="text-base font-semibold tabular-nums text-ink">{amountWords(row.amount, row.token)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <span>Paid {utcWords(row.paidAt)}</span>
          {row.simulated && (
            <Badge tone="simulated" size="sm">
              Simulated
            </Badge>
          )}
          {row.shadow && (
            <Badge tone="agent" size="sm">
              Shadow mode
            </Badge>
          )}
          {row.payee.bank && <Badge size="sm">Bank payout</Badge>}
        </div>
        <dl className={`mt-4 ${FACTS}`}>
          <Fact label="Bill">{billWords(row)}</Fact>
          {bill.kind === "invoice" && bill.poReference && <Fact label="Purchase order">{bill.poReference}</Fact>}
          {bill.kind === "invoice" && (
            <Fact label="Document">
              {/* A hash breaks where it must; the words around it do not. */}
              <span className="wrap-anywhere">
                <Lines lines={documentLines(row)} />
              </span>
            </Fact>
          )}
          <Fact label="Paid to">
            <PaidTo row={row} />
          </Fact>
          <Fact label="Decided">
            <Lines lines={decidedLines(row)} />
          </Fact>
          <Fact label="Approved">
            <Lines lines={approvedLines(row)} />
          </Fact>
          {address.length > 0 && (
            <Fact label="Address">
              <Lines lines={address} />
            </Fact>
          )}
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs font-medium text-ink-3">Checks</p>
          <ul className="mt-2 space-y-2.5">
            {CHECKS.map(([key, name]) => {
              const check = row.checks[key];
              return (
                <li key={key} className="break-inside-avoid text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{name}</span>
                    <CheckKind check={check} />
                  </span>
                  <span className={`mt-0.5 block ${check.warn ? "text-held" : "text-ink-2"}`}>{check.text}</span>
                  {check.notes.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
                      {check.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <dl className={`mt-4 border-t border-line pt-3 ${FACTS}`}>
          <TransactionFact row={row} />
          <Fact label="Books">{booksWords(row)}</Fact>
          <Fact label="Signed entry">
            <span className="wrap-anywhere">{recordWords(row.record)}</span>
          </Fact>
          <Fact label="Every entry it rests on">
            <span className="font-mono text-[0.8125rem] text-ink-2">{row.entries.map((seq) => `#${seq}`).join(" ")}</span>
          </Fact>
        </dl>
        <div className="mt-3">
          <EvidenceLinkTo href={row.evidencePath} />
        </div>
      </article>
    </Card>
  );
}

export function ClosePackPayments({ pack }: { pack: ClosePack }) {
  return (
    <section aria-labelledby="close-pack-payments" className="space-y-3">
      <h2 id="close-pack-payments" className="text-lg font-semibold text-ink">
        Payments
      </h2>
      {pack.rows.length === 0 ? (
        <EmptyState titleAs="h3" title={`No payment settled in ${pack.month.label}`} body={`Payments appear here once Circle confirms them on ${pack.network.label}.`} />
      ) : (
        <div className="space-y-3">
          {pack.rows.map((row) => (
            <ClosePackPayment key={row.paymentId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

/** What was sent in the month and not settled in it, each in its state; never in the totals (CP3). */
export function ClosePackNotSettled({ pack }: { pack: ClosePack }) {
  if (pack.notSettled.length === 0) return null;
  return (
    <section aria-labelledby="close-pack-open" className="space-y-3">
      <h2 id="close-pack-open" className="text-lg font-semibold text-ink">
        Not settled in {pack.month.label}
      </h2>
      <p className="text-sm text-ink-2">Payments sent in the month that Circle did not confirm in it. They are not in the totals.</p>
      <ul className="space-y-2">
        {pack.notSettled.map((payment) => (
          <li key={payment.paymentId} className="break-inside-avoid rounded-xl border border-line px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {payment.payee.name ?? payment.payee.counterpartyId}
                {payment.simulated && (
                  <Badge tone="simulated" size="sm">
                    Simulated
                  </Badge>
                )}
              </span>
              <span className="text-sm font-medium tabular-nums text-ink">{amountWords(payment.amount, payment.token)}</span>
            </div>
            <p className="mt-1 text-sm text-ink-2">{openStateWords(payment, pack.month)}</p>
            <div className="mt-1.5">
              <EvidenceLinkTo href={payment.evidencePath} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Money locked for a milestone, or taken back, in the month: a lock pays no one, so neither is in the totals (CP4). */
export function ClosePackEscrow({ pack }: { pack: ClosePack }) {
  if (pack.escrow.length === 0) return null;
  return (
    <section aria-labelledby="close-pack-escrow" className="space-y-3">
      <h2 id="close-pack-escrow" className="text-lg font-semibold text-ink">
        Escrow
      </h2>
      <p className="text-sm text-ink-2">
        Money locked for a milestone, or taken back from escrow, in the month. A lock pays no one, so neither is in the totals; a release that paid the
        contractor is a payment above.
      </p>
      <ul className="space-y-1.5 text-sm text-ink-2">
        {pack.escrow.map((move) => (
          <li key={move.entry} className="break-inside-avoid">
            {escrowWords(move)}
            {move.explorerUrl && (
              <>
                {" "}
                <ExplorerLink href={move.explorerUrl} />
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClosePackReport({ pack }: { pack: ClosePack }) {
  const { entries } = pack.totals;
  return (
    <>
      <IconSheet names={iconsOf(pack)} />
      <ClosePackSummary pack={pack} />
      <ClosePackPayments pack={pack} />
      <ClosePackNotSettled pack={pack} />
      <ClosePackEscrow pack={pack} />
      <p className="border-t border-line pt-4 text-sm text-ink-2">
        {`${entries.verified} of ${entries.cited} signed ledger entries this pack cites verified against the workspace's keys. The signed JSON carries each of them with the public keys, so anyone can check them offline.`}
      </p>
    </>
  );
}

/**
 * The close pack page's body (CP11). `sheets` is Export to Google Sheets (close pack Sheets GS5), which the page makes
 * from the month and the workspace, never from the pack: it sits at the same place in the tree whether the pack was read
 * or not, so a render whose read was refused (an export's revalidation once the page's reads are spent) keeps the
 * export's answer and its link (the revalidate unmount pattern). With no pack, `refused` stands in its place.
 */
export function ClosePackView({ pack, sheets, refused }: { pack: ClosePack | null; sheets?: ReactNode; refused?: ReactNode }) {
  return (
    <div className="space-y-8">
      {pack ? (
        <p className="hidden text-sm text-ink-2 print:block">
          {`Vestiarion monthly close pack · ${pack.workspace.name} (${pack.network.label}) · ${monthWords(pack)} · read ${utcWords(pack.readAt)}`}
        </p>
      ) : (
        refused
      )}
      <ClosePackControls pack={pack} sheets={sheets} />
      {pack && <ClosePackReport pack={pack} />}
    </div>
  );
}
