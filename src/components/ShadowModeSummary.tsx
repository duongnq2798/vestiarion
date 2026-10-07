import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { orgHref } from "@/lib/auth/org-paths";
import type { ShadowMode } from "@/lib/shadow-currency";

/**
 * The console's shadow mode panel (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S5): how often people agreed
 * with the agent, out of the verdicts given, and how many payables' decisions wait for one, with the page to give it.
 */
export default function ShadowModeSummary({
  orgSlug,
  mode,
  summary,
}: {
  orgSlug: string;
  mode: ShadowMode;
  summary: { agreed: number; disagreed: number; waiting: number };
}) {
  const given = summary.agreed + summary.disagreed;
  const rate = given > 0 ? Math.round((summary.agreed / given) * 100) : null;
  return (
    <section aria-labelledby="shadow-summary-title">
      <SectionHeader id="shadow-summary-title" title="Shadow mode" meta={`for bills in ${mode.currency}`} />
      <Card className="space-y-2 p-5">
        <p className="text-sm font-medium text-ink">
          {rate === null
            ? "No verdicts yet: agree or disagree with each decision as the agent makes it."
            : `You agreed with ${summary.agreed} of ${given} decisions (${rate}%).`}
        </p>
        {summary.waiting > 0 && (
          <p className="text-sm text-ink-2">
            {summary.waiting === 1 ? "1 decision waits for your verdict." : `${summary.waiting} decisions wait for your verdict.`}{" "}
            <Link href={orgHref(orgSlug, "/invoices")} className="font-medium text-agent underline-offset-2 hover:underline">
              See them in AP / AR
            </Link>
          </p>
        )}
        <p className="text-xs text-ink-3">Each payment you agree to is made in USDC on Arc testnet.</p>
      </Card>
    </section>
  );
}
