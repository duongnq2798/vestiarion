"use client";

import { BookCheck, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { approveBookingsAction, type BookingActionResult } from "@/app/actions/accounting-bookings";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { shortPaymentId } from "@/lib/connectors/booked";
import type { BookingRowView } from "@/lib/connectors/bookings-view";
import { utcDay } from "@/lib/copy";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/connectors/provider";
import { networkProfile } from "@/lib/network";

const INITIAL: BookingActionResult = { ok: false, message: "" };
const MAX = 10;

const money = (amount: string, currency: string) =>
  `${Number(amount).toLocaleString("en-US", { minimumFractionDigits: ["JPY", "KRW", "IDR"].includes(currency) ? 0 : 2, maximumFractionDigits: 6 })} ${currency}`;
const hash = (value: string) => (value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value);

/** A bill's state in the tool, in its own screens' words. */
const BILL_STATUS: Record<string, string> = { open: "Awaiting payment", paid: "Paid", "part paid": "Part paid", voided: "Voided", deleted: "Deleted", draft: "Draft" };

/** What changes in the tool, field by field: as it is now, and as it will be (W6). */
function Diff({ row, label }: { row: BookingRowView; label: string }) {
  const lines: Array<{ field: string; now: string; after: string }> = [
    ...(row.billNow
      ? [
          { field: `Bill ${row.billNumber ?? ""} amount due`.replace("  ", " "), now: money(row.billNow.amountDue, row.currency), after: row.billAfter ? money(row.billAfter.amountDue, row.currency) : "unchanged" },
          { field: "Bill status", now: BILL_STATUS[row.billNow.status] ?? row.billNow.status, after: row.billAfter ? BILL_STATUS[row.billAfter.status] : "unchanged" },
        ]
      : []),
    { field: "Payment", now: "none", after: money(row.amount, row.currency) },
    { field: "Paid from", now: "", after: row.account ?? "Choose where payments are booked" },
    { field: "Date", now: "", after: utcDay(`${row.paidOn}T12:00:00.000Z`) },
    { field: "Reference", now: "", after: hash(row.reference) },
  ];
  return (
    <table className="w-full text-left text-xs">
      <caption className="sr-only">What booking it changes in {label}</caption>
      <thead>
        <tr className="text-ink-3">
          <th scope="col" className="py-1 pr-3 font-medium">
            In {label}
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            Now
          </th>
          <th scope="col" className="py-1 font-medium">
            After booking
          </th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {lines.map((line) => (
          <tr key={line.field} className="border-t border-line align-top">
            <th scope="row" className="py-1 pr-3 font-normal text-ink-2">
              {line.field}
            </th>
            <td className="py-1 pr-3 text-ink-3">{line.now || "·"}</td>
            <td className="py-1 font-medium text-ink [overflow-wrap:anywhere]" title={line.field === "Reference" ? row.reference : undefined}>
              {line.after}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The payment on Arc it mirrors, and the network fee, shown apart and never booked (W5). */
function ArcLine({ row }: { row: BookingRowView }) {
  const network = networkProfile(row.network).label;
  return (
    <p className="text-xs text-ink-3">
      Paid on {network}: {money(row.paidAmount, row.paidToken)}
      {row.shadow ? ", in shadow mode" : ""}
      {row.networkFee ? ` · network fee ${money(row.networkFee, "USDC")}, not booked` : ""}
    </p>
  );
}

/**
 * To book in Xero (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W6, W10): each payment made on Arc
 * for a bill brought in from the tool, as the change it makes there, for an owner, admin or accountant to approve. Nothing is
 * written to the tool until they do; each ticked booking goes with the fingerprint of what this page shows, and the
 * server refuses it as stale if anything changed since. Below, the bookings done, and those never booked, with why.
 */
export function AccountingBookings({
  provider,
  orgSlug,
  connectionId,
  organisation,
  scopeMissing,
  accountChosen,
  toReview,
  done,
  canBook,
}: {
  provider: ProviderId;
  orgSlug: string;
  connectionId: string;
  organisation: string | null;
  scopeMissing: boolean;
  accountChosen: boolean;
  toReview: BookingRowView[];
  done: BookingRowView[];
  canBook: boolean;
}) {
  const label = PROVIDER_LABELS[provider];
  // Allow Vestiarion to book payments goes through the connect page again, which keeps the connection's bills and links.
  const connectHref = `/integrations/${provider}/connect?org=${orgSlug}`;
  const approvable = toReview.filter((row) => row.fingerprint !== null).map((row) => row.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(approvable.slice(0, MAX)));
  const ticked = toReview.filter((row) => row.fingerprint !== null && selected.has(row.id)).slice(0, MAX);
  const { state, formProps } = useActionForm(approveBookingsAction, INITIAL, { toastOnSuccess: true });
  if (toReview.length === 0 && done.length === 0) return null;
  const title = toReview.length === 1 ? `To book in ${label}: 1 payment` : `To book in ${label}: ${toReview.length} payments`;

  return (
    <section aria-labelledby={`to-book-${provider}-title`} id={`to-book-${provider}`} className="mb-8">
      <SectionHeader id={`to-book-${provider}-title`} title={title} meta={`${organisation ? `${organisation} · ` : ""}nothing is written to ${label} until you approve it`} />
      <Card className="space-y-4 p-5">
        {scopeMissing && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-held-line bg-held-soft px-4 py-3">
            <p className="max-w-prose text-sm text-ink">
              {label} has not allowed Vestiarion to book payments yet. Connecting again asks {label} for it; the bills, links and the account chosen are kept.
            </p>
            {canBook && (
              <Button asChild size="sm">
                <Link href={connectHref}>
                  <Link2 aria-hidden />
                  Allow Vestiarion to book payments
                </Link>
              </Button>
            )}
          </div>
        )}
        {!accountChosen && (
          <p className="text-sm text-held">
            Choose where payments are booked, under {label} in{" "}
            <Link className="font-medium underline underline-offset-4" href={`/o/${orgSlug}/settings#${provider}`}>
              Settings
            </Link>
            , before approving these.
          </p>
        )}
        {toReview.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {toReview.map((row) => {
              const name = `${row.supplier}${row.billNumber ? ` · bill ${row.billNumber}` : ""}`;
              const summary = `${money(row.amount, row.currency)} paid on ${utcDay(`${row.paidOn}T12:00:00.000Z`)}`;
              return (
                <li key={row.id} className="space-y-2 px-4 py-3">
                  {canBook && row.fingerprint ? (
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                      label={<span className="font-semibold text-ink">{name}</span>}
                      description={summary}
                    />
                  ) : (
                    <div className="text-sm">
                      <p className="font-semibold text-ink">{name}</p>
                      <p className="text-xs text-ink-3">{summary}</p>
                    </div>
                  )}
                  <div className={canBook && row.fingerprint ? "space-y-2 pl-8" : "space-y-2"}>
                    <Diff row={row} label={label} />
                    <ArcLine row={row} />
                    {(row.blocked || row.state !== "draft") && (
                      <p className={row.state === "sent" || row.state === "sending" ? "text-xs text-ink-2" : "text-xs text-held"}>{row.blocked ?? row.words}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {toReview.length > 0 &&
          (canBook ? (
            <form {...formProps} className="space-y-2">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="connectionId" value={connectionId} />
              {ticked.map((row) => (
                <input key={row.id} type="hidden" name="booking" value={`${row.id}:${row.fingerprint}`} />
              ))}
              <SubmitButton size="sm" pendingLabel={`Booking in ${label}…`} icon={<BookCheck aria-hidden />} disabled={ticked.length === 0}>
                Approve and book
              </SubmitButton>
              <p className="max-w-prose text-xs leading-5 text-ink-3">
                Each one is read again before it is sent: if anything changed since this page was read, it is not sent. Payments in shadow mode and on Arc testnet are
                booked only into a {label} demo company, never into your real books. At most {MAX} at a time.
              </p>
              <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
            </form>
          ) : (
            <p className="text-sm text-ink-3">An owner, admin or accountant approves bookings in {label}.</p>
          ))}
        {done.length > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Booked, and not booked</p>
            <ul className="space-y-1 text-sm">
              {done.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-ink-2">
                    {row.supplier}
                    {row.billNumber ? ` · ${row.billNumber}` : ""} · {money(row.amount, row.currency)}:
                  </span>
                  {row.state === "confirmed" ? (
                    <Badge size="sm" tone="proof" icon={<BookCheck aria-hidden />}>
                      {row.words}
                      {row.paymentId ? ` · ${shortPaymentId(row.paymentId)}` : ""}
                    </Badge>
                  ) : (
                    <span className="text-held">{row.words}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}
