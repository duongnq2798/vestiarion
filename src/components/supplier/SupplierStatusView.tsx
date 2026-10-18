import { CircleCheck, Clock3, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import type { Standing, SupplierBillView, SupplierStatusView as View } from "@/lib/supplier-status/model";

/**
 * A supplier's payment status (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2, V5): what is still to be
 * paid in each currency, each open bill with where it stands, and what was paid recently with its transaction. It names
 * only what the supplier already knows: the business, itself and its own bills. It never says why a bill is held. One
 * column at every width, so it reads the same on a phone.
 */

const TONE: Record<Standing, "neutral" | "agent" | "proof"> = {
  received: "neutral",
  reviewing: "neutral",
  scheduled: "agent",
  on_its_way: "agent",
  paid: "proof",
};

export function SupplierStatusView({ view }: { view: View }) {
  return (
    <article className="space-y-8" aria-labelledby="supplier-status-title">
      <header className="space-y-2">
        <p>
          <Eyebrow className="text-agent">Payment status</Eyebrow>
        </p>
        <h1 id="supplier-status-title" className="text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">
          {view.orgName}&rsquo;s payments to {view.supplierName}
        </h1>
        <p className="text-sm text-ink-2">
          As of {view.asOf}. This link works until {view.until}.
        </p>
      </header>

      <section aria-label="Still to be paid" className="grid gap-3 sm:grid-cols-2">
        {view.stillToBePaid.length === 0 ? (
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-surface sm:col-span-2">
            <p className="flex items-center gap-2 text-sm font-medium text-proof">
              <CircleCheck aria-hidden className="size-4" />
              Nothing is waiting to be paid.
            </p>
          </div>
        ) : (
          view.stillToBePaid.map((total) => (
            <div key={total} className="rounded-2xl border border-line bg-surface p-5 shadow-surface">
              <Eyebrow>Still to be paid</Eyebrow>
              <p className="mt-1 text-3xl font-semibold tabular-nums tracking-[-0.02em] text-ink">{total}</p>
            </div>
          ))
        )}
      </section>

      {view.open.length > 0 && (
        <section aria-labelledby="open-bills" className="space-y-3">
          <h2 id="open-bills" className="text-lg font-semibold text-ink">
            Your open bills
          </h2>
          <ul className="space-y-3">
            {view.open.map((bill) => (
              <li key={bill.id}>
                <Bill bill={bill} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.paid.length > 0 && (
        <section aria-labelledby="paid-bills" className="space-y-3">
          <h2 id="paid-bills" className="text-lg font-semibold text-ink">
            Paid recently
          </h2>
          <ul className="space-y-3">
            {view.paid.map((bill) => (
              <li key={bill.id}>
                <Bill bill={bill} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="space-y-2 text-xs leading-5 text-ink-3">
        <p>
          This page shows only your own bills with {view.orgName}, read again each time you open it. Anyone with this link can see it, so share it only
          with the people who handle your payments.
        </p>
        <p>
          {view.orgName} pays its bills through{" "}
          <a href="/?from=supplier-status" className="font-medium text-agent underline-offset-2 hover:underline">
            Vestiarion
          </a>
          , an AI agent for bills and payments. Each payment above links to its transaction.
        </p>
      </div>
    </article>
  );
}

function Bill({ bill }: { bill: SupplierBillView }) {
  return (
    <article aria-labelledby={`bill-${bill.id}`} className="rounded-2xl border border-line bg-surface p-4 shadow-surface sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`bill-${bill.id}`} className="min-w-0 break-words text-base font-semibold text-ink">
          {bill.reference}
        </h3>
        <Badge tone={TONE[bill.standing]} icon={bill.standing === "paid" ? <CircleCheck aria-hidden /> : <Clock3 aria-hidden />}>
          {bill.words}
        </Badge>
      </div>
      <p className="mt-2 text-sm tabular-nums text-ink-2">
        {bill.amount} · due {bill.due}
        {bill.poReference ? ` · purchase order ${bill.poReference}` : ""}
      </p>
      {bill.txUrl && (
        <p className="mt-2 text-sm">
          <a href={bill.txUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-agent underline-offset-2 hover:underline">
            See the payment&rsquo;s transaction
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </p>
      )}
    </article>
  );
}
