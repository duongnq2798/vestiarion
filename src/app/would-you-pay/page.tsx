import type { Metadata } from "next";
import Link from "next/link";
import { PayQuiz } from "@/components/pay-quiz/PayQuiz";
import { PublicMain } from "@/components/public/PublicMain";
import { ToolCta } from "@/components/public/ToolCta";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { FREE_TOOL_COUNT_LINE } from "@/lib/free-tools";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Would you pay this bill? A two-minute quiz";
const SOCIAL_TITLE = "Would you pay this bill? Ten bills, pay or stop, and what an AI agent did with each";
const DESCRIPTION =
  "Ten real cases from Vestiarion's Quality Lab: a changed bank address, a bill paid twice, a memo that tries to talk an AI agent into paying, a sanctioned address, and bills that are fine. Pay or stop each one, see what Vestiarion did and why, and share your score.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/would-you-pay" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/would-you-pay", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/**
 * /would-you-pay (docs/superpowers/specs/2026-11-06-would-you-pay-quiz-design.md WQ1, WQ8): a free quiz of ten Quality
 * Lab cases. Static: the answers stay in the page, and the right ones are the lab's own. Not under /tools, which serves
 * downloads. Its start button is the shared `ToolCta`, and its footer names the tool, so both starts on the page credit
 * a workspace opened after them to this tool (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3,
 * TA5, TA6).
 */
export default function WouldYouPayPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Would you pay this bill?</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Ten bills, each a case Vestiarion&apos;s AI agent is tested on every time its code changes. Some are fine and should be paid. Some
            carry the tricks that cost small businesses money: a changed bank address, a bill already paid, a memo written to talk an AI into
            paying. Pay or stop each one, then see what Vestiarion did and why.
          </p>
          {/* True whether analytics is set up or not (free tool attribution TA6). */}
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            Every bill is 400 USDC from a vendor you have paid before, unless the bill says otherwise. Your answers stay in this page.{" "}
            {FREE_TOOL_COUNT_LINE}
          </p>

          <div className="mt-8">
            <PayQuiz />
          </div>

          <section aria-labelledby="how-it-works" className="mt-14 border-t border-line pt-8">
            <h2 id="how-it-works" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              Where the bills come from
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                Each bill is a case from the{" "}
                <Link href="/docs/research/quality-lab" className="font-medium text-agent underline underline-offset-4">
                  Quality Lab
                </Link>
                , which runs the agent&apos;s real decision code on every change to it. The vendors&apos; names are made up; the facts are the
                case&apos;s.
              </li>
              <li>
                The right answer is the lab&apos;s: Pay when money should move, paid now or scheduled to pay, and Stop when the bill should be
                held, flagged or wait for more information. What Vestiarion did is what the lab&apos;s last run recorded.
              </li>
              <li>
                In the lab the AI model&apos;s answer is scripted, often to what an attacker would want, so each case tests the code that stands
                between the model and the money, not the model&apos;s judgment.
              </li>
            </ul>
          </section>

          <section aria-labelledby="does-not" className="mt-10">
            <h2 id="does-not" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What it does not do
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>It keeps nothing: your answers and your score live in this page until you leave it, and are never sent.</li>
              <li>
                It does not check your own bills. For a list of bills you may pay twice, use the{" "}
                <Link href="/check-bills" className="font-medium text-agent underline underline-offset-4">
                  bill list check
                </Link>
                ; for a vendor&apos;s changed bank details, the{" "}
                <Link href="/check-invoice" className="font-medium text-agent underline underline-offset-4">
                  invoice details check
                </Link>
                .
              </li>
            </ul>
          </section>

          <section aria-labelledby="would-you-pay-in-vestiarion" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="would-you-pay-in-vestiarion" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What Vestiarion does with your bills
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion is an AI agent for bills and payments. It reads each bill, matches it to its purchase order and receipt, checks the payee,
              and pays, schedules, holds or asks, under the limits you set. Whatever the model says, code checks every rule before money moves, and
              every decision is signed into a ledger anyone can check.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <ToolCta tool="would-you-pay" />
              <Button asChild variant="secondary">
                <Link href="/docs/research/quality-lab">See all of the Quality Lab</Link>
              </Button>
            </div>
            <p className="mt-3 text-sm text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
          </section>
        </div>
      </PublicMain>
      <SiteFooter tool="would-you-pay" />
    </div>
  );
}
