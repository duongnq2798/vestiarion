import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { TRY_HREF, TRY_LABEL } from "./cta";
import { BillPreview } from "./hero/BillPreview";

/**
 * The hero (docs/superpowers/specs/2026-10-11-landing-clarity-design.md H1, H2): what Vestiarion is in a line, what it
 * does with a bill in a sentence, the one call to action, and what trying it asks of you. Beside it, two sample bills
 * as the product shows them, in words a business owner reads without knowing what a chain is.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
      {/* One column that may shrink below its content on a phone, so nothing in it pushes past the right edge. */}
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-center lg:gap-12 lg:py-20 xl:grid-cols-[minmax(0,1fr)_29rem] xl:gap-16">
        <div className="min-w-0">
          <Eyebrow className="text-agent">Your AI agent for bills and payments</Eyebrow>
          <h1
            id="hero-title"
            className="mt-4 text-balance text-[2.75rem] font-semibold leading-[0.98] tracking-[-0.05em] text-ink sm:text-6xl lg:text-[3.5rem] xl:text-[4.25rem]"
          >
            Every bill checked before it&apos;s paid.{" "}
            <span className="block font-serif font-normal italic tracking-[-0.035em] text-agent">Every decision on record.</span>
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-ink-2 sm:text-xl">
            Vestiarion&apos;s agent reviews each invoice from your contractors and suppliers and tells you whether it&apos;s ready to pay, should
            wait, or needs you, and why. Within limits you set, it pays the ready ones in USDC.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href={TRY_HREF} data-cta="hero-try">
                {TRY_LABEL}
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="bg-surface/80">
              <a href="#how-it-works" data-cta="hero-how">
                See how it works
              </a>
            </Button>
          </div>
          <p className="mt-4 max-w-xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2">
            <strong className="font-semibold text-ink">Start in shadow mode.</strong> Keep paying the way you do today while the agent decides on
            your real bills. No wallet or funds needed to start.
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-ink-3">
            <span>Email sign-in, no password.</span>
            <Link href="/docs/guides/shadow-mode" className="inline-flex min-h-6 items-center gap-1 font-medium text-agent underline-offset-2 hover:underline">
              How shadow mode works
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </p>
        </div>
        <BillPreview />
      </div>
    </section>
  );
}
