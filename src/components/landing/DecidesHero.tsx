import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { TRY_HREF, TRY_LABEL } from "./cta";
import { EvidenceReplay, type ChainHeadEntry } from "./hero/EvidenceReplay";
import { TreasuryArch } from "./TreasuryArch";

/**
 * The head of /how-it-decides (docs/superpowers/specs/2026-10-11-landing-clarity-design.md D1): the decision receipt
 * replayed in its arch, as the landing's hero showed it until the landing spoke to business owners first. `head` is the
 * live ledger's newest entries, reduced by the page to what a public page may show.
 */
export function DecidesHero({ head }: { head: ChainHeadEntry[] }) {
  return (
    <section aria-labelledby="decides-title" className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_31rem] lg:items-center lg:gap-14 lg:py-20">
        <div className="min-w-0">
          <Eyebrow className="text-agent">How it decides</Eyebrow>
          <h1 id="decides-title" className="mt-5 text-balance text-5xl font-semibold leading-[0.95] tracking-[-0.055em] text-ink sm:text-6xl">
            The model proposes. Code decides.
            <span className="mt-1 block font-serif font-normal italic text-agent">Every outcome is signed.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty font-serif text-xl leading-relaxed text-ink-2">
            Each cycle the agent reads the whole book. A model argues for an action, rules in ordinary code decide whether it may happen, and only
            then does money move. Payments, holds and refusals alike are signed into a hash-linked ledger anyone can verify.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={TRY_HREF} data-cta="decides-try">
                {TRY_LABEL}
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="bg-surface/80">
              <Link href="/docs/research/model-vs-policy">Read the research note</Link>
            </Button>
          </div>
        </div>
        <TreasuryArch>
          <EvidenceReplay head={head} />
        </TreasuryArch>
      </div>
    </section>
  );
}
