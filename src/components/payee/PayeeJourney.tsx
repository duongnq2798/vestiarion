import { ArrowUpRight, CircleCheck, Clock3 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import PayeeAddressForm from "@/components/PayeeAddressForm";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Hash, Money } from "@/components/vx/Primitives";
import { utcDay, utcMinute } from "@/lib/copy";
import { amountsLine, maskAddress, payeeStage, paymentState, type PayeeLinkStatus, type PayeePayment, type PaymentTone, type PayeeStage } from "@/lib/payee-journey";
import { chainById, homeChain, networkOfChain, paidAcrossChains } from "@/lib/payee-chains";
import { passkeyWalletConfig, passkeyWalletOffered } from "@/lib/passkey-wallet";
import { PayeeSteps } from "./PayeeSteps";

/**
 * A payee link's page, one screen per step (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md
 * §4): the address, the business confirming it, the payments, and the confirmation once paid. Each
 * screen names its step and has at most one primary action; a screen waiting on someone else
 * refreshes itself (R5).
 */

/** Only the page knows its link; the screens are the same for a screenshot, which has none. */
export const PAYEE_REFRESH_MS = 30_000;

export const NO_SECRETS = "Vestiarion only needs your address. It never asks for your recovery phrase or private key.";


const TONE: Record<PaymentTone, "neutral" | "agent" | "held" | "proof"> = { waiting: "neutral", progress: "agent", review: "held", done: "proof" };

export function PayeeJourney({ token, status, refresh = true }: { token: string; status: PayeeLinkStatus; refresh?: boolean }) {
  const stage = payeeStage(status);
  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
      <PayeeSteps stage={stage} />
      <div className="mt-5">
        {stage === "address" && <AddressStep token={token} status={status} />}
        {stage === "confirming" && <ConfirmingStep status={status} />}
        {stage === "paying" && <PayingStep status={status} />}
        {stage === "paid" && <PaidStep status={status} />}
      </div>
      {refresh && waitsOnSomeone(stage) && <AutoRefresh intervalMs={PAYEE_REFRESH_MS} />}
    </section>
  );
}

const waitsOnSomeone = (stage: PayeeStage) => stage === "confirming" || stage === "paying";

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{children}</h1>;
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-ink-3">{children}</p>;
}

function AddressStep({ token, status }: { token: string; status: PayeeLinkStatus }) {
  const chain = chainById(status.chain).label;
  const owed = amountsLine(status.payments);
  // A passkey wallet, the secondary way, for a payee paid on Arc testnet when Modular Wallets are set up (P1, P6).
  const passkey = passkeyWalletOffered(status.chain, passkeyWalletConfig());
  return (
    <>
      <Heading>
        {status.orgName} wants to pay you{owed ? ` ${owed}` : ""}
      </Heading>
      <p className="mt-2 text-sm text-ink-2">
        For {status.payeeName}, on {chain}.
      </p>
      {status.payments.length > 0 && <PaymentList payments={status.payments} />}
      <div className="mt-5">
        <PayeeAddressForm
          token={token}
          chainLabel={chain}
          orgName={status.orgName}
          passkey={passkey}
          intro={
            <ol className="mb-2 grid gap-2 text-sm leading-6 text-ink-2">
              <HowStep n={1}>Add the wallet address you want to be paid at.</HowStep>
              <HowStep n={2}>{status.orgName} confirms it. A person checks every new address before money is sent to it.</HowStep>
              <HowStep n={3}>You&apos;re paid on {chain}, usually within a minute of that.</HowStep>
            </ol>
          }
        />
      </div>
      <Footnote>
        No account or fee needed. {NO_SECRETS} This link expires on {utcDay(status.expiresAt)}.
      </Footnote>
    </>
  );
}

function HowStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-agent-soft text-xs font-semibold text-agent">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function ConfirmingStep({ status }: { status: PayeeLinkStatus }) {
  if (!status.address) {
    return (
      <>
        <Heading>{status.orgName} needs your address again</Heading>
        <p className="mt-3 text-sm leading-6 text-ink-2">The address you sent is no longer on file. Ask {status.orgName} for a new link.</p>
      </>
    );
  }
  return (
    <>
      <Heading>Address sent. {status.orgName} confirms it next.</Heading>
      <div role="status" className="mt-4 flex items-start gap-3 rounded-xl border border-line bg-raised px-4 py-3">
        <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="text-sm">
          <p className="font-medium text-ink">Waiting for {status.orgName} to confirm</p>
          <p className="mt-0.5 font-mono text-xs text-ink-3">{maskAddress(status.address)}</p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-ink-2">
        A person at {status.orgName} checks every new address before any money is sent to it. Once they confirm yours, you&apos;re paid, usually within a minute.
      </p>
      {status.payments.length > 0 && <PaymentList payments={status.payments} />}
      <Footnote>
        Keep this link. It shows your payment&apos;s status until {utcDay(status.statusUntil)}, and this page updates by itself. {NO_SECRETS}
      </Footnote>
    </>
  );
}

