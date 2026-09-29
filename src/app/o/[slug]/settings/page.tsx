import type { Metadata } from "next";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listApiKeys } from "@/lib/platform/api-keys";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("settings") };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { membership } = access;
    const canManage = can(membership.role, "api_keys.manage");
    const [apiKeys, dashboardStats] = await Promise.all([listApiKeys(membership.orgId), stats()]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("settings")}
          sub="Read-only API keys for this workspace. An owner or admin creates and revokes them; a key's secret is shown once, right after it is created."
        />
        <ApiKeysPanel orgSlug={slug} apiKeys={apiKeys} canManage={canManage} />
      </ProductShell>
    );
  });
}
