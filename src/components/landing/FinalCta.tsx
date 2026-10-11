import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { GUIDED_SETUP_HREF, TRY_HREF, TRY_LABEL } from "./cta";

/**
 * The landing page's close (docs/superpowers/specs/2026-10-11-landing-clarity-design.md C1): the same call to action as
 * the hero, what happens after it in order, and the guided setup for a team that would rather do it on a call with us.
 */
export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-title" className="focus-inverse border-t border-agent bg-agent text-on-agent">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.12em] text-on-agent/80">Start with one bill</p>
        <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end lg:gap-16">
          <div className="max-w-3xl">
            <h2 id="final-cta-title" className="text-balance text-4xl font-semibold tracking-[-0.045em] text-on-agent sm:text-5xl lg:text-6xl">
              See what the agent decides on your next bill.
            </h2>
            <p className="mt-5 max-w-2xl text-[0.9375rem] leading-relaxed text-on-agent/90 sm:text-base">
              Sign in with your email, open a workspace in shadow mode and add a bill. Its decision and the reason arrive within about a minute.
              No wallet or funds needed to start.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row lg:flex-col">
            <Button asChild size="lg" variant="inverse">
              <Link href={TRY_HREF} data-cta="final-try">
                {TRY_LABEL}
              </Link>
            </Button>
            <Button asChild size="lg" variant="ghost" className="border border-on-agent/40 text-on-agent hover:bg-on-agent/10 hover:text-on-agent">
              <Link href={GUIDED_SETUP_HREF} data-cta="final-guided">
                Set it up with us on a call
              </Link>
            </Button>
          </div>
        </div>
        <ol className="mt-10 grid gap-3 border-t border-on-agent/25 pt-5 font-mono text-xs leading-relaxed text-on-agent/85 sm:grid-cols-4">
          {["Sign in by email link", "Open a workspace, shadow mode on", "Add one of your bills", "Read the agent's decision and why"].map((step, index) => (
            <li key={step} className="flex gap-2">
              <span className="text-on-agent">{index + 1}.</span>
              {step}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-on-agent/85">
          Already have a workspace?{" "}
          <Link href="/login" className="font-semibold text-on-agent underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </section>
  );
}
