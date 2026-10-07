import { Disclosure } from "@/components/ui/Disclosure";
import { Hash } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import type { NetworkProfile } from "@/lib/network";
import { chainById, paidAcrossChains } from "@/lib/payee-chains";
import type { OurPayment } from "@/lib/platform/open-numbers";
import { formatFigure } from "./OpenNumbersTable";
import { SectionHead } from "./SectionHead";

/** How many payments show before the rest fold away: past a handful, another hash adds little. */
const SHOWN = 5;

/**
 * Our own workspaces' latest settled payments on one network, each linked to its
 * chain's explorer (spec R6): the newest few, then the rest behind a disclosure.
 * A customer's payments are counted and never listed.
 */
export function OurPayments({ payments, network }: { payments: OurPayment[]; network: NetworkProfile }) {
  const id = `our-payments-${network.id}`;
  const rest = payments.slice(SHOWN);
  return (
    <section aria-labelledby={id}>
      <SectionHead id={id} eyebrow="Verify it yourself" title="Payments you can check on chain">
        The latest payments our own workspaces settled in this period, each linked to the explorer. Customers&apos; payments are counted above and never listed here.
      </SectionHead>
      {payments.length === 0 ? (
        <p className="mt-4 text-sm text-ink-3">Our own workspaces settled no payments in this period.</p>
      ) : (
        <>
          <PaymentList payments={payments.slice(0, SHOWN)} network={network} className="mt-5" />
          {rest.length > 0 && (
            <Disclosure className="mt-3" summary={`Show ${rest.length} more`}>
              <PaymentList payments={rest} network={network} />
            </Disclosure>
          )}
        </>
      )}
    </section>
  );
}

function PaymentList({ payments, network, className }: { payments: OurPayment[]; network: NetworkProfile; className?: string }) {
  return (
    <ul className={`divide-y divide-line rounded-2xl border border-line bg-surface ${className ?? ""}`}>
      {payments.map((payment) => (
        <li key={payment.txHash} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[14rem_1fr_auto]">
          <time dateTime={payment.at} className="font-mono text-xs text-ink-3">
            {utcMinute(payment.at)}
          </time>
          <span className="text-right font-mono font-semibold tabular-nums text-ink sm:text-left">
            {formatFigure(payment.amount, "usdc")} {payment.token ?? "USDC"}
          </span>
          {/* A Gateway payout's hash is its mint on the payee's chain (Gateway payouts G5); everything else is on this network. */}
          <Hash
            className="col-span-2 sm:col-span-1"
            value={payment.txHash}
            href={paidAcrossChains(payment.chain) ? `${chainById(payment.chain as string).explorerTx}${payment.txHash}` : `${network.explorer}/tx/${payment.txHash}`}
          />
        </li>
      ))}
    </ul>
  );
}
