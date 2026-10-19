import { ArrowUpRight, CircleCheck, Clock3, FileCheck2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import PayeeAddressForm from "@/components/PayeeAddressForm";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { Hash, Money } from "@/components/vx/Primitives";
import { utcDay, utcMinute } from "@/lib/copy";
import { SIMULATED_PAYMENT } from "@/lib/capability";
import { amountsLine, invoiceOpen, maskAddress, payeeStage, paymentSimulated, paymentState, type PayeeLinkStatus, type PayeePayment, type PaymentTone, type PayeeStage } from "@/lib/payee-journey";
import { yearAfter } from "@/lib/payee-invoice";
import { chainById, homeChain, networkOfChain, paidAcrossChains } from "@/lib/payee-chains";
import { passkeyWalletConfig, passkeyWalletOffered } from "@/lib/passkey-wallet";
import PayeeInvoiceForm from "./PayeeInvoiceForm";
import { PayeeSteps } from "./PayeeSteps";

/**
 * A payee link's page, one screen per step (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md
 * §4): the address, the business confirming it, the payments, and the confirmation once paid. Each
 * screen names its step and has at most one primary action; a screen waiting on someone else
 * refreshes itself (R5). A payment from a sandbox that simulates its payments is said to be simulated on every screen,
 * in the words the workspace's own pages use (capability and reasons R5): `simulated` from the workspace's capability,
 * and each paid payment's own reference besides.
 *
 * A link may also let the payee choose where it is paid, before its address, and ask for its invoice, after it
 * (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P2, P4): the invoice is a step of its own, and the
 * screens after it say it was sent.
 */

/** Only the page knows its link; the screens are the same for a screenshot, which has none. */
export const PAYEE_REFRESH_MS = 30_000;

export const NO_SECRETS = "Vestiarion only needs your address. It never asks for your recovery phrase or private key.";


const TONE: Record<PaymentTone, "neutral" | "agent" | "held" | "proof"> = { waiting: "neutral", progress: "agent", review: "held", done: "proof" };

export function PayeeJourney({ token, status, refresh = true, simulated = false }: { token: string; status: PayeeLinkStatus; refresh?: boolean; simulated?: boolean }) {
  const stage = payeeStage(status);
  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
      <PayeeSteps stage={stage} withInvoice={status.asksInvoice === true} invoicePending={invoiceOpen(status)} />
      <div className="mt-5">
        {stage === "address" && <AddressStep token={token} status={status} simulated={simulated} />}
        {stage === "invoice" && <InvoiceStep token={token} status={status} />}
        {stage === "confirming" && <ConfirmingStep status={status} />}
        {stage === "paying" && <PayingStep status={status} simulated={simulated} />}
        {stage === "paid" && <PaidStep status={status} simulated={simulated} />}
        {(stage === "paying" || stage === "paid") && <InvoiceStillOpen token={token} status={status} />}
      </div>
      {refresh && waitsOnSomeone(stage) && <AutoRefresh intervalMs={PAYEE_REFRESH_MS} />}
    </section>
  );
}

// The invoice step refreshes too, so a confirmation or a payment shows there as it happens; a half-typed form stays.
const waitsOnSomeone = (stage: PayeeStage) => stage === "invoice" || stage === "confirming" || stage === "paying";

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{children}</h1>;
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-ink-3">{children}</p>;
}

