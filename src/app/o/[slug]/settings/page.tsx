import type { Metadata } from "next";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import DeleteWorkspacePanel from "@/components/DeleteWorkspacePanel";
import EmailInboxPanel from "@/components/EmailInboxPanel";
import GoLivePanel from "@/components/GoLivePanel";
import GitHubPanel from "@/components/GitHubPanel";
import LedgerKeyPanel from "@/components/LedgerKeyPanel";
import NotificationsPanel from "@/components/NotificationsPanel";
import { SettingsSections, type SettingsGroup } from "@/components/SettingsSections";
import ShadowModePanel from "@/components/ShadowModePanel";
import SlackPanel from "@/components/SlackPanel";
import TwoApprovalsPanel from "@/components/TwoApprovalsPanel";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import WebhooksPanel from "@/components/WebhooksPanel";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { twoApprovalsStatus } from "@/lib/approval-policy";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { shellModes } from "@/lib/circle";
import { db, platformDb, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { inboxFor } from "@/lib/email-inbox/inboxes";
import { inboxAddress, inboxSettingsFromEnv } from "@/lib/email-inbox/settings";
import { listApiKeys } from "@/lib/platform/api-keys";
import { deletionContext } from "@/lib/platform/delete-workspace";
import { goLiveStatus } from "@/lib/platform/go-live";
import { ledgerKeyStatus } from "@/lib/platform/ledger-key";
import { usycReserveStatus } from "@/lib/platform/usyc-reserve";
import { listWebhookEndpoints, toWebhookEndpointViews } from "@/lib/platform/webhooks";
import { stats } from "@/lib/queries";
import { githubInstallations } from "@/lib/github/installs";
import { githubAppSettingsFromEnv } from "@/lib/github/settings";
import { slackPanelView } from "@/lib/slack/panel";
import { slackSettingsFromEnv } from "@/lib/slack/settings";
import { linkFor as telegramLinkFor } from "@/lib/telegram/links";
import { telegramSettingsFromEnv } from "@/lib/telegram/settings";
import { networkProfile } from "@/lib/network";
import { readShadowMode } from "@/lib/shadow-mode";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("settings") };

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ slack?: string | string[]; github?: string | string[] }>;
}) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { membership } = access;
    const canManageKeys = can(membership.role, "api_keys.manage");
    const canManageWebhooks = can(membership.role, "webhooks.manage");
    const canAdminister = can(membership.role, "org.administer");
    const canDecide = can(membership.role, "approval.decide");
    // Every member may connect their own Telegram chat, when this deployment has a bot (Telegram bot design R1, R4).
    const telegramOn = telegramSettingsFromEnv() !== null;
    // How connecting Slack went, from its way back (Slack design S3); only the codes the panel knows are shown.
    // And how connecting GitHub went (GitHub App design G2).
    const { slack: slackOutcome, github: githubOutcome } = await searchParams;
    const inboxSettings = inboxSettingsFromEnv();
    const [goLive, apiKeys, webhookEndpoints, ledgerKey, dashboardStats, deletion, usyc, slack, notifySwitch, telegramLink, inbox, github, twoApprovals, shadow] = await Promise.all([
      goLiveStatus(membership.orgId),
      listApiKeys(membership.orgId),
      listWebhookEndpoints(membership.orgId),
      ledgerKeyStatus(membership.orgId),
      stats(),
      // Only an owner sees the danger zone, so only an owner's page reads what it says.
      canAdminister ? deletionContext(membership.orgId) : null,
      // Best effort: a reserve status that cannot be read hides its section, nothing else. Only a network with a
      // reserve has one to show (mainnet copy C3).
      networkProfile(membership.network).usyc
        ? usycReserveStatus(membership.orgId).catch((error: unknown) => {
            console.error("settings: USYC reserve status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // Only on a deployment where Slack is configured; best effort, like the reserve's.
      slackSettingsFromEnv()
        ? slackPanelView(membership.orgId, access.user.id).catch((error: unknown) => {
            console.error("settings: Slack status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // Only a member who can decide payments has an email to switch; a viewer receives nothing, so their row is not read.
      canDecide
        ? platformDb().from("memberships").select("notify_email").eq("org_id", membership.orgId).eq("user_id", access.user.id).single()
        : null,
      telegramOn ? telegramLinkFor(membership.orgId, access.user.id) : null,
      // Only on a deployment that receives invoices by email; best effort, like Slack's.
      inboxSettings
        ? inboxFor(membership.orgId).catch((error: unknown) => {
            console.error("settings: invoice address not loaded", error instanceof Error ? error.message : error);
            return undefined;
          })
        : undefined,
      // Only on a deployment where the GitHub App is configured (GitHub App design G9); best effort, like Slack's.
      githubAppSettingsFromEnv()
        ? githubInstallations(membership.orgId).catch((error: unknown) => {
            console.error("settings: GitHub connections not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // The figure for two approvals (two approvals T1); best effort, like the reserve's.
      twoApprovalsStatus().catch((error: unknown) => {
        console.error("settings: two approvals not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
      // Shadow mode (shadow mode S1); best effort, like two approvals: a section that cannot be read is left out.
      readShadowMode(db())
        .then((mode) => ({ mode }))
        .catch((error: unknown) => {
          console.error("settings: shadow mode not loaded", error instanceof Error ? error.message : error);
          return null;
        }),
    ]);
    const notifyEmail = notifySwitch ? (unwrap(notifySwitch) as { notify_email: boolean }).notify_email : false;

    const canManageIntegrations = can(membership.role, "integrations.manage");

    // Every section Settings has, grouped; each is null where this viewer or this deployment does not get it, and
    // SettingsSections leaves those out of the page and its contents alike (Settings structure design S1).
    const groups: SettingsGroup[] = [
      {
        key: "you",
        label: "You",
        sections: [
          {
            id: "notifications-title",
            title: "Notifications",
            content:
              canDecide || telegramOn ? (
                <NotificationsPanel
                  orgSlug={slug}
                  canDecide={canDecide}
                  notifyEmail={notifyEmail}
                  telegram={telegramOn ? { link: telegramLink ? { username: telegramLink.username, linkedAt: telegramLink.linkedAt } : null } : null}
                />
              ) : null,
          },
        ],
      },
      {
        key: "workspace",
        label: "Workspace",
        sections: [
          // goLiveStatus carries no credential and no wallet id, so the whole status can cross into the client component.
          { id: "go-live-title", title: "Go live", content: <GoLivePanel orgSlug={slug} status={goLive} canAdminister={canAdminister} /> },
          {
            id: "shadow-mode-title",
            title: "Shadow mode",
            content: shadow ? (
              <ShadowModePanel orgSlug={slug} mode={shadow.mode} network={membership.network} canChange={can(membership.role, "approval.policy")} />
            ) : null,
          },
          {
            id: "usyc-reserve-title",
            title: "USYC reserve",
            content: usyc ? <UsycReservePanel orgSlug={slug} status={usyc} canManage={can(membership.role, "treasury.manage")} /> : null,
          },
        ],
      },
      {
        key: "developers",
        label: "Developers",
        sections: [
          { id: "api-keys-title", title: "API keys", content: <ApiKeysPanel orgSlug={slug} apiKeys={apiKeys} canManage={canManageKeys} /> },
          {
            id: "webhooks-title",
            title: "Webhooks",
            // The full URL never crosses into the client component for a non-manager — built server-side, not just hidden at render time.
            content: <WebhooksPanel orgSlug={slug} endpoints={toWebhookEndpointViews(webhookEndpoints, canManageWebhooks)} canManage={canManageWebhooks} />,
          },
        ],
      },
      {
        key: "integrations",
        label: "Integrations",
        sections: [
          {
            id: "slack-title",
            title: "Slack",
            content: slack ? (
              <SlackPanel
                orgSlug={slug}
                view={slack}
                canManage={canManageIntegrations}
                canAdminister={canAdminister}
                notice={typeof slackOutcome === "string" ? slackOutcome : null}
              />
            ) : null,
          },
          {
            id: "github-title",
            title: "GitHub",
            content: github ? (
              <GitHubPanel
                network={membership.network}
                orgSlug={slug}
                installations={github}
                canManage={canManageIntegrations}
                notice={typeof githubOutcome === "string" ? githubOutcome : null}
              />
            ) : null,
          },
          {
            id: "email-inbox-settings-title",
            title: "Invoices by email",
            content:
              inboxSettings && inbox !== undefined ? (
                <EmailInboxPanel
                  orgSlug={slug}
                  // The address goes to an owner or admin alone: knowing it lets anyone file a draft.
                  view={inbox ? { on: true, address: canManageIntegrations ? inboxAddress(inbox.code, inboxSettings.domain) : null } : { on: false }}
                  canManage={canManageIntegrations}
                />
              ) : null,
          },
        ],
      },
      {
        key: "security",
        label: "Security",
        sections: [
          {
            id: "two-approvals-title",
            title: "Two approvals",
            content: twoApprovals ? <TwoApprovalsPanel
                orgSlug={slug}
                status={twoApprovals}
                canChange={can(membership.role, "approval.policy")}
                keepsFigure={membership.network === "arc-mainnet"}
              /> : null,
          },
          { id: "ledger-key-title", title: "Ledger signing key", content: <LedgerKeyPanel orgSlug={slug} status={ledgerKey} canAdminister={canAdminister} /> },
        ],
      },
      {
        key: "danger",
        label: "Danger zone",
        sections: [
          {
            id: "delete-workspace-title",
            title: "Delete workspace",
            // deletionContext carries counts and booleans only. Only an owner's page reads it, and never for the founding workspace.
            content: deletion && !deletion.isFounding ? <DeleteWorkspacePanel orgSlug={slug} context={deletion} canAdminister={canAdminister} /> : null,
          },
        ],
      },
    ];

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("settings")}
          sub="Your own notifications, and how this workspace goes live, connects to other tools, approves payments and signs its ledger. An owner takes it live, sets two approvals, rotates the ledger signing key or deletes it; an owner or admin manages API keys, webhooks and integrations."
        />
        <SettingsSections groups={groups} />
      </ProductShell>
    );
  });
}
