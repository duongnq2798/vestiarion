import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, FileText } from "lucide-react";
import { Suspense } from "react";
import { EvidencePending } from "./EvidencePending";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import type { TeamJourney, TeamJourneys } from "@/lib/team-journey";
import { SignatureCheck } from "./SignatureCheck";
import styles from "./BillJourney.module.css";

const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
const STAGES = [
  { verb: "Read", title: "A bill comes in.", detail: "The agent reads the bill and its context: the amount, the supplier and the work agreed." },
  { verb: "Check", title: "Facts before a suggestion.", detail: "It checks the available evidence and explains what it proposes, and why." },
  { verb: "Decide", title: "A reason needs permission.", detail: "Your rules in code can hold a payment for a person. The model cannot override them." },
  { verb: "Pay", title: "Only within your limits.", detail: "A ready bill can be paid in USDC when the required permissions and payment checks allow it." },
  { verb: "Record", title: "A trail you can check.", detail: "Recorded decisions have signed entries. A confirmed payment has a transaction to inspect." },
] as const;
const EVENTS = [
  { key: "received", title: "Bill recorded" },
  { key: "check", title: "Decision recorded" },
  { key: "hold", title: "Hold recorded" },
  { key: "approval", title: "Approval recorded" },
  { key: "record", title: "Payment recorded" },
] as const;

function RecordedTime({ at }: { at: string }) {
  return <time dateTime={at}>{date.format(new Date(at))} UTC</time>;
}

