import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { PRODUCT_HUNT_BADGE } from "@/lib/site-links";
import { EvidenceReplay, type ChainHeadEntry } from "./hero/EvidenceReplay";
import { TreasuryArch } from "./TreasuryArch";

/**
 * `head` is the live ledger's newest entries, reduced by the page to what a
 * public page may show; `provenance` says which legs run live.
 * `hostedAvailable` is whether this deployment offers a hosted testnet wallet
 * (hosted wallets H8): only then does the hero promise one.
 */
export function Hero({ provenance, head, hostedAvailable }: { provenance: ProvenanceLeg[]; head: ChainHeadEntry[]; hostedAvailable: boolean }) {
  return (
    <section aria-labelledby="hero-title" className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
      {/* One column that may shrink below its content on a phone: otherwise the replay's width pushed every line past the right edge. */}
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_31rem] lg:items-center lg:gap-14 lg:py-20">
        <div className="min-w-0">
          {/* The mainnet claim links to the numbers that show it: Arc mainnet's own block on /open (landing proof P2). */}
          <Eyebrow className="text-agent">
            An agent for your bills ·{" "}
            <Link href="/open#mainnet" className="underline decoration-agent/40 underline-offset-4 transition-colors duration-150 ease-standard hover:decoration-agent">
              Live on Arc mainnet
            </Link>
          </Eyebrow>
          <h1 id="hero-title" className="mt-5 text-balance text-5xl font-semibold leading-[0.95] tracking-[-0.055em] text-ink sm:text-7xl">
            The agent pays your bills.
            <br />
            <span className="font-serif font-normal italic text-agent">Evidence remains.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-2xl">
            Try it beside how you pay today: the agent decides each bill, and you agree or disagree, on Arc testnet. Once you trust it, it pays your real bills in USDC on Arc mainnet, within the spending limits you set. Every decision, refusals included, is signed into a chain anyone can verify.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={"/onboarding"}>{hostedAvailable ? "Try it on your bills" : "Open a workspace"}</Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="bg-surface/80">
              <a href="#how-it-works">How a decision is made</a>
            </Button>
          </div>
          <p className="mt-3 text-[0.8125rem] text-ink-3">
            {hostedAvailable
              ? "Email sign-in and a workspace of your own. On Arc testnet, a wallet in one click and USDC from Circle's faucet; on Arc mainnet, the agent pays from a wallet you hold."
              : "Email sign-in, then a workspace of your own. Connect your Circle account from Settings to pay on Arc testnet or Arc mainnet."}{" "}
            <Link href="/docs/guides/shadow-mode" className="font-medium text-agent underline-offset-2 hover:underline">
              How shadow mode works
            </Link>
          </p>
          <a href={PRODUCT_HUNT_BADGE.href} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex rounded-lg">
            {/* Product Hunt draws the badge with its live upvote count, so it stays their image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={PRODUCT_HUNT_BADGE.src} alt={PRODUCT_HUNT_BADGE.alt} width={PRODUCT_HUNT_BADGE.width} height={PRODUCT_HUNT_BADGE.height} decoding="async" />
          </a>
          <div className="mt-8 border-t border-line/80 pt-5">
            <p className="mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3">What runs live right now</p>
            <ProvenanceBar legs={provenance} />
          </div>
        </div>
        <TreasuryArch>
          <EvidenceReplay head={head} />
        </TreasuryArch>
      </div>
    </section>
  );
}
