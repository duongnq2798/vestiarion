import { explorerTx, Hash } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import type { OurPayment } from "@/lib/platform/open-numbers";
import { formatFigure } from "./OpenNumbersTable";

/**
 * Our own workspaces' latest settled payments, each linked to arcscan (spec
 * R6). A customer's payments are counted in the table and never listed.
 */
export function OurPayments({ payments }: { payments: OurPayment[] }) {
  return (
    <section aria-labelledby="our-payments" className="mt-12">
      <h2 id="our-payments" className="text-xl font-semibold tracking-tight text-ink">
        Payments from our own workspaces
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-2">
        The latest payments the team&apos;s workspaces settled in this period, so any of them can be checked on Arc testnet. Customers&apos; payments are counted above and never listed here.
      </p>
      {payments.length === 0 ? (
        <p className="mt-4 text-sm text-ink-3">Our own workspaces settled no payments in this period.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
          {payments.map((payment) => (
            <li key={payment.txHash} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm">
              <time dateTime={payment.at} className="font-mono text-xs text-ink-3">
                {utcMinute(payment.at)}
              </time>
              <span className="font-mono tabular-nums text-ink">{formatFigure(payment.amount, "usdc")} USDC</span>
              <Hash value={payment.txHash} href={explorerTx(payment.txHash)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
