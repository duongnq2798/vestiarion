import type { Metadata } from "next";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { getInsightsData } from "@/lib/insights";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("insights") };

export default async function InsightsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [data, dashboardStats] = await Promise.all([getInsightsData(), stats()]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("insights")}
          sub="Measured outcomes: receipts from completed cycles, payment execution, and screening checks. Empty space means the system has not measured it yet."
        />
        <InsightsCharts data={data} />
      </ProductShell>
    );
  });
}
