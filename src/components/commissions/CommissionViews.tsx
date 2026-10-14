import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { utcDay } from "@/lib/copy";
import { amountWords, BASIS_WORDS, formulaWords, ratePercent, type CommissionLine, type CommissionPlan, type PartnerReview } from "@/lib/commissions/model";
import type { CommissionReceivable } from "@/lib/commissions/read";

/**
 * The commissions page's views (docs/superpowers/specs/2026-10-14-commissions-design.md C10): each plan in force, and
 * each partner's review per currency, every line with its formula. Server components: the forms they hold are the
 * client's.
 */

/** Where a commission payable stands, in words, from its bill's status. */
export function payableStanding(status: string | null): { label: string; tone: "agent" | "proof" | "held" | "refused" | "neutral" } {
  switch (status) {
    case "paid":
      return { label: "Paid", tone: "proof" };
    case "matched":
      return { label: "Payment in flight", tone: "agent" };
    case "scheduled":
      return { label: "Scheduled", tone: "agent" };
    case "held":
    case "flagged":
    case "awaiting_info":
    case "processing":
      return { label: "Waiting in Approvals", tone: "held" };
    case "rejected":
      return { label: "Rejected: back to review", tone: "refused" };
    case null:
      return { label: "Removed", tone: "neutral" };
    default:
      return { label: "Waiting for the agent", tone: "agent" };
  }
}

const day = (iso: string) => utcDay(iso);

/** What a plan says, in a few short lines. */
export function PlanTerms({ plan, dealTitles, memberEmail }: { plan: CommissionPlan; dealTitles: Map<string, string>; memberEmail: string | null }) {
  const deals = plan.scope === "all_deals" ? "Every deal" : plan.dealIds.map((id) => dealTitles.get(id) ?? "A deal no longer listed").join(", ");
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-ink-3">Commission on</dt>
        <dd className="text-ink">{BASIS_WORDS[plan.basis]}</dd>
      </div>
      <div>
        <dt className="text-ink-3">Deals it covers</dt>
        <dd className="text-ink">{deals}</dd>
      </div>
      <div>
        <dt className="text-ink-3">Hold window</dt>
        <dd className="text-ink">{plan.holdDays === 1 ? "1 day" : `${plan.holdDays} days`}</dd>
      </div>
      <div>
        <dt className="text-ink-3">In force since</dt>
        <dd className="text-ink">{day(plan.startedAt)}</dd>
      </div>
      {plan.reference && (
        <div>
          <dt className="text-ink-3">Reference</dt>
          <dd className="text-ink">{plan.reference}</dd>
        </div>
      )}
      {plan.memberId && (
        <div>
          <dt className="text-ink-3">Member who is this partner</dt>
          <dd className="text-ink">{memberEmail ?? "A member"}</dd>
        </div>
      )}
    </dl>
  );
}

/** One plan in force, with its controls for an owner or admin. */
export function PlanCard({ partner, plan, terms, controls }: { partner: string; plan: CommissionPlan; terms: ReactNode; controls?: ReactNode }) {
  return (
    <Card asChild>
      <li>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{partner}</CardTitle>
            <Badge tone="agent">{ratePercent(plan.rateBps)} {plan.basis}</Badge>
          </div>
        </CardHeader>
        <CardContent>{terms}</CardContent>
        {controls && <CardFooter>{controls}</CardFooter>}
      </li>
    </Card>
  );
}

