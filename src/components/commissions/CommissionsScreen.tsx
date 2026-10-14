import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { amountWords, rateTyped, reviewCommissions } from "@/lib/commissions/model";
import type { CommissionsData } from "@/lib/commissions/read";
import { CommissionPlanForm, CreatePayableButton, EndPlanButton } from "./CommissionForms";
import { EndedPlans, NoCommissionsYet, PartnerReviewCard, PlanCard, PlanTerms } from "./CommissionViews";

/** What the page says it is, above its plans; /docs-shots/commissions says the same. */
export const COMMISSIONS_SUB =
  "What each partner earns on money your customers paid on Arc, applied to the invoices of the deals their plan covers. Each commission is held for its window, then paid as one payable the agent decides like any other bill.";

/**
 * The commissions page's body (docs/superpowers/specs/2026-10-14-commissions-design.md C10, C11), from what was read:
 * the plans in force with New plan, Change plan and End plan for an owner or admin; the ended plans; then each partner's
 * review with Create payable. A person a plan names as the partner sees their own commissions and changes none of
 * them. The page and /docs-shots/commissions render the same.
 */
export function CommissionsScreen({
  orgSlug,
  read,
  canWrite,
  viewerId,
  members,
  now,
  invoiceHref,
}: {
  orgSlug: string;
  read: CommissionsData;
  canWrite: boolean;
  viewerId: string;
  /** The workspace's members, for an owner or admin; null when not read. */
  members: Array<{ userId: string; email: string }> | null;
  now: Date;
  invoiceHref: (invoiceId: string) => string;
}) {
  const names = new Map(read.counterparties.map((counterparty) => [counterparty.id, counterparty.name]));
  const dealTitles = new Map(read.deals.map((deal) => [deal.id, deal.title]));
  const emails = new Map((members ?? []).map((member) => [member.userId, member.email]));
  const active = read.plans.filter((plan) => plan.endedAt === null);
  const ended = read.plans.filter((plan) => plan.endedAt !== null);
  // Every partner a plan ever named this person as: their own commissions (C11).
  const own = new Set(read.plans.filter((plan) => plan.memberId === viewerId).map((plan) => plan.beneficiaryId));
  const withPlan = new Set(active.map((plan) => plan.beneficiaryId));
  const partners = read.counterparties.filter((counterparty) => (counterparty.role === "vendor" || counterparty.role === "contractor") && !withPlan.has(counterparty.id));
  const dealOptions = read.deals.filter((deal) => deal.status === "active").map(({ id, title, customer }) => ({ id, title, customer }));
  const order = [...read.counterparties].sort((a, b) => a.name.localeCompare(b.name)).map((counterparty) => counterparty.id);
  const reviews = reviewCommissions(read.lines, read.payouts, now, order);

  return (
    <>
      <section aria-labelledby="commission-plans" className="mb-10">
        <SectionHeader id="commission-plans" title="Plans" meta={active.length === 1 ? "1 in force" : `${active.length} in force`} />
        {canWrite ? (
          <IntakeFold label="New plan" meta="a partner, a rate, the deals it covers and a hold window" defaultOpen={active.length === 0} className="mb-6">
            {partners.length === 0 ? (
              <p className="text-sm text-ink-2">Every vendor and contractor has a plan, or there is none yet. Add the partner on Counterparties as a vendor or contractor first.</p>
            ) : (
              <CommissionPlanForm orgSlug={orgSlug} partners={partners.map(({ id, name }) => ({ id, name }))} deals={dealOptions} members={members} />
            )}
          </IntakeFold>
        ) : (
          <Callout className="mb-6">Only an owner or admin of this workspace can set a commission plan or create a payable from it.</Callout>
        )}
        {active.length > 0 && (
          <ul className="grid gap-4 lg:grid-cols-2">
            {active.map((plan) => {
              const partner = names.get(plan.beneficiaryId) ?? "A partner";
              const controls = !canWrite ? undefined : own.has(plan.beneficiaryId) ? (
                <p className="text-sm text-ink-2">This is your own commission, so someone else changes its plan.</p>
              ) : (
                <div className="w-full space-y-3">
                  <IntakeFold label="Change plan" meta="saved as its next version" className="">
                    <CommissionPlanForm
                      orgSlug={orgSlug}
                      partners={[]}
                      deals={dealOptions}
                      members={members}
                      current={{
                        planId: plan.id,
                        beneficiaryId: plan.beneficiaryId,
                        beneficiaryName: partner,
                        rate: rateTyped(plan.rateBps),
                        basis: plan.basis,
                        scope: plan.scope,
                        dealIds: plan.dealIds,
                        holdDays: plan.holdDays,
                        reference: plan.reference ?? "",
                        memberId: plan.memberId,
                      }}
                    />
                  </IntakeFold>
                  <EndPlanButton orgSlug={orgSlug} planId={plan.id} partner={partner} />
                </div>
              );
              return (
                <PlanCard
                  key={plan.id}
                  partner={partner}
                  plan={plan}
                  terms={<PlanTerms plan={plan} dealTitles={dealTitles} memberEmail={plan.memberId ? (emails.get(plan.memberId) ?? null) : null} />}
                  controls={controls}
                />
              );
            })}
          </ul>
        )}
        {ended.length > 0 && (
          <Disclosure className="mt-6" summary={<span className="text-sm font-medium text-ink">Ended plans</span>}>
            <EndedPlans plans={ended} names={names} />
          </Disclosure>
        )}
      </section>

      <section aria-labelledby="commission-review">
        <SectionHeader id="commission-review" title="To review" meta="due now, held, and in payables" />
        {reviews.length === 0 ? (
          <NoCommissionsYet hasPlans={read.plans.length > 0} />
        ) : (
          <ul className="space-y-4">
            {reviews.map((review) => {
              const partner = names.get(review.beneficiaryId) ?? "A partner";
              const mine = own.has(review.beneficiaryId);
              const action =
                review.payable && canWrite && !mine ? (
                  <CreatePayableButton
                    orgSlug={orgSlug}
                    beneficiaryId={review.beneficiaryId}
                    partner={partner}
                    currency={review.currency}
                    lineIds={review.due.map((line) => line.id)}
                    amount={amountWords(review.dueTotal, review.currency)}
                  />
                ) : undefined;
              return (
                <PartnerReviewCard
                  key={`${review.beneficiaryId}:${review.currency}`}
                  review={review}
                  partner={partner}
                  receivables={read.receivables}
                  dealTitles={dealTitles}
                  receivableHref={invoiceHref}
                  payableHref={invoiceHref}
                  action={action}
                  note={review.payable && mine ? "These are your own commissions, so someone else creates their payable and approves it." : undefined}
                />
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
