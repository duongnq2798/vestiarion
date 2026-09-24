import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { getInsightsData } from "@/lib/insights";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const [data, dashboardStats] = await Promise.all([getInsightsData(), stats()]);

  return (
    <ProductShell active="insights" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt}>
      <PageHead
        title="Measured outcomes"
        sub="Receipts from completed cycles, payment execution, and screening checks. Empty space means the system has not measured it yet."
      />
      <InsightsCharts data={data} />
    </ProductShell>
  );
}
