import { RecurringPayablesList } from "@/components/intake/RecurringPayableIntake";
import { Disclosure } from "@/components/ui/Disclosure";
import { utcDay } from "@/lib/copy";
import type { RecurringPayableView } from "@/lib/recurring-payables";
import { Money } from "./Primitives";

/**
 * The recurring schedules, folded to one line: how many run and which period falls due next. They change rarely,
 * so they sit under the payables they create, not above them; opening the line lists each, with Stop.
 */
export function RecurringSummary({ schedules, orgSlug, canWrite }: { schedules: RecurringPayableView[]; orgSlug: string; canWrite: boolean }) {
  const active = schedules.filter((schedule) => schedule.status === "active");
  const next = active.filter((schedule) => schedule.nextDueOn !== null).sort((a, b) => (a.nextDueOn as string).localeCompare(b.nextDueOn as string))[0];
  return (
    <Disclosure
      summary={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-ink">Recurring payments</span>
          <span className="text-[0.8125rem] font-normal text-ink-3">
            {active.length} active
            {next?.nextDueOn && (
              <>
                {" · next: "}
                {next.counterpartyName}, {utcDay(`${next.nextDueOn}T00:00:00Z`)}, <Money value={next.amount} token={next.currency} />
              </>
            )}
          </span>
        </span>
      }
    >
      <p className="mb-3 text-[0.8125rem] text-ink-3">Each period&apos;s invoice is created as it comes near, and decided like any other.</p>
      <RecurringPayablesList schedules={schedules} orgSlug={orgSlug} canWrite={canWrite} />
    </Disclosure>
  );
}