/** The plans that ended, partner by partner, newest first. */
export function EndedPlans({ plans, names }: { plans: CommissionPlan[]; names: Map<string, string> }) {
  if (plans.length === 0) return null;
  return (
    <ul className="divide-y divide-line text-sm">
      {plans.map((plan) => (
        <li key={plan.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
          <span className="text-ink">
            {names.get(plan.beneficiaryId) ?? "A partner"}: {ratePercent(plan.rateBps)} {plan.basis}
          </span>
          <span className="text-ink-3">
            {day(plan.startedAt)} to {plan.endedAt ? day(plan.endedAt) : "now"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One line of a review: when the money was applied, on which invoice, the formula and the amount. */
function LineRow({ line, receivable, deal, after, receivableHref }: { line: CommissionLine; receivable?: CommissionReceivable; deal?: string; after?: ReactNode; receivableHref: (id: string) => string }) {
  const of = receivable ? ` of ${amountWords(receivable.amount, receivable.currency)}` : "";
  return (
    <li className="grid gap-1 py-2.5 sm:grid-cols-[7rem_1fr_auto] sm:gap-4">
      <span className="text-xs text-ink-3 sm:pt-0.5">{day(line.appliedAt)}</span>
      <span className="min-w-0 text-sm">
        <span className="block text-ink">{formulaWords(line)}</span>
        <span className="block text-xs text-ink-3">
          {line.invoiceId ? (
            <Link className="underline decoration-line-strong underline-offset-2 hover:text-ink" href={receivableHref(line.invoiceId)}>
              {receivable?.label ?? "An invoice"}
            </Link>
          ) : (
            "An invoice no longer on file"
          )}
          {of}
          {receivable ? `, ${receivable.customer}` : ""}
          {deal ? ` · ${deal}` : ""}
          {after}
        </span>
      </span>
      <span className={`text-sm font-medium tabular-nums sm:text-right ${line.amount < 0 ? "text-refused" : "text-ink"}`}>
        {line.amount < 0 ? `−${amountWords(-line.amount, line.currency)}` : amountWords(line.amount, line.currency)}
      </span>
    </li>
  );
}

/**
 * A partner's commissions in one currency: what is due now, with Create payable when it adds up to more than zero; what
 * is still held, each with its day; and every payable made, with its status.
 */
export function PartnerReviewCard({
  review,
  partner,
  receivables,
  dealTitles,
  receivableHref,
  payableHref,
  action,
  note,
  warning,
}: {
  review: PartnerReview;
  partner: string;
  receivables: Map<string, CommissionReceivable>;
  dealTitles: Map<string, string>;
  receivableHref: (id: string) => string;
  payableHref: (id: string) => string;
  /** Create payable, for an owner or admin who is not this partner. */
  action?: ReactNode;
  /** Why there is no Create payable for this person, when there is something to pay. */
  note?: string;
  /** What to know before creating the payable, said beside Create payable. */
  warning?: string;
}) {
  const row = (line: CommissionLine, after?: ReactNode) => (
    <LineRow
      key={line.id}
      line={line}
      receivable={line.invoiceId ? receivables.get(line.invoiceId) : undefined}
      deal={line.dealId ? dealTitles.get(line.dealId) : undefined}
      after={after}
      receivableHref={receivableHref}
    />
  );
  const { currency } = review;
  return (
    <Card asChild>
      <li>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>
              {partner} <span className="font-normal text-ink-3">· {currency}</span>
            </CardTitle>
            {review.payable ? <Badge tone="agent">Due now: {amountWords(review.dueTotal, currency)}</Badge> : <Badge>Nothing due now</Badge>}
          </div>
          <CardDescription>
            {review.held.length > 0
              ? `Held: ${amountWords(review.heldTotal, currency)}, the next due ${day(review.nextDueAt as string)}.`
              : "Nothing is held in its window."}
            {review.carriedForward < 0 ? ` Carried forward: −${amountWords(-review.carriedForward, currency)}, taken from the next payable.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {review.due.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-ink">Due now</h4>
              <ul className="divide-y divide-line">{review.due.map((line) => row(line))}</ul>
              {!review.payable && <p className="mt-2 text-sm text-ink-2">{"What is due adds up to zero or less, so there is nothing to pay. It is carried forward to the next payable."}</p>}
            </section>
          )}
          {review.held.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-ink">Held</h4>
              <ul className="divide-y divide-line">{review.held.map((line) => row(line, <> · due {day(line.dueAt)}</>))}</ul>
            </section>
          )}
          {review.paidOut.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-ink">In payables</h4>
              <ul className="divide-y divide-line">
                {review.paidOut.map((payout) => {
                  const standing = payableStanding(payout.invoiceStatus);
                  return (
                    <li key={payout.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-sm">
                      <span className="min-w-0">
                        <Link className="font-medium text-ink underline decoration-line-strong underline-offset-2" href={payableHref(payout.invoiceId)}>
                          {payout.statement}
                        </Link>
                        <span className="text-ink-3">
                          {" "}
                          · {day(payout.createdAt)} · {payout.lineCount === 1 ? "1 line" : `${payout.lineCount} lines`}
                        </span>
                      </span>
                      <span className="flex items-baseline gap-3">
                        <Badge tone={standing.tone} size="sm">
                          {standing.label}
                        </Badge>
                        <span className="font-medium tabular-nums text-ink">{amountWords(payout.amount, payout.currency)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </CardContent>
        {(action || note) && (
          <CardFooter>
            {warning && <p className="w-full text-sm text-held">{warning}</p>}
            {action ?? <p className="text-sm text-ink-2">{note}</p>}
          </CardFooter>
        )}
      </li>
    </Card>
  );
}

/** The way in from Bills & receivables' Receivables tab, under Deals. */
export function CommissionsLink({ href }: { href: string }) {
  return (
    <section aria-labelledby="commissions-link-title">
      <SectionHeader
        id="commissions-link-title"
        title="Commissions"
        meta="on money received for your deals"
        action={
          <Link className="text-sm font-medium text-agent underline-offset-2 hover:underline" href={href}>
            Open commissions
          </Link>
        }
      />
      <p className="text-sm text-ink-2">
        Set what a sales partner or referrer earns on the money customers pay for your deals, review it once its hold window has passed, and pay it as a bill
        the agent decides.
      </p>
    </section>
  );
}

/** Nothing recorded yet: what will show here, and when. */
export function NoCommissionsYet({ hasPlans }: { hasPlans: boolean }) {
  return (
    <EmptyState
      compact
      title="No commissions yet"
      body={
        hasPlans
          ? "A commission is recorded when a customer's payment on Arc is applied to an invoice of a deal a plan covers."
          : "Set a plan for a partner first. Commissions follow money applied to the invoices of the deals it covers."
      }
    />
  );
}