function BillChecks({ bill }: { bill: TeamJourney }) {
  const facts = [
    bill.observed.hasPurchaseOrder === null ? null : bill.observed.hasPurchaseOrder ? "Purchase order recorded" : "No purchase order recorded",
    bill.observed.goodsReceived === null ? null : bill.observed.goodsReceived ? "Goods receipt confirmed" : "Goods receipt not confirmed",
    bill.observed.purchaseOrderRequired === null ? null : bill.observed.purchaseOrderRequired ? "Purchase order required" : "Purchase order not required",
    bill.observed.riskLevel === null ? null : `Screening: ${bill.observed.riskLevel}`,
  ].filter((fact): fact is string => fact !== null);
  if (!facts.length) return null;
  return <ul className={styles.checks}>{facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>;
}

function RecordedBill({ bill }: { bill: TeamJourney }) {
  return (
    <div className={styles.recordGrid}>
      <aside className={styles.billColumn} aria-label="The recorded team payment">
        <div className={styles.bill}>
          <div className={styles.billTop}><Eyebrow>One bill · recorded evidence</Eyebrow><FileText aria-hidden size={19} /></div>
          <div className={styles.billBody}>
            <p className="text-sm font-semibold">Vestiarion team workspace</p>
            <p className={styles.billAmount}>{amount.format(bill.amount)} <span>{bill.currency}</span></p>
            <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-proof"><Check aria-hidden size={16} />Paid on {bill.payment.destination.chain === "BASE" ? "Base" : "Arc mainnet"}</p>
            {bill.payment.confirmationRecordedAt && <p className="mt-5 text-caption leading-relaxed text-ink-2">Payment confirmation recorded<br /><RecordedTime at={bill.payment.confirmationRecordedAt} /></p>}
            <a href={bill.payment.source.url} target="_blank" rel="noopener noreferrer" className={styles.proofLink}>{bill.payment.route === "cctp" ? "Verify the burn on Arc mainnet" : "Verify payment on Arc Explorer"}<ArrowUpRight aria-hidden size={16} /></a>
            {bill.payment.destination.chain === "BASE" && <a href={bill.payment.destination.url} target="_blank" rel="noopener noreferrer" className={styles.proofLink}>Verify the mint on Base<ArrowUpRight aria-hidden size={16} /></a>}
            {bill.payment.feeUsdc !== null && <p className="mt-3 text-caption text-ink-2">Payment fee recorded: {amount.format(bill.payment.feeUsdc)} USDC</p>}
          </div>
          <p className={styles.billFoot}>A payment from a workspace the Vestiarion team runs. Its private names and reasoning stay in the workspace.</p>
        </div>
      </aside>
      <div className="min-w-0">
        <h3 className="text-2xl font-semibold tracking-tight">What this bill&apos;s record shows.</h3>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">Available entries are shown by stage. Recording times can follow the action; they do not establish how long payment took. A missing entry stays unknown.</p>
        <ol className={styles.entries}>
          {EVENTS.map(({ key, title }, index) => {
            const event = bill[key];
            const id = `journey-entry-${key}-${event?.seq ?? "unknown"}`;
            return (
              <li key={key} className={styles.entry}>
                <span className={styles.entryNumber} aria-hidden>0{index + 1}</span>
                <div className="min-w-0">
                  <h4 id={id} className="text-lg font-semibold tracking-tight">{title}</h4>
                  {event ? <>
                    <p className="mt-2 text-caption leading-relaxed text-ink-2"><RecordedTime at={event.recordedAt} /></p>
                    <a href={`#${id}`} className="mt-2 inline-flex min-h-6 items-center text-caption font-medium text-agent underline underline-offset-4">Ledger entry #{event.seq}</a>
                    {key === "check" && <BillChecks bill={bill} />}
                    {key === "hold" && bill.rule && <p className="mt-3 text-sm text-ink-2">Recorded rule: <code className="break-all font-mono text-xs text-ink">{bill.rule}</code></p>}
                    <div className="mt-4"><SignatureCheck link={event.link} publicKeys={bill.publicKeys} describedBy={id} /></div>
                  </> : <p className="mt-2 text-sm leading-relaxed text-ink-2">Not available in this bill&apos;s record</p>}
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-5 text-caption leading-relaxed text-ink-2">A signature check verifies the signed hash link, not the public description or payment settlement.</p>
      </div>
    </div>
  );
}

function BasePayment({ bill }: { bill: TeamJourney }) {
  return (
    <section className={`${styles.base} focus-inverse`} aria-labelledby="journey-base-title">
      <div>
        <Eyebrow inverse>Another team payment · Arc mainnet to Base</Eyebrow>
        <h3 id="journey-base-title" className="mt-4 text-3xl font-semibold tracking-tight">Paid on Base</h3>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-on-agent-muted">Vestiarion team workspace. A confirmed cross-chain payment, with the Arc mainnet burn and the Base mint available to inspect separately.</p>
        <p className={styles.baseAmount}>{amount.format(bill.amount)} <span>{bill.currency}</span></p>
        {bill.payment.confirmationRecordedAt && <p className="mt-4 text-caption leading-relaxed text-on-agent-muted">Payment confirmation recorded<br /><RecordedTime at={bill.payment.confirmationRecordedAt} /></p>}
        {bill.payment.feeUsdc !== null && <p className="mt-3 text-caption text-on-agent-muted">CCTP fee recorded: {amount.format(bill.payment.feeUsdc)} USDC</p>}
      </div>
      <div className={styles.baseLinks}>
        <p className="flex items-center gap-4 text-xl font-semibold">Arc mainnet<ArrowRight aria-hidden size={20} />Base</p>
        <a href={bill.payment.source.url} target="_blank" rel="noopener noreferrer">Verify the burn on Arc mainnet<ArrowUpRight aria-hidden size={19} /></a>
        <a href={bill.payment.destination.url} target="_blank" rel="noopener noreferrer">Verify the mint on Base<ArrowUpRight aria-hidden size={19} /></a>
      </div>
    </section>
  );
}

async function RecordedJourney({ source }: { source: Promise<TeamJourneys | null> }) {
  const journeys = await source.catch(() => null);
  if (!journeys) return <p className={styles.unavailable}>The team&apos;s recorded evidence is unavailable right now.</p>;
  const base = journeys.base?.payment.route === "cctp" && journeys.base.payment.destination.chain === "BASE" ? journeys.base : null;
  const bill = journeys.direct ?? base;
  return <>
    {bill ? <RecordedBill bill={bill} /> : <p className={styles.unavailable}>No bill record is available right now.</p>}
    {base && journeys.direct && <BasePayment bill={base} />}
  </>;
}

/** The fixed copy explains the process; the streamed records describe only the selected bill. */
export function BillJourney({ source }: { source: Promise<TeamJourneys | null> }) {
  return (
    <Section id="bill-journey" aria-labelledby="bill-journey-title" containerClassName={styles.container}>
      <div className={styles.intro}>
        <Eyebrow>The bill&apos;s journey<ArrowDownRight aria-hidden className="mt-4 size-6 text-agent" /></Eyebrow>
        <div><Heading id="bill-journey-title" className="max-w-[20ch]">The AI suggests. Your rules in code decide.</Heading><p className="mt-6 max-w-xl text-lede text-ink-2">From the first read to a record you can check. These stages explain the process; the evidence below shows what was recorded for one real bill.</p></div>
      </div>
      <ol className={styles.process} aria-label="How a bill moves through Vestiarion">
        {STAGES.map((stage, index) => <li key={stage.verb}><span className="font-mono text-caption text-agent">0{index + 1} / {stage.verb}</span><h3 className="mt-4 text-lg font-semibold tracking-tight">{stage.title}</h3><p className="mt-3 text-sm leading-relaxed text-ink-2">{stage.detail}</p></li>)}
      </ol>
      <Suspense fallback={<EvidencePending className={styles.unavailable}><p>Loading the bill&apos;s recorded evidence</p></EvidencePending>}><RecordedJourney source={source} /></Suspense>
    </Section>
  );
}
