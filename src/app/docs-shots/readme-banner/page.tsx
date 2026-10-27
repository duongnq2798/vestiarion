import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { BrandMark } from "@/components/vx/Brand";
import { README_BANNER_BILL as BILL, README_BANNER_WORKS_WITH } from "../readme-banner-facts";
import styles from "./banner.module.css";

/**
 * The README's banner and the repository's GitHub social preview: the landing hero's message and its recorded team
 * bill, drawn by the app's own components, fonts and tokens in a frame of exactly 1280 x 640 CSS px, for
 * `npm run readme:banner` (scripts/docs-screenshots.mjs --readme-banner) to photograph into docs/assets/.
 *
 * The bill is the dated snapshot in readme-banner-facts.ts, never a live read, and its words are the hero's own
 * (tests/readme-banner.test.tsx renders both and compares them). Larger than the hero's, so they still read when GitHub
 * shows the 2560 px image at about a third of its size. Nothing moves.
 *
 * Like every /docs-shots page it answers only where `DOCS_SCREENSHOTS=1` is set, read per request; everywhere else,
 * production included, it is a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "README banner",
  robots: { index: false, follow: false },
};

// The hero's formats (src/components/landing/Hero.tsx).
const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const fee = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const scheduledDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const recordedTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

const payOn = scheduledDay.format(new Date(`${BILL.decision.payOn}T12:00:00Z`));

/** The three recorded steps, in the hero's words. */
const STEPS = [
  {
    title: "Agent decided",
    entry: BILL.check.seq,
    body: `Schedule for ${payOn}: no early-payment discount, keeping the cash free until it is due.`,
    note: `CCTP fee: ${fee.format(BILL.payment.feeUsdc)} USDC to Base, on top`,
  },
  { title: "Code held it", entry: BILL.hold.seq, body: "First payment to a new address needs a second look." },
  {
    title: "A person approved",
    entry: BILL.approval.seq,
    paid: "Paid on Base",
    note: `Payment confirmation recorded ${recordedTime.format(new Date(BILL.payment.confirmationRecordedAt))} UTC`,
  },
] as const satisfies readonly { title: string; entry: number; body?: string; paid?: string; note?: string }[];

export default function ReadmeBannerPage() {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();

  return (
    <main id="main" className={styles.page}>
      <div data-docs-shot="readme-banner" className={styles.frame}>
        <div className={styles.message}>
          <span className={styles.lockup}>
            <BrandMark className={styles.mark} />
            <span>Vestiarion</span>
          </span>
          <div>
            <Eyebrow inverse className={styles.eyebrow}>For small businesses with work to do</Eyebrow>
            <Heading as="h1" size="positioning" className={styles.headline}>Your AI agent for bills and payments</Heading>
            <Heading as="p" size="display" className={styles.tagline}><span>Every bill.</span> <span>A clear way through.</span></Heading>
          </div>
        </div>

        <figure className={styles.card} aria-label="A recorded team bill">
          <div className={styles.windowBar}>
            <span>{BILL.workspace}</span>
            <span className={styles.network}>Arc mainnet</span>
          </div>
          <div className={styles.payment}>
            <div className={styles.paymentTitle}>
              <Eyebrow className={styles.cardEyebrow}>Recorded team bill</Eyebrow>
              <span className={styles.paid}><Check aria-hidden size={18} strokeWidth={2.5} />Paid</span>
            </div>
            <p className={styles.amount}>{amount.format(BILL.amount)} <span>{BILL.currency}</span></p>
            <ol className={styles.steps}>
              {STEPS.map((step, index) => (
                <li key={step.title} className={styles.step}>
                  <span className={styles.stepNumber} aria-hidden>{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0">
                    <div className={styles.stepHeader}>
                      <h2 className={styles.stepTitle}>{step.title}</h2>
                      <span className={styles.entry}>{`Entry #${step.entry}`}</span>
                    </div>
                    {"body" in step && <p className={styles.stepBody}>{step.body}</p>}
                    {"paid" in step && <p className={styles.paidOn}><ArrowRight aria-hidden size={19} strokeWidth={2.25} />{step.paid}</p>}
                    {"note" in step && <p className={styles.note}>{step.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </figure>

        <p className={styles.footer}>
          <span><span className={styles.label}>Built on</span>Arc and Circle</span>
          <span><span className={styles.label}>Works with</span>{README_BANNER_WORKS_WITH.join(", ")}</span>
        </p>
      </div>
    </main>
  );
}
