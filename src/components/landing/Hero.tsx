import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { BrandMark } from "@/components/vx/Brand";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { withFoundingOrg } from "@/lib/dal/scope";

function ProofPanel({ provenance }: { provenance: ProvenanceLeg[] }) {
  const steps = [
    ["01", "Observe", "book + screening evidence"],
    ["02", "Reason", "model or explicit heuristic"],
    ["03", "Enforce", "code-level policy boundary"],
    ["04", "Sign", "append-only audit receipt"],
  ] as const;
  return (
    <Card asChild className="relative overflow-hidden p-5 sm:p-6">
      <aside>
        <div aria-hidden className="absolute -right-14 -top-16 size-44 rounded-full bg-agent-soft blur-2xl motion-safe:animate-drift" />
        <div className="relative">
          <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <Eyebrow className="text-agent">System state</Eyebrow>
              <p className="mt-1 text-sm font-semibold text-ink">Proof before movement</p>
            </div>
            <div className="relative">
              <BrandMark className="size-11 text-agent drop-shadow-logo" />
              <span className="absolute -bottom-1 -right-1 rounded-full border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.5rem] font-bold text-agent">01</span>
            </div>
          </div>
          <ol className="my-5 space-y-3">
            {steps.map(([number, title, detail]) => (
              <li key={number} className="grid grid-cols-[2rem_5rem_minmax(0,1fr)] items-baseline gap-2">
                <span className="font-mono text-[0.6875rem] font-semibold text-agent">{number}</span>
                <span className="text-sm font-semibold text-ink">{title}</span>
                <span className="text-xs text-ink-3">{detail}</span>
              </li>
            ))}
          </ol>
          <ProvenanceBar legs={provenance} />
          <div className="mt-5 rounded-xl border border-refused-line bg-refused-soft px-4 py-3">
            <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-refused">Guardrail is executable policy</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">A model verdict cannot cross the payment boundary without passing deterministic checks.</p>
          </div>
        </div>
      </aside>
    </Card>
  );
}

export async function Hero() {
  // The founding organization's modes, like the landing metrics; chainModes()
  // still answers when its Circle credentials cannot be read (R12).
  const modes = await withFoundingOrg(async () => chainModes());
  const currentScreeningMode = screeningMode();
  const provenance: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: modes.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: modes.earnMode === "live" },
    { label: "Screening", detail: currentScreeningMode === "live" ? "OpenSanctions" : "bundled list", live: currentScreeningMode === "live" },
  ];

  return (
    <section className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
      <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
      <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_27rem] lg:items-center lg:py-24">
        <div>
          <Eyebrow className="text-agent">Autonomous treasury · Arc testnet</Eyebrow>
          <h1 className="mt-5 max-w-4xl text-balance text-5xl font-semibold leading-[0.97] tracking-[-0.055em] text-ink sm:text-7xl">
            Money moves.
            <br />
            <span className="font-serif font-normal italic text-agent">Evidence remains.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-[1.65rem]">
            Vestiarion screens counterparties, matches obligations, verifies work, and manages liquidity. A model proposes each action; code enforces the boundary; a signed ledger keeps the receipt.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={"/onboarding"}>See the agent run</Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="bg-surface/80">
              <Link href={"/onboarding"}>Verify the ledger</Link>
            </Button>
          </div>
        </div>
        <ProofPanel provenance={provenance} />
      </div>
    </section>
  );
}
