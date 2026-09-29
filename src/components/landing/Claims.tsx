import Link from "next/link";
import { HashText, Receipt, Seal, Verdict } from "@/components/landing/evidence/Evidence";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

const claims = [
  {
    title: "A model can recommend payment. Code can still refuse it.",
    body: "Risk, screened limits, evidence and liquidity are checked before the provider boundary. The receipt keeps both the model’s argument and the rule that overruled it.",
    href: "/onboarding",
    evidence: "See the guardrail receipt",
  },
  {
    title: "Screening changes authority, not history.",
    body: "Every screen derives a limit from the business baseline. A failed lookup keeps the previous verdict instead of silently clearing the counterparty.",
    href: "/onboarding",
    evidence: "Inspect tiered limits",
  },
  {
    title: "Treasury moves must beat their own cost.",
    body: "Projected yield has to exceed the sweep-and-redemption round trip. Cash needed for near-term obligations remains liquid.",
    href: "/onboarding",
    evidence: "Read the economics",
  },
  {
    title: "The audit log is a cryptographic receipt, not a feed.",
    body: "Human, agent and system actions are Ed25519-signed and linked to the entry before them. The verifier replays authorship, content and continuity on demand.",
    href: "/onboarding",
    evidence: "Verify the hash chain",
  },
] as const;

function ClaimArtifact({ index }: { index: number }) {
  if (index === 0) {
    return (
      <Receipt className="w-full max-w-sm" slipClassName="py-5">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Payment decision</p>
        <div className="mt-5 flex items-center justify-between gap-4 border-b border-line pb-4">
          <span className="text-[0.9375rem] text-ink-2">model</span>
          <Verdict tone="agent">pay</Verdict>
        </div>
        <div className="flex items-center justify-between gap-4 pt-4">
          <span className="text-[0.9375rem] font-semibold text-ink">code</span>
          <Verdict tone="refused">refused</Verdict>
        </div>
      </Receipt>
    );
  }

  if (index === 1) {
    return (
      <div className="w-full max-w-sm border-y border-line bg-surface/70 px-5 py-4">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Payment authority</p>
        <dl className="mt-4 space-y-3 text-[0.9375rem]">
          <div className="flex items-center justify-between gap-4"><dt className="text-ink-2">Clear</dt><dd className="font-mono font-semibold text-proof">100% baseline</dd></div>
          <div className="flex items-center justify-between gap-4"><dt className="text-ink-2">Medium</dt><dd className="font-mono font-semibold text-held">25% baseline</dd></div>
          <div className="flex items-center justify-between gap-4"><dt className="text-ink-2">High</dt><dd className="font-mono font-semibold text-refused">0% · blocked</dd></div>
        </dl>
      </div>
    );
  }

  if (index === 2) {
    return (
      <Receipt className="w-full max-w-sm" slipClassName="py-5">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Move-money test</p>
        <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
          <div><p className="font-serif text-2xl text-proof">Yield</p><p className="mt-1 text-xs text-ink-3">projected</p></div>
          <span aria-hidden className="font-mono text-xl text-ink-3">&gt;</span>
          <div><p className="font-serif text-2xl text-refused">Cost</p><p className="mt-1 text-xs text-ink-3">sweep + redeem</p></div>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
          <span className="text-xs text-ink-2">Otherwise the cash stays liquid.</span>
          <Verdict tone="held">held</Verdict>
        </div>
      </Receipt>
    );
  }

  return (
    <Receipt className="w-full max-w-sm" slipClassName="flex items-center gap-5 py-5">
      <Seal className="size-20 shrink-0" />
      <div className="min-w-0">
        <Verdict tone="proof">signed</Verdict>
        <p className="mt-3 font-mono text-xs font-semibold text-ink">Ed25519 · SHA-256</p>
        <p className="mt-1 truncate text-xs text-ink-3">
          <HashText value="sha256(prev_hash + body_hash + signature)" head={6} tail={9} />
        </p>
      </div>
    </Receipt>
  );
}

export function Claims() {
  return (
    <section id="proof" aria-labelledby="proof-title" className="scroll-mt-16 bg-ground">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <div className="max-w-3xl">
            <Eyebrow className="text-xs">Claims with receipts</Eyebrow>
            <h2 id="proof-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
              Do not take the landing page’s word for it.
            </h2>
          </div>
        </Reveal>

        <div className="mt-10 border-b border-line sm:mt-14">
          {claims.map((claim, index) => (
            <Reveal key={claim.title} delay={index * 60}>
              <article className="grid items-center gap-8 border-t border-line py-10 sm:py-14 lg:grid-cols-2 lg:gap-16">
                <div className={cn("max-w-xl", index % 2 === 0 ? "lg:order-1" : "lg:order-2")}>
                  <p className="font-mono text-xs font-semibold text-ink-3">0{index + 1}</p>
                  <h3 className="mt-3 font-serif text-3xl leading-[1.08] text-ink sm:text-4xl">{claim.title}</h3>
                  <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">{claim.body}</p>
                  <Link href={claim.href} className="mt-5 inline-block text-[0.9375rem] font-semibold text-agent underline-offset-4 hover:underline">
                    {claim.evidence} →
                  </Link>
                </div>
                <div className={cn("flex min-w-0 lg:justify-center", index % 2 === 0 ? "lg:order-2" : "lg:order-1")}>
                  <ClaimArtifact index={index} />
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