function AddressStep({ token, status, simulated }: { token: string; status: PayeeLinkStatus; simulated: boolean }) {
  const chain = chainById(status.chain).label;
  const owed = amountsLine(status.payments);
  const config = passkeyWalletConfig();
  // A passkey wallet, the secondary way, for a payee paid on Arc testnet when Modular Wallets are set up (P1, P6).
  const passkey = passkeyWalletOffered(status.chain, config);
  // The chains the payee may choose among, when the link lets it (payee invoice link P2).
  const choices = (status.chainChoices ?? []).map((id) => ({ id, label: chainById(id).label }));
  const choosing = choices.length > 1;
  const asksInvoice = status.asksInvoice === true;
  const steps = [
    choosing ? "Choose where your wallet receives USDC, then add its address." : "Add the wallet address you want to be paid at.",
    ...(asksInvoice ? ["Send your invoice. It waits for a person to check it."] : []),
    `${status.orgName} confirms it. A person checks every new address before money is sent to it.`,
    simulated
      ? "You're paid, simulated, usually within a minute of that: no USDC is sent."
      : choosing
        ? "You're paid on the network you chose, usually within a minute of that."
        : `You're paid on ${chain}, usually within a minute of that.`,
  ];
  return (
    <>
      <Heading>
        {status.orgName} wants to pay you{owed ? ` ${owed}` : ""}
      </Heading>
      <p className="mt-2 text-sm text-ink-2">
        {simulated ? `For ${status.payeeName}. ${SIMULATED_PAYMENT}` : choosing ? `For ${status.payeeName}.` : `For ${status.payeeName}, on ${chain}.`}
      </p>
      {status.payments.length > 0 && <PaymentList payments={status.payments} />}
      <div className="mt-5">
        <PayeeAddressForm
          token={token}
          chainLabel={chain}
          orgName={status.orgName}
          passkey={passkey}
          {...(choosing
            ? { chains: choices, defaultChain: status.chain, passkeyChains: choices.filter((entry) => passkeyWalletOffered(entry.id, config)).map((entry) => entry.id) }
            : {})}
          {...(asksInvoice && status.address && !status.addressMirror ? { keep: { masked: maskAddress(status.address) } } : {})}
          intro={
            <ol className="mb-2 grid gap-2 text-sm leading-6 text-ink-2">
              {steps.map((step, index) => (
                <HowStep key={index} n={index + 1}>
                  {step}
                </HowStep>
              ))}
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

/**
 * The payee's invoice, on a link that asks for it (payee invoice link P4): after the address step, or alone once the
 * address on file was kept. It waits for a person at the business, who adds it as a bill or discards it.
 */
function InvoiceStep({ token, status }: { token: string; status: PayeeLinkStatus }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Heading>Send {status.orgName} your invoice</Heading>
      <p className="mt-2 text-sm leading-6 text-ink-2">
        {status.address
          ? status.addressConfirmed
            ? `${status.orgName} pays you at ${maskAddress(status.address)}.`
            : `Address sent: ${maskAddress(status.address)}. ${status.orgName} confirms it before paying you.`
          : `${status.orgName} has no address for you on file yet.`}
      </p>
      {status.payments.length > 0 && <PaymentList payments={status.payments} />}
      <div className="mt-5">
        <PayeeInvoiceForm token={token} orgName={status.orgName} today={today} lastDay={yearAfter(today)} />
      </div>
      <Footnote>
        {NO_SECRETS} This link takes your invoice until {utcDay(status.statusUntil)}.
      </Footnote>
    </>
  );
}

/**
 * Under a payment on its way or paid, on a link that still takes the payee's invoice: the form, folded, second to the
 * payment's state (P4).
 */
function InvoiceStillOpen({ token, status }: { token: string; status: PayeeLinkStatus }) {
  if (!invoiceOpen(status)) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Disclosure summary="You can still send your invoice" className="mt-5">
      <PayeeInvoiceForm token={token} orgName={status.orgName} today={today} lastDay={yearAfter(today)} />
    </Disclosure>
  );
}

/** On the screens after the invoice step: it was sent, and waits for a person (P5). */
function InvoiceSent({ status }: { status: PayeeLinkStatus }) {
  if (!status.asksInvoice || !status.invoiceSent) return null;
  return (
    <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-ink-2">
      <FileCheck2 aria-hidden className="mt-1 size-4 shrink-0 text-proof" />
      <span>Invoice sent. {status.orgName} checks it before adding it.</span>
    </p>
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
      <InvoiceSent status={status} />
      {status.payments.length > 0 && <PaymentList payments={status.payments} />}
      <Footnote>
        Keep this link. It shows your payment&apos;s status until {utcDay(status.statusUntil)}, and this page updates by itself. {NO_SECRETS}
      </Footnote>
    </>
  );
}

function PayingStep({ status, simulated }: { status: PayeeLinkStatus; simulated: boolean }) {
  const inReview = status.payments.some((payment) => paymentState(payment, status.orgName).tone === "review");
  return (
    <>
      <Heading>Your address is confirmed</Heading>
      <p className="mt-3 text-sm leading-6 text-ink-2">
        {status.orgName} pays you at <span className="font-mono">{maskAddress(status.address ?? "")}</span>
        {simulated ? ", simulated: no USDC is sent." : ` on ${chainById(status.chain).label}.`}
      </p>
      <InvoiceSent status={status} />
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

function PaidStep({ status, simulated: workspaceSimulates }: { status: PayeeLinkStatus; simulated: boolean }) {
  const paid = [...status.payments].sort((a, b) => (a.settledAt ?? "").localeCompare(b.settledAt ?? ""));
  // Each payment's own record first: one with a transaction on chain was real, every one the simulator's was simulated;
  // without either, the workspace's capability says.
  const onChain = paid.some((payment) => payment.txRef?.startsWith("0x"));
  const simulated = !onChain && ((paid.length > 0 && paid.every(paymentSimulated)) || workspaceSimulates);
  const latest = paid[paid.length - 1];
  const chain = chainById(status.chain).label;
  const onArc = !paidAcrossChains(status.chain);
  // The link's chain is on one network, whose explorer shows the payment (network threading P1, P6).
  const explorerTx = homeChain(networkOfChain(status.chain)).explorerTx;
  // The network the payment was sent on, by name (mainnet copy C1).
  const home = homeChain(networkOfChain(status.chain)).label;
  const latestTx = latest?.txRef?.startsWith("0x") ? latest.txRef : null;
  return (
    <>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-proof">
        <CircleCheck aria-hidden className="size-4" />
        {simulated ? "Paid (simulated)" : "Paid"}
      </p>
      <Heading>You&apos;ve been paid {amountsLine(paid)}</Heading>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
        <ReceiptRow term="From">{status.orgName}</ReceiptRow>
        <ReceiptRow term="For">{paid.map((payment) => payment.title).join(", ")}</ReceiptRow>
        <ReceiptRow term="To">
          <span className="font-mono">{maskAddress(status.address ?? "")}</span>
        </ReceiptRow>
        <ReceiptRow term="Network">{simulated ? "Simulated: no USDC was sent" : chain}</ReceiptRow>
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
            View the transaction
            <ArrowUpRight aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
      )}
      {simulated ? (
        <Footnote>{`This payment was simulated by ${status.orgName}'s sandbox workspace: no USDC was sent to your wallet.`}</Footnote>
      ) : (
        <Footnote>
          Not in your wallet yet? Check that your wallet shows {chain} and its USDC.{" "}
          {onArc
            ? `A payment on ${home} is final within seconds; the transaction above is the record that it was sent.`
            : `It was sent from ${home} and arrives on ${chain} a few minutes later; the transaction above is the record that it was sent.`}
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
      )}
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