function PayingStep({ status }: { status: PayeeLinkStatus }) {
  const inReview = status.payments.some((payment) => paymentState(payment, status.orgName).tone === "review");
  return (
    <>
      <Heading>Your address is confirmed</Heading>
      <p className="mt-3 text-sm leading-6 text-ink-2">
        {status.orgName} pays you at <span className="font-mono">{maskAddress(status.address ?? "")}</span> on {chainById(status.chain).label}.
      </p>
      {status.payments.length > 0 ? (
        <PaymentList payments={status.payments} orgName={status.orgName} withState />
      ) : (
        <p className="mt-4 text-sm leading-6 text-ink-2">Nothing is due to you yet. A payment {status.orgName} adds for you shows here.</p>
      )}
      {inReview && (
        <Callout tone="held" className="mt-4">
          {status.orgName} is reviewing a payment before it is sent. You don&apos;t need to do anything; if you have questions, ask {status.orgName}.
        </Callout>
      )}
      <Footnote>This page updates by itself until {utcDay(status.statusUntil)}.</Footnote>
    </>
  );
}

function PaidStep({ status }: { status: PayeeLinkStatus }) {
  const paid = [...status.payments].sort((a, b) => (a.settledAt ?? "").localeCompare(b.settledAt ?? ""));
  const latest = paid[paid.length - 1];
  const chain = chainById(status.chain).label;
  const onArc = !paidAcrossChains(status.chain);
  // The link's chain is on one network, whose explorer shows the payment (network threading P1, P6).
  const explorerTx = homeChain(networkOfChain(status.chain)).explorerTx;
  const latestTx = latest?.txRef?.startsWith("0x") ? latest.txRef : null;
  return (
    <>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-proof">
        <CircleCheck aria-hidden className="size-4" />
        Paid
      </p>
      <Heading>You&apos;ve been paid {amountsLine(paid)}</Heading>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
        <ReceiptRow term="From">{status.orgName}</ReceiptRow>
        <ReceiptRow term="For">{paid.map((payment) => payment.title).join(", ")}</ReceiptRow>
        <ReceiptRow term="To">
          <span className="font-mono">{maskAddress(status.address ?? "")}</span>
        </ReceiptRow>
        <ReceiptRow term="Network">{chain}</ReceiptRow>
        {latest?.settledAt && <ReceiptRow term="Paid on">{utcMinute(latest.settledAt)}</ReceiptRow>}
        {paid.map((payment, index) =>
          payment.txRef?.startsWith("0x") ? (
            <ReceiptRow key={index} term={paid.length > 1 ? `Transaction ${index + 1}` : "Transaction"}>
              <Hash value={payment.txRef} href={`${explorerTx}${payment.txRef}`} />
            </ReceiptRow>
          ) : null
        )}
      </dl>
      {latestTx && (
        <Button asChild className="mt-6 w-full">
          <a href={`${explorerTx}${latestTx}`} target="_blank" rel="noreferrer">
            View on Arcscan
            <ArrowUpRight aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
      )}
      <Footnote>
        Not in your wallet yet? Check that your wallet shows {chain} and its USDC.{" "}
        {onArc
          ? "A payment on Arc testnet is final within seconds; the transaction above is the record that it was sent."
          : `It was sent from Arc testnet and arrives on ${chain} a few minutes later; the transaction above is the record that it was sent.`}
        {passkeyWalletOffered(status.chain, passkeyWalletConfig()) && (
          <>
            {" "}
            Made your wallet with a passkey on this page?{" "}
            <Link href="/wallet" className="font-medium text-agent underline-offset-4 hover:underline">
              Open your wallet
            </Link>
            .
          </>
        )}
      </Footnote>
    </>
  );
}

function ReceiptRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

function PaymentList({ payments, orgName = "", withState = false }: { payments: PayeePayment[]; orgName?: string; withState?: boolean }) {
  return (
    <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
      {payments.map((payment, index) => {
        const state = paymentState(payment, orgName);
        return (
          <li key={index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
            <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{payment.title}</span>
            <span className="flex shrink-0 items-center gap-2">
              <Money value={payment.amount} token={payment.currency} className="text-ink" />
              {withState && (
                <Badge tone={TONE[state.tone]} size="sm" dot>
                  {state.label}
                </Badge>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
