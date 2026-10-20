import { CopyButton } from "@/components/ui/CopyButton";
import { Eyebrow } from "@/components/ui/Eyebrow";
import PaymentCheck from "@/components/PaymentCheck";
import { homeChain, networkOfChain } from "@/lib/payee-chains";
import type { PayLinkPreview } from "@/lib/platform/pay-links";

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
/** The amount as a wallet's field takes it: no thousands separator. */
const PLAIN = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });
/** A "YYYY-MM-DD" day as "Oct 22, 2026". */
const DAY = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * An open invoice on its pay link's page (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2): who asks,
 * how much, by when, for what, on which network, and the address to send it to. Once a payment was applied to the
 * invoice, it asks for what is still owed and says what arrived (docs/superpowers/specs/2026-10-12-allocations-design.md
 * L11).
 *
 * While a discount the client accepted applies (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C5), it asks for the discounted amount and says until when, and what is owed after.
 *
 * On a phone (docs/superpowers/specs/2026-10-13-customer-portal-design.md I16) the amount, with its currency, has its own
 * Copy beside the address's, so a client switching to a wallet app takes both; every button is at least 44 px tall.
 */
export function PayInvoice({
  preview,
  balance,
  token,
  discount = null,
}: {
  preview: PayLinkPreview;
  balance: { owed: number; received: number } | null;
  token: string;
  /** The discount the client accepted, while it applies: what pays the invoice now, and until when (C5). */
  discount?: { owed: number; pct: number; payBy: string; full: number } | null;
}) {
  // A discount is only ever on an invoice nothing was applied to (C2), so it never meets a balance.
  const owed = balance ? balance.owed : discount ? discount.owed : preview.amount;
  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-flat sm:p-8">
      <p>
        <Eyebrow className="text-agent">Invoice</Eyebrow>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">
        {preview.orgName} asks {preview.clientName} to pay {AMOUNT.format(owed)} {preview.currency}
      </h1>
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {balance && (
          <>
            <dt className="text-ink-3">Received</dt>
            <dd className="text-ink">
              {AMOUNT.format(balance.received)} of {AMOUNT.format(preview.amount)} {preview.currency}. This is what is still owed.
            </dd>
          </>
        )}
        {discount && !balance && (
          <>
            <dt className="text-ink-3">Discount</dt>
            <dd className="text-ink">
              {discount.pct.toFixed(2)}% off {AMOUNT.format(discount.full)} {preview.currency}, for paying by the end of {DAY(discount.payBy)} (UTC). After that, the
              invoice is {AMOUNT.format(discount.full)} {preview.currency} again.
            </dd>
          </>
        )}
        <dt className="text-ink-3">Due</dt>
        <dd className="text-ink">{preview.dueDate}</dd>
        {preview.memo && (
          <>
            <dt className="text-ink-3">For</dt>
            <dd className="break-words text-ink">{preview.memo}</dd>
          </>
        )}
        <dt className="text-ink-3">Network</dt>
        <dd className="text-ink">{homeChain(networkOfChain(preview.chain)).label}</dd>
      </dl>
      {preview.payTo ? (
        <div className="mt-5 grid gap-2">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-ground px-3 py-2.5">
            <p className="min-w-0">
              <span className="block text-xs text-ink-3">Amount</span>
              <span className="text-lg font-semibold tabular-nums text-ink">
                {AMOUNT.format(owed)} <span className="text-sm font-medium text-ink-2">{preview.currency}</span>
              </span>
            </p>
            <CopyButton value={PLAIN.format(owed)} label="Copy the amount" variant="secondary" size="md">
              Copy
            </CopyButton>
          </div>
          <p className="mt-2 text-sm font-medium text-ink">Send exactly {AMOUNT.format(owed)} {preview.currency} to</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-ground px-3 py-2 font-mono text-xs text-ink">{preview.payTo}</code>
            <CopyButton value={preview.payTo} label="Copy address" variant="secondary" size="md">
              Copy
            </CopyButton>
          </div>
          <p className="text-xs leading-5 text-ink-3">
            From any wallet on {homeChain(networkOfChain(preview.chain)).label}. Send the exact amount: that is how the payment is matched to this invoice.
          </p>
        </div>
      ) : (
        <p className="mt-5 text-sm text-ink-2">{preview.orgName} has no address to receive payments yet. Ask them before you pay.</p>
      )}
      {preview.payTo && (
        <div className="mt-6 border-t border-line pt-5">
          <PaymentCheck token={token} />
        </div>
      )}
    </section>
  );
}
