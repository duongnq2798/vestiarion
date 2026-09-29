import Link from "next/link";
import { Button } from "@/components/ui/Button";

export function FinalCta() {
  return (
    <section className="border-t border-line bg-agent text-on-agent">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-on-agent">Open the evidence, not a scripted demo.</h2>
          <p className="mt-2 text-sm text-on-agent/75">Inspect the current book, every refusal, and the chain verifier.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg" variant="inverse">
            <Link href={"/onboarding"}>Open console</Link>
          </Button>
          <Button asChild size="lg" variant="ghost" className="border border-on-agent/35 text-on-agent hover:bg-on-agent/10 hover:text-on-agent">
            <Link href={"/onboarding"}>Measured outcomes</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
