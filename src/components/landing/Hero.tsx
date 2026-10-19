import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, FileText, LayoutGrid, ListChecks, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EvidencePending } from "./EvidencePending";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import type { TeamJourneys } from "@/lib/team-journey";
import { TRY_HREF, TRY_LABEL } from "./cta";
import { InvoiceCapture } from "./hero/InvoiceCapture";
import styles from "./Hero.module.css";

const NO_JOURNEY = Promise.resolve(null);
const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const recordedTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

async function HeroPayment({ source }: { source: Promise<TeamJourneys | null> }) {
  const journeys = await source.catch(() => null);
  const base = journeys?.base?.payment.route === "cctp" && journeys.base.payment.destination.chain === "BASE" ? journeys.base : null;
  const bill = journeys?.direct ?? base;
  if (!bill) {
    return <div className={styles.paymentState}><FileText aria-hidden size={28} /><p>This team&apos;s payment record is unavailable right now.</p><p className="mt-2 text-sm text-ink-2">The bill&apos;s recorded facts will appear here when they can be read.</p></div>;
  }
  const events = [
    { key: "received", label: "Bill recorded", event: bill.received },
    { key: "check", label: "Decision recorded", event: bill.check },
    { key: "approval", label: "Approval recorded", event: bill.approval },
  ];
  return (
    <div className={styles.payment}>
      <div className={styles.paymentTitle}>
        <div><Eyebrow>Recorded team bill</Eyebrow><h2 className="mt-2 text-xl font-semibold tracking-tight">Payment and decision record</h2></div>
        <span className={styles.paid}><Check aria-hidden size={14} />Paid</span>
      </div>
      <p className={styles.amount}>{amount.format(bill.amount)} <span>{bill.currency}</span></p>
      <p className="mt-2 text-sm text-ink-2">Paid on {bill.payment.destination.chain === "BASE" ? "Base" : "Arc mainnet"}</p>
      <dl className={styles.facts}>
        {events.map(({ key, label, event }) => (
          <div key={key}><dt>{label}</dt><dd>{event ? <a href={`#journey-entry-${key}-${event.seq}`} className="inline-flex min-h-6 items-center font-medium text-agent underline underline-offset-4">Entry #{event.seq}</a> : "Not available in this bill's record"}</dd></div>
        ))}
      </dl>
      {bill.payment.confirmationRecordedAt && <p className="mt-4 text-xs leading-relaxed text-ink-2">Payment confirmation recorded<br /><time dateTime={bill.payment.confirmationRecordedAt}>{recordedTime.format(new Date(bill.payment.confirmationRecordedAt))} UTC</time></p>}
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
        <Eyebrow inverse>For small businesses with work to do</Eyebrow>
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
            <div className={styles.windowBar}><span>Vestiarion team workspace</span><span className="font-mono text-[0.625rem] uppercase tracking-wide">Read-only view</span></div>
            <div className={styles.workspace}>
              <aside className={styles.sidebar} aria-label="Workspace navigation preview">
                <p className="text-lg font-semibold tracking-tight">V.</p>
                <p className="mt-5 font-mono text-[0.625rem] uppercase tracking-wide text-ink-3">Workspace</p>
                <ul className={styles.navigation}>
                  <li><LayoutGrid aria-hidden size={15} /><span>Treasury</span></li>
                  <li className={styles.current}><FileText aria-hidden size={15} /><span>Bills &amp; receivables</span></li>
                  <li><ListChecks aria-hidden size={15} /><span>Decision record</span></li>
                  <li><ShieldCheck aria-hidden size={15} /><span>Rules in code</span></li>
                </ul>
              </aside>
              <div className="min-w-0">
                <div className={styles.productHeading}>Bills &amp; receivables<span>Team payment</span></div>
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
