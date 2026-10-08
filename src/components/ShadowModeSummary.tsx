import Link from "next/link";
import TestUsdcControl from "@/components/TestUsdcControl";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { orgHref } from "@/lib/auth/org-paths";
import type { ShadowMode } from "@/lib/shadow-currency";
import type { TestUsdcWeek } from "@/lib/test-usdc";
import type { TestUsdcView } from "@/lib/test-usdc-rules";

/** Where a person buys testnet USDC once the week's test USDC is used (test USDC T8). */
const TESTMINT = "https://testmint.myproceeds.xyz";
const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The console's shadow mode panel (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S5): how often people agreed
 * with the agent, out of the verdicts given, and how many payables' decisions wait for one, with the page to give it.
 * When the open bills need more than the operating wallet holds, it says how much, and offers an owner or admin that
 * much test USDC from Vestiarion's float (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T8).
 */
export default function ShadowModeSummary({
  orgSlug,
  mode,
  summary,
  testUsdc,
}: {
  orgSlug: string;
  mode: ShadowMode;
  summary: { agreed: number; disagreed: number; waiting: number };
  testUsdc?: { view: TestUsdcView | null; latest: TestUsdcWeek["latest"]; operatingAddress: string | null; latestTxUrl: string | null };
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
        {testUsdc?.view && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-sm text-ink-2">{`Your open bills need ${usdc(testUsdc.view.need)} USDC more than the operating wallet holds.`}</p>
            {testUsdc.view.action === "add" && <TestUsdcControl orgSlug={orgSlug} amount={testUsdc.view.amount} />}
            {testUsdc.view.action === "limit" && (
              <p className="text-sm text-ink-2">
                {`This workspace took its ${usdc(testUsdc.view.weeklyLimit)} test USDC for this week. For more, buy testnet USDC from `}
                <a href={TESTMINT} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
                  TestMint
                </a>
                {testUsdc.operatingAddress ? ` and send it to the operating wallet: ${testUsdc.operatingAddress}` : " and send it to the operating wallet."}
              </p>
            )}
          </div>
        )}
        {testUsdc?.latest && (
          <p className="text-xs text-ink-3">
            {`Last added: ${usdc(testUsdc.latest.amount)} test USDC on ${day(testUsdc.latest.at)}.`}
            {testUsdc.latestTxUrl && (
              <>
                {" "}
                <a href={testUsdc.latestTxUrl} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
                  View transaction
                </a>
              </>
            )}
          </p>
        )}
        <p className="text-xs text-ink-3">Each payment you agree to is made in USDC on Arc testnet.</p>
      </Card>
    </section>
  );
}
