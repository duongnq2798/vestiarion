import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

const claims = [
  {
    title: "A model can recommend payment. Code can still refuse it.",
    body: "Every payable verdict crosses risk, screened-limit, evidence, and liquidity checks before the provider boundary. A blocked verdict records what the model argued and which rule overruled it.",
    href: "/onboarding",
    evidence: "See the guardrail receipt",
  },
  {
    title: "Screening changes authority, not history.",
    body: "A live OpenSanctions match or labelled bundled fallback derives the current payment limit from the business baseline. Re-screening is reversible and failed lookups retain the previous verdict.",
    href: "/onboarding",
    evidence: "Inspect tiered limits",
  },
  {
    title: "Treasury moves must beat their own cost.",
    body: "The reserve policy prices projected yield against the sweep-and-redemption round trip while protecting obligations due in 7 and 14 days. Uneconomic movement stays liquid.",
    href: "/onboarding",
    evidence: "Read the economics",
  },
  {
    title: "The audit log is a cryptographic receipt, not a feed.",
    body: "Every human, agent, and system action is Ed25519-signed, linked to the previous entry, and independently verified against the full chain on demand.",
    href: "/onboarding",
    evidence: "Verify the hash chain",
  },
] as const;

export function Claims() {
  return (
    <section id="proof" aria-labelledby="proof-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-14">
      <Reveal>
        <Eyebrow>Claims with receipts</Eyebrow>
        <h2 id="proof-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Do not take the landing page’s word for it.</h2>
      </Reveal>
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        {claims.map((claim, index) => (
          <Reveal key={claim.title} delay={index * 60}>
            <Card asChild interactive className="group relative block h-full overflow-hidden p-6 sm:p-7">
              <Link href={claim.href}>
                <span className="absolute right-5 top-4 font-mono text-4xl font-bold text-raised">0{index + 1}</span>
                <h3 className="relative max-w-[28rem] text-xl font-semibold tracking-tight text-ink">{claim.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{claim.body}</p>
                <p className="mt-4 text-sm font-medium text-agent group-hover:underline">{claim.evidence} →</p>
              </Link>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
