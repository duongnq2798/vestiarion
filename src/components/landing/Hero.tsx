import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, FileText, LayoutGrid, ListChecks, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EvidencePending } from "./EvidencePending";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { sectionTitle } from "@/components/vx/nav";
import { ruleWords } from "@/lib/rule-words";
import type { TeamJourney, TeamJourneys, TeamJourneyEvent } from "@/lib/team-journey";
import { TRY_HREF, TRY_LABEL } from "./cta";
import { InvoiceCapture } from "./hero/InvoiceCapture";
import styles from "./Hero.module.css";

const NO_JOURNEY = Promise.resolve(null);
const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const fee = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const scheduledDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const recordedTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
const PREVIEW_NAV = [
  { key: "treasury", Icon: LayoutGrid }, { key: "approvals", Icon: ListChecks },
  { key: "invoices", Icon: FileText }, { key: "audit", Icon: ShieldCheck },
] as const;

function decisionWords(bill: TeamJourney) {
  if (bill.check?.action === "ap_schedule") {
    if (!bill.decision) return "A later payment was proposed. The recorded date and reason are unavailable.";
    const day = scheduledDay.format(new Date(`${bill.decision.payOn}T12:00:00Z`));
    return bill.decision.reason === "no_early_payment_discount"
      ? `Schedule for ${day}: no early-payment discount, keeping the cash free until it is due.`
      : `Schedule for ${day}.`;
  }
  return ({ ap_pay: "Pay this bill.", ap_hold: "Hold this bill for review.", ap_request_info: "Ask for more information.", ap_flag_fraud: "Flag this bill for review." } as Record<string, string>)[bill.check?.action ?? ""] ?? "Not available in this bill's record";
}

function EntryLink({ stage, event }: { stage: string; event: TeamJourneyEvent | null }) {
  return event ? <a href={`#journey-entry-${stage}-${event.seq}`} className="inline-flex min-h-6 items-center text-caption font-medium text-agent underline underline-offset-4">Entry #{event.seq}</a> : null;
}

async function HeroPayment({ source }: { source: Promise<TeamJourneys | null> }) {
  const journeys = await source.catch(() => null);
  const base = journeys?.base?.payment.route === "cctp" && journeys.base.payment.destination.chain === "BASE" ? journeys.base : null;
  const bill = base ?? journeys?.direct;
  if (!bill) {
    return <div className={styles.paymentState}><FileText aria-hidden size={28} /><p>This team&apos;s payment record is unavailable right now.</p><p className="mt-2 text-sm text-ink-2">The bill&apos;s recorded facts will appear here when they can be read.</p></div>;
  }
  const heldReason = bill.hold && bill.rule ? bill.rule === "counterparty.new_payee" ? "First payment to a new address needs a second look." : ruleWords(bill.rule) : null;
  return (
    <div className={styles.payment}>
      <div className={styles.paymentTitle}>
        <div><Eyebrow className={styles.eyebrow}>Recorded team bill</Eyebrow><h2 className="mt-2 text-xl font-semibold tracking-tight">Payment and decision record</h2></div>
        <span className={styles.paid}><Check aria-hidden size={14} />Paid</span>
      </div>
      <p className={styles.amount}>{amount.format(bill.amount)} <span>{bill.currency}</span></p>
      <ol className={styles.steps}>
        <li className={styles.step}><span className={styles.stepNumber} aria-hidden>01</span><div className="min-w-0">
          <div className={styles.stepHeader}><h3 className="text-sm font-semibold">{bill.check ? "Agent decided" : "Agent decision unavailable"}</h3><EntryLink stage="check" event={bill.check} /></div>
          <p className={styles.stepBody}>{decisionWords(bill)}</p>
          {bill.payment.route === "cctp" && bill.payment.feeUsdc !== null && <p className="mt-2 text-caption leading-relaxed text-ink-2" title={`Recorded CCTP fee: ${amount.format(bill.payment.feeUsdc)} USDC`}>CCTP fee: {bill.payment.feeUsdc > 0 && bill.payment.feeUsdc < 0.001 ? "<0.001" : fee.format(bill.payment.feeUsdc)} USDC to Base, on top</p>}
        </div></li>
        <li className={styles.step}><span className={styles.stepNumber} aria-hidden>02</span><div className="min-w-0">
          <div className={styles.stepHeader}><h3 className="text-sm font-semibold">{heldReason ? "Code held it" : "Hold record unavailable"}</h3><EntryLink stage="hold" event={bill.hold} /></div>
          <p className={styles.stepBody}>{heldReason ?? "Not available in this bill's record"}</p>
        </div></li>
        <li className={styles.step}><span className={styles.stepNumber} aria-hidden>03</span><div className="min-w-0">
          <div className={styles.stepHeader}><h3 className="text-sm font-semibold">{bill.approval ? "A person approved" : "Approval record unavailable"}</h3><EntryLink stage="approval" event={bill.approval} /></div>
          <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-proof"><ArrowRight aria-hidden size={16} />Paid on {bill.payment.destination.chain === "BASE" ? "Base" : "Arc mainnet"}</p>
          {bill.payment.confirmationRecordedAt && <p className="mt-2 text-caption leading-relaxed text-ink-2">Payment confirmation recorded<br /><time dateTime={bill.payment.confirmationRecordedAt}>{recordedTime.format(new Date(bill.payment.confirmationRecordedAt))} UTC</time></p>}
        </div></li>
      </ol>
      <div className="flex flex-wrap gap-x-5">
        <a className={styles.transaction} href={bill.payment.source.url} target="_blank" rel="noopener noreferrer">{bill.payment.route === "cctp" ? "Verify the burn on Arc mainnet" : "Verify payment on Arc Explorer"}<ArrowUpRight aria-hidden size={16} /></a>
        {bill.payment.destination.chain === "BASE" && <a className={styles.transaction} href={bill.payment.destination.url} target="_blank" rel="noopener noreferrer">Verify the mint on Base<ArrowUpRight aria-hidden size={16} /></a>}
      </div>
    </div>
  );
}

