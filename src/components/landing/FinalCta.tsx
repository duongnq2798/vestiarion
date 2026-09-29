import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * `hostedAvailable` is whether this deployment offers a hosted testnet wallet
 * (hosted wallets H8). With it, a sandbox is where a workspace starts and a
 * real Arc testnet wallet is one click away; without it, the money stays
 * fictional until an owner sets up Circle themselves.
 */
export function FinalCta({ hostedAvailable }: { hostedAvailable: boolean }) {
  return (
    <section aria-labelledby="final-cta-title" className="focus-inverse border-t border-agent bg-agent text-on-agent">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.12em] text-on-agent/75">A workspace, not a promise</p>
        <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end lg:gap-16">
          <div className="max-w-4xl">
            <h2 id="final-cta-title" className="text-4xl font-semibold tracking-[-0.045em] text-on-agent sm:text-5xl lg:text-6xl">
              {hostedAvailable ? "Start in a sandbox. Pay on Arc testnet when you’re ready." : "Give the agent a sandbox. Keep the money fictional."}
            </h2>
            <p className="mt-5 max-w-2xl text-[0.9375rem] leading-relaxed text-on-agent/85 sm:text-base">
              {hostedAvailable
                ? "Start with passwordless email sign-in, then a sandbox workspace funded with simulated USDC. A real Arc testnet wallet is one click away in Settings: fund it with testnet USDC from Circle's faucet, and no real money moves."
                : "Start with passwordless email sign-in, then create a workspace funded with simulated USDC. Enabling Circle still uses Arc testnet funds—not real money—and requires separate wallet setup."}
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row lg:flex-col">
            <Button asChild size="lg" variant="inverse">
              <Link href="/onboarding">Start a sandbox workspace</Link>
            </Button>
            <Button asChild size="lg" variant="ghost" className="border border-on-agent/40 text-on-agent hover:bg-on-agent/10 hover:text-on-agent">
              <Link href="/login">Sign in to an existing workspace</Link>
            </Button>
          </div>
        </div>
        <p className="mt-8 border-t border-on-agent/25 pt-4 font-mono text-xs leading-relaxed text-on-agent/75">
          {hostedAvailable
            ? "First click → email sign-in → create or open a sandbox → inspect decisions, refusals and the chain verifier → a testnet wallet in Settings."
            : "First click → email sign-in → create or open a sandbox → inspect decisions, refusals and the chain verifier."}
        </p>
      </div>
    </section>
  );
}
