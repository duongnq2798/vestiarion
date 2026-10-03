import type { Metadata } from "next";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import DeleteWorkspacePanel from "@/components/DeleteWorkspacePanel";
import GoLivePanel from "@/components/GoLivePanel";
import LedgerKeyPanel from "@/components/LedgerKeyPanel";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import WebhooksPanel from "@/components/WebhooksPanel";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listApiKeys } from "@/lib/platform/api-keys";
import { deletionContext } from "@/lib/platform/delete-workspace";
import { goLiveStatus } from "@/lib/platform/go-live";
import { ledgerKeyStatus } from "@/lib/platform/ledger-key";
import { usycReserveStatus } from "@/lib/platform/usyc-reserve";
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
    const canAdminister = can(membership.role, "org.administer");
    const [goLive, apiKeys, webhookEndpoints, ledgerKey, dashboardStats, deletion, usyc] = await Promise.all([
      goLiveStatus(membership.orgId),
      listApiKeys(membership.orgId),
      listWebhookEndpoints(membership.orgId),
      ledgerKeyStatus(membership.orgId),
      stats(),
      // Only an owner sees the danger zone, so only an owner's page reads what it says.
      canAdminister ? deletionContext(membership.orgId) : null,
      // Best effort: a reserve status that cannot be read hides its section, nothing else.
      usycReserveStatus(membership.orgId).catch((error: unknown) => {
        console.error("settings: USYC reserve status not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
    ]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("settings")}
          sub="Taking this workspace live, the USYC reserve, API keys, outgoing webhooks, the ledger signing key, and deleting the workspace. An owner takes it live, rotates the signing key, or deletes it; an owner or admin manages API keys and webhooks, and a secret is shown once, right after it is created."
        />
        <div className="space-y-12">
          {/* goLiveStatus carries no credential and no wallet id, so the whole status can cross into the client component. */}
          <GoLivePanel orgSlug={slug} status={goLive} canAdminister={canAdminister} />
          {usyc && <UsycReservePanel orgSlug={slug} status={usyc} canManage={can(membership.role, "treasury.manage")} />}
          <ApiKeysPanel orgSlug={slug} apiKeys={apiKeys} canManage={canManageKeys} />
          {/* The full URL never crosses into the client component for a non-manager — built server-side, not just hidden at render time. */}
          <WebhooksPanel orgSlug={slug} endpoints={toWebhookEndpointViews(webhookEndpoints, canManageWebhooks)} canManage={canManageWebhooks} />
          <LedgerKeyPanel orgSlug={slug} status={ledgerKey} canAdminister={canAdminister} />
          {/* deletionContext carries counts and booleans only; the panel renders nothing for the founding workspace. */}
          {deletion && <DeleteWorkspacePanel orgSlug={slug} context={deletion} canAdminister={canAdminister} />}
        </div>
      </ProductShell>
    );
  });
}
