import type { Metadata } from "next";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import WebhooksPanel from "@/components/WebhooksPanel";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listApiKeys } from "@/lib/platform/api-keys";
import { listWebhookEndpoints, toWebhookEndpointViews } from "@/lib/platform/webhooks";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("settings") };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { membership } = access;
    const canManageKeys = can(membership.role, "api_keys.manage");
    const canManageWebhooks = can(membership.role, "webhooks.manage");
    const [apiKeys, webhookEndpoints, dashboardStats] = await Promise.all([
      listApiKeys(membership.orgId),
      listWebhookEndpoints(membership.orgId),
      stats(),
    ]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("settings")}
          sub="Read-only API keys and outgoing webhooks for this workspace. An owner or admin manages them; a secret is shown once, right after it is created."
        />
        <div className="space-y-12">
          <ApiKeysPanel orgSlug={slug} apiKeys={apiKeys} canManage={canManageKeys} />
          {/* The full URL never crosses into the client component for a non-manager — built server-side, not just hidden at render time. */}
          <WebhooksPanel orgSlug={slug} endpoints={toWebhookEndpointViews(webhookEndpoints, canManageWebhooks)} canManage={canManageWebhooks} />
        </div>
      </ProductShell>
    );
  });
}
