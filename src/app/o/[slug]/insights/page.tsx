import type { Metadata } from "next";
import { DecisionReasons } from "@/components/vx/DecisionReasons";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { readDecisionReasons } from "@/lib/decision-reasons";
import { getInsightsData } from "@/lib/insights";
import { shellClock } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("insights") };

export default async function InsightsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    // The reasons people gave as they went against the agent, for owners and admins (capability and reasons R13).
    const owner = access.membership.role === "owner" || access.membership.role === "admin";
    // The header needs the clock and nothing else `stats()` reads (every paid bill, two exact counts), and its status is
    // read with the rest, not after them.
    const [data, clock, reasons, status] = await Promise.all([
      getInsightsData(),
      shellClock(),
      owner ? readDecisionReasons(20) : Promise.resolve(null),
      shellStatus(),
    ]);

    return (
      <ProductShell network={access.membership.network} day={clock.day} clockMode={clock.clockMode} lastCycleAt={clock.lastCycleAt} chainModes={shellModes()} status={status}>
        <PageHead
          title={sectionTitle("insights")}
          sub="Measured outcomes: receipts from completed cycles, payment execution, and screening checks. Empty space means the system has not measured it yet."
        />
        <InsightsCharts data={data} />
        {reasons && (
          <div className="mt-5">
            <DecisionReasons read={reasons} />
          </div>
        )}
      </ProductShell>
    );
  });
}