/** The message and application frame render immediately; only the bill's evidence waits for its read. */
export function Hero({ journey = NO_JOURNEY }: { journey?: Promise<TeamJourneys | null> } = {}) {
  return (
    <>
      <Section tone="agent" aria-labelledby="hero-title" containerClassName={styles.container}>
        <Eyebrow inverse className={styles.eyebrow}>For small businesses with work to do</Eyebrow>
        <Heading as="h1" size="positioning" id="hero-title" className="mt-5 max-w-[26ch]">Your AI agent for bills and payments</Heading>
        <div className={styles.heroGrid}>
          <div className="min-w-0">
            <Heading as="p" size="display" className={styles.tagline}>Every bill. A clear way through.</Heading>
            <p className="mt-7 max-w-xl text-lede text-on-agent-muted">Vestiarion&apos;s agent reviews each invoice from your contractors and suppliers and tells you whether it&apos;s ready to pay, should wait, or needs you, and why. Within limits you set, it pays the ready ones in USDC.</p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button asChild size="lg" variant="inverse"><Link href={TRY_HREF} data-cta="hero-try">{TRY_LABEL}<ArrowUpRight aria-hidden /></Link></Button>
              <a href="#how-it-works" data-cta="hero-how" className="inline-flex min-h-11 items-center gap-2 text-ui font-semibold underline underline-offset-4">See how it works<ArrowDownRight aria-hidden size={18} /></a>
            </div>
            <p className="mt-6 max-w-xl text-sm leading-relaxed text-on-agent-muted"><strong className="font-semibold text-on-agent">Start in shadow mode.</strong> Keep paying the way you do today while the agent decides on your real bills.</p>
            <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-caption text-on-agent-muted"><span>No wallet or funds needed.</span><span>Email sign-in, no password.</span></p>
            <Link href="/docs/guides/shadow-mode" prefetch={false} className="mt-3 inline-flex min-h-6 items-center gap-1 text-caption font-medium underline underline-offset-4">How shadow mode works<ArrowRight aria-hidden size={14} /></Link>
          </div>
          <figure className={`${styles.product} focus-default text-ink`} aria-labelledby="hero-product-caption">
            <div className={styles.windowBar}><span>Vestiarion team workspace</span><span className="font-mono text-caption uppercase tracking-wide">Read-only view</span></div>
            <div className={styles.workspace}>
              <aside className={styles.sidebar} aria-label="Workspace navigation preview">
                <p className="text-lg font-semibold tracking-tight">V.</p>
                <p className="mt-5 font-mono text-caption uppercase tracking-wide text-ink-3">Workspace</p>
                <ul className={styles.navigation}>
                  {PREVIEW_NAV.map(({ key, Icon }) => <li key={key} className={key === "invoices" ? styles.current : undefined}><Icon aria-hidden size={15} /><span>{sectionTitle(key)}</span></li>)}
                </ul>
              </aside>
              <div className="min-w-0">
                <div className={styles.productHeading}>{sectionTitle("invoices")}<span>Team payment</span></div>
                <Suspense fallback={<EvidencePending className={styles.paymentState}><FileText aria-hidden size={28} /><p>Loading this team&apos;s payment record</p><p className="mt-2 text-sm text-ink-2">The product view stays here while its evidence is read.</p></EvidencePending>}><HeroPayment source={journey} /></Suspense>
                <div className={styles.productAction}><a href="#bill-journey" className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-agent underline underline-offset-4">View the bill&apos;s evidence<ArrowDownRight aria-hidden size={16} /></a></div>
              </div>
            </div>
            <figcaption id="hero-product-caption" className={styles.productCaption}>An application view of a real team bill. Only available recorded facts are shown.</figcaption>
          </figure>
        </div>
        <p className={styles.controlling}>The AI suggests.<span>Your rules in code decide.</span></p>
      </Section>
      <Section tone="surface" aria-label="Invoice Capture for Chrome" containerClassName="py-6 [&>div]:mt-0 [&>div]:max-w-none"><InvoiceCapture /></Section>
    </>
  );
}
