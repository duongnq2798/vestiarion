import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { EvidenceReplay, type ChainHeadEntry } from "./hero/EvidenceReplay";

/**
 * `head` is the live ledger's newest entries, reduced by the page to what a
 * public page may show; `provenance` says which legs run live.
 */
export function Hero({ provenance, head }: { provenance: ProvenanceLeg[]; head: ChainHeadEntry[] }) {
  return (
    <section aria-labelledby="hero-title" className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_31rem] lg:items-center lg:gap-14 lg:py-20">
        <div>
          <Eyebrow className="text-agent">Autonomous treasury agent · Arc testnet</Eyebrow>
          <h1 id="hero-title" className="mt-5 text-balance text-5xl font-semibold leading-[0.95] tracking-[-0.055em] text-ink sm:text-7xl">
            Money moves.
            <br />
            <span className="font-serif font-normal italic text-agent">Evidence remains.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-2xl">
            Vestiarion pays a business’s bills. A model proposes each payment, code decides whether it may happen, and every outcome — refusals included — is signed into a chain you can verify.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={"/onboarding"}>Try it with simulated money</Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="bg-surface/80">
              <a href="#how-it-works">How a decision is made</a>
            </Button>
          </div>
          <p className="mt-3 text-[0.8125rem] text-ink-3">
            Email sign-in, a workspace of your own, and a real Arc testnet wallet in one click. Fund it with testnet USDC from Circle&apos;s faucet; no real money moves.
          </p>
          <div className="mt-8 border-t border-line/80 pt-5">
            <p className="mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3">What runs live right now</p>
            <ProvenanceBar legs={provenance} />
          </div>
        </div>
        <EvidenceReplay head={head} />
      </div>
    </section>
  );
}
