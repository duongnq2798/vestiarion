import type { Metadata } from "next";
import ApiKeysPanel from "@/components/ApiKeysPanel";
import DeleteAccountPanel from "@/components/DeleteAccountPanel";
import DeleteWorkspacePanel from "@/components/DeleteWorkspacePanel";
import EmailInboxPanel from "@/components/EmailInboxPanel";
import GoLivePanel from "@/components/GoLivePanel";
import GitHubPanel from "@/components/GitHubPanel";
import AsanaPanel from "@/components/AsanaPanel";
import GoogleSheetsPanel from "@/components/GoogleSheetsPanel";
import HubSpotPanel from "@/components/HubSpotPanel";
import PipedrivePanel from "@/components/PipedrivePanel";
import ZohoCrmPanel from "@/components/ZohoCrmPanel";
import BankPayoutsPanel, { type BankPayoutsView } from "@/components/BankPayoutsPanel";
import { bankPayoutsReady, countBankAccountsInUse, readPayoutPartner } from "@/lib/bank-payouts/store";
import { testTokenView } from "@/lib/bank-payouts/test-token";
import { refreshPartnerStatus } from "@/lib/bank-payouts/commands";
import { blindpaySettingsFromEnv } from "@/lib/blindpay/settings";
import LedgerKeyPanel from "@/components/LedgerKeyPanel";
import NotificationsPanel from "@/components/NotificationsPanel";
import { SettingsSections, type SettingsGroup } from "@/components/SettingsSections";
import ReportingCurrencyPanel from "@/components/ReportingCurrencyPanel";
import ShadowModePanel from "@/components/ShadowModePanel";
import SlackPanel from "@/components/SlackPanel";
import DiscordPanel from "@/components/DiscordPanel";
import TwoApprovalsPanel from "@/components/TwoApprovalsPanel";
import PayeeLockPanel from "@/components/PayeeLockPanel";
import DocumentRequestsPanel from "@/components/DocumentRequestsPanel";
import EarnedVendorsPanel from "@/components/EarnedVendorsPanel";
import { readDocumentChecksStatus } from "@/lib/document-requests/setting";
import { readEarnedVendorRule } from "@/lib/earned-vendors-store";
import { readPayeeLockStatus } from "@/lib/payee-lock";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import UsagePanel from "@/components/UsagePanel";
import WebhooksPanel from "@/components/WebhooksPanel";
import AccountingPanel from "@/components/AccountingPanel";
import ChromeExtensionPanel, { type ConnectionView } from "@/components/ChromeExtensionPanel";
import { extensionSettingsFromEnv } from "@/lib/extension/settings";
import { listConnections } from "@/lib/extension/tokens";
import { listMembers } from "@/lib/platform/members";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { twoApprovalsStatus } from "@/lib/approval-policy";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { paysSimulated } from "@/lib/capability";
import { readCapability } from "@/lib/capability-read";
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
import { discordPanelView } from "@/lib/discord/panel";
import { slackSettingsFromEnv } from "@/lib/slack/settings";
import { accountingPanelView } from "@/lib/connectors/panel";
import { accountingProvider, accountingProviderOn } from "@/lib/accounting-providers";
import { crmPanelView, type CrmPanelView } from "@/lib/connectors/crm-review";
import { NotSetUpError } from "@/lib/connectors/connections";
import { asanaPanelFor } from "@/lib/asana/panel";
import { googleSheetsPanelFor } from "@/lib/googlesheets/panel";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";
import { pipedriveSettingsFromEnv } from "@/lib/pipedrive/settings";
import { pipedriveReady } from "@/lib/pipedrive/store";
import { zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";
import { zohoCrmReady } from "@/lib/zohocrm/store";
import { crmReceiptsPanelFor } from "@/lib/connectors/crm-receipts-view";
import { crmProvider } from "@/lib/crm-providers";
import { linkFor as telegramLinkFor } from "@/lib/telegram/links";
import { telegramSettingsFromEnv } from "@/lib/telegram/settings";
import { networkProfile } from "@/lib/network";
import { readShadowMode } from "@/lib/shadow-mode";
import { shellStatus } from "@/lib/shell-status";
import { readUsageLimits, readUsageMonth } from "@/lib/usage/read";
import { readReportingCurrency } from "@/lib/reporting-currency";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("settings") };

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ slack?: string | string[]; github?: string | string[]; xero?: string | string[]; quickbooks?: string | string[]; zohobooks?: string | string[]; hubspot?: string | string[]; pipedrive?: string | string[]; zohocrm?: string | string[]; bankpayouts?: string | string[] }>;
}) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { membership } = access;
    const canManageKeys = can(membership.role, "api_keys.manage");
    const canManageWebhooks = can(membership.role, "webhooks.manage");
    const canAdminister = can(membership.role, "org.administer");
    const canDecide = can(membership.role, "approval.decide");
    // An accountant answers customers without deciding payments: its email switch is about customers (accountant console A1).
    const canAnswerCustomers = can(membership.role, "receivables.reconcile");
    // Every member may connect their own Telegram chat, when this deployment has a bot (Telegram bot design R1, R4).
    const telegramOn = telegramSettingsFromEnv() !== null;
    // How connecting Slack went, from its way back (Slack design S3); only the codes the panel knows are shown.
    // And how connecting GitHub went (GitHub App design G2).
    // And how connecting Xero or QuickBooks went (Xero connector X4; QuickBooks connector Q4), and HubSpot (HubSpot H4).
    const { slack: slackOutcome, github: githubOutcome, xero: xeroOutcome, quickbooks: quickBooksOutcome, zohobooks: zohoBooksOutcome, hubspot: hubspotOutcome, pipedrive: pipedriveOutcome, zohocrm: zohoCrmOutcome } = await searchParams;
    const inboxSettings = inboxSettingsFromEnv();
    const [goLive, apiKeys, webhookEndpoints, ledgerKey, dashboardStats, deletion, usyc, slack, notifySwitch, telegramLink, inbox, github, twoApprovals, shadow, xero, quickBooks, zohoBooks, hubspot, usage, limits, reportingCurrency] = await Promise.all([
      goLiveStatus(membership.orgId),
      listApiKeys(membership.orgId),
      listWebhookEndpoints(membership.orgId),
      ledgerKeyStatus(membership.orgId),
      stats(),
      // Only an owner sees Delete workspace in the danger zone, so only an owner's page reads what it says.
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
      // Only on a deployment where Xero is configured (Xero connector X16); best effort, like Slack's. Before migration
      // 0101 the card says Xero is not set up yet.
      accountingProviderOn("xero")
        ? accountingPanelView("xero", Date.now(), { writeScopes: accountingProvider("xero")?.booking?.writeScopes }).catch((error: unknown) => {
            console.error("settings: Xero status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // And QuickBooks, its own card beside Xero's (QuickBooks connector Q19): a workspace may connect either or both.
      accountingProviderOn("quickbooks")
        ? accountingPanelView("quickbooks", Date.now(), { writeScopes: accountingProvider("quickbooks")?.booking?.writeScopes }).catch((error: unknown) => {
            console.error("settings: QuickBooks status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // And Zoho Books, its own card beside them (Zoho Books connector Z1); before migration 0122 it says it is not set up.
      accountingProviderOn("zohobooks")
        ? accountingPanelView("zohobooks", Date.now(), { writeScopes: accountingProvider("zohobooks")?.booking?.writeScopes }).catch((error: unknown) => {
            console.error("settings: Zoho Books status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // Only on a deployment where HubSpot is configured (HubSpot connector H17); best effort, like Xero's. Before migration
      // 0105 the card says HubSpot is not set up yet.
      hubspotSettingsFromEnv()
        ? crmPanelView("hubspot").catch((error: unknown) => {
            console.error("settings: HubSpot status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null,
      // This month's usage and the limits (accountant console U3, U4): best effort, each on its own.
      readUsageMonth().catch((error: unknown) => {
        console.error("settings: usage not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
      readUsageLimits({ orgId: membership.orgId, mode: membership.mode }).catch((error: unknown) => {
        console.error("settings: limits not loaded", error instanceof Error ? error.message : error);
        return [];
      }),
      // The reporting currency (currency provenance M4); best effort: a section that cannot be read is left out.
      readReportingCurrency(db()).catch((error: unknown) => {
        console.error("settings: reporting currency not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
    ]);
    // The payee lock (payee lock PL1), asking vendors for missing documents (document requests ER1) and the rule for
    // earned vendors (earned vendors AL11), read together; best effort, like two approvals: a section that cannot be
    // read is left out.
    const [payeeLock, documentRequests, earnedRule] = await Promise.all([
      readPayeeLockStatus(db()).catch((error: unknown) => {
        console.error("settings: payee lock not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
      readDocumentChecksStatus(db()).catch((error: unknown) => {
        console.error("settings: document requests not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
      readEarnedVendorRule(db()).catch((error: unknown) => {
        console.error("settings: earned vendors not loaded", error instanceof Error ? error.message : error);
        return null;
      }),
    ]);
    // What the workspace's payments do now, which Go live and Shadow mode say in the header's words (capability and
    // reasons R5, R7). Shadow mode as read above; null when it could not be.
    const capability = await readCapability({ shadow: shadow ? shadow.mode !== null : null });
    // Receipts written to HubSpot (CRM receipts R8): once connected, best effort; nothing before migration 0107.
    const hubspotWriteScopes = crmProvider("hubspot")?.receipts?.writeScopes ?? null;
    const hubspotReceipts =
      hubspot?.state === "connection" && hubspotWriteScopes
        ? await crmReceiptsPanelFor(hubspot.connectionId, hubspotWriteScopes).catch((error: unknown) => {
            console.error("settings: HubSpot receipts not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null;
    // Pipedrive's card (Pipedrive connector P16, P17), on a deployment where Pipedrive is configured; best effort. Before
    // migration 0116 it says Pipedrive is not set up yet.
    const pipedrive: CrmPanelView | null = pipedriveSettingsFromEnv()
      ? await pipedriveReady()
          .then(() => crmPanelView("pipedrive"))
          .catch((error: unknown): CrmPanelView | null => {
            if (error instanceof NotSetUpError) return { state: "not_set_up" };
            console.error("settings: Pipedrive status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
      : null;
    // Receipts written to Pipedrive (P11, P12): Pipedrive names no test company, so the panel says when this workspace
    // never writes to it.
    const pipedriveWriter = crmProvider("pipedrive")?.receipts ?? null;
    const pipedriveReceipts =
      pipedrive?.state === "connection" && pipedriveWriter
        ? await crmReceiptsPanelFor(pipedrive.connectionId, pipedriveWriter.writeScopes, { testAccounts: pipedriveWriter.testAccounts }).catch((error: unknown) => {
            console.error("settings: Pipedrive receipts not loaded", error instanceof Error ? error.message : error);
            return null;
          })
        : null;
    // Zoho CRM's card (Zoho CRM connector C16, C17), on a deployment with the Zoho client; best effort. Before migration
    // 0123 it says Zoho CRM is not set up yet. It writes nothing, so it has no receipts.
    // Bank payouts (bank payouts B3), on a deployment with a BlindPay instance; best effort. Before migration 0124 the card
    // says they are not set up yet.
    const bankPayouts: BankPayoutsView | null = blindpaySettingsFromEnv()
      ? await bankPayoutsReady()
          .then(async (): Promise<BankPayoutsView> => {
            let partner = await readPayoutPartner();
            if (!partner?.customerId) return { state: "not_started" };
            // BlindPay reviews the business after set-up: its status is read from BlindPay again until it is approved (B3).
            if (partner.kybStatus !== "approved") partner = (await refreshPartnerStatus().then(readPayoutPartner).catch(() => partner)) ?? partner;
            return {
              state: "set_up",
              kybStatus: partner.kybStatus,
              setUpAt: partner.setUpAt,
              vendors: await countBankAccountsInUse(),
              testToken: await testTokenView().catch(() => null),
            };
          })
          .catch((error: unknown): BankPayoutsView | null => {
            if (error instanceof NotSetUpError) return { state: "not_set_up" };
            console.error("settings: bank payouts not loaded", error instanceof Error ? error.message : error);
            return null;
          })
      : null;
    const bankPayoutsOutcome = ((await searchParams) as { bankpayouts?: string | string[] }).bankpayouts;
    const zohoCrm: CrmPanelView | null = zohoCrmSettingsFromEnv()
      ? await zohoCrmReady()
          .then(() => crmPanelView("zohocrm"))
          .catch((error: unknown): CrmPanelView | null => {
            if (error instanceof NotSetUpError) return { state: "not_set_up" };
            console.error("settings: Zoho CRM status not loaded", error instanceof Error ? error.message : error);
            return null;
          })
      : null;
    // Asana (Asana acceptance A16): only on a deployment where it is configured; best effort, like HubSpot's. Before
    // migration 0115 the card says Asana is not set up yet. How connecting it went comes back in `?asana=`.
    const asana = await asanaPanelFor().catch((error: unknown) => {
      console.error("settings: Asana status not loaded", error instanceof Error ? error.message : error);
      return null;
    });
    const asanaOutcome = ((await searchParams) as { asana?: string | string[] }).asana;
    // Google Sheets (close pack Sheets GS2): only on a deployment with its Google client; best effort, like Asana's.
    // Before migration 0145 the card says Google Sheets is not set up yet. How connecting it went comes back in
    // `?googlesheets=`.
    const googleSheets = await googleSheetsPanelFor().catch((error: unknown) => {
      console.error("settings: Google Sheets status not loaded", error instanceof Error ? error.message : error);
      return null;
    });
    const googleSheetsOutcome = ((await searchParams) as { googlesheets?: string | string[] }).googlesheets;
    // Discord (Discord design DC6): on every deployment, since a channel webhook needs no app; best effort, like Slack's.
    // Before migration 0140 the section says Discord is not set up yet. Never the webhook's URL.
    const discord = await discordPanelView(membership.orgId, access.user.id).catch((error: unknown) => {
      console.error("settings: Discord status not loaded", error instanceof Error ? error.message : error);
      return null;
    });
    // The Chrome extensions connected to this workspace (invoice capture C17), on a deployment that allows one: a
    // person's own, or everyone's for an owner or admin. Best effort; before migration 0121 the section says it is not
    // set up yet.
    const seesEveryoneExtension = can(membership.role, "integrations.manage");
    const extensions: { available: boolean; connections: ConnectionView[] } | null = extensionSettingsFromEnv()
      ? await listConnections(membership.orgId, seesEveryoneExtension ? {} : { userId: access.user.id })
          .then(async (listed) => {
            if (!listed.available) return { available: false, connections: [] };
            const emails = seesEveryoneExtension && listed.connections.some((connection) => connection.userId !== access.user.id)
              ? new Map((await listMembers(membership.orgId)).map((member) => [member.userId, member.email]))
              : new Map<string, string>();
            return {
              available: true,
              connections: listed.connections.map((connection) => ({
                id: connection.id,
                member: emails.get(connection.userId) ?? null,
                mine: connection.userId === access.user.id,
                client: connection.clientId,
                connectedAt: connection.connectedAt,
                lastUsedAt: connection.lastUsedAt,
              })),
            };
          })
          .catch((error: unknown) => {
            console.error("settings: Chrome extensions not loaded", error instanceof Error ? error.message : error);
            return null;
          })
      : null;
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
              canDecide || canAnswerCustomers || telegramOn ? (
                <NotificationsPanel
                  orgSlug={slug}
                  canDecide={canDecide}
                  canAnswerCustomers={canAnswerCustomers}
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
          { id: "go-live-title", title: "Go live", content: <GoLivePanel orgSlug={slug} status={goLive} canAdminister={canAdminister} capability={capability} /> },
          {
            id: "shadow-mode-title",
            title: "Shadow mode",
            // What shadow mode pays names the earned vendors the agent pays on its own while the switch is on (AL28).
            content: shadow ? (
              <ShadowModePanel
                orgSlug={slug}
                mode={shadow.mode}
                network={membership.network}
                canChange={can(membership.role, "approval.policy")}
                capability={capability}
                earnedPayments={earnedRule?.payments === true}
              />
            ) : null,
          },
          // Beside shadow mode, whose verdicts it counts (earned vendors AL11), with the switch that lets the agent pay earned
          // vendors on their own (AL21), in the capability's words; left out on Arc mainnet, which has neither.
          {
            id: "earned-vendors-title",
            title: "Earned vendors",
            content:
              earnedRule && membership.network !== "arc-mainnet" ? (
                <EarnedVendorsPanel
                  orgSlug={slug}
                  status={{ streak: earnedRule.streak, ready: earnedRule.ready, payments: earnedRule.payments }}
                  simulated={capability ? paysSimulated(capability) : false}
                  canChange={can(membership.role, "approval.policy")}
                />
              ) : null,
          },
          {
            id: "reporting-currency-title",
            title: "Reporting currency",
            content: reportingCurrency ? (
              <ReportingCurrencyPanel
                orgSlug={slug}
                available={reportingCurrency.available}
                setting={reportingCurrency.available ? reportingCurrency.setting : null}
                canChange={can(membership.role, "reporting.manage")}
              />
            ) : null,
          },
          {
            id: "usyc-reserve-title",
            title: "USYC reserve",
            content: usyc ? <UsycReservePanel orgSlug={slug} status={usyc} canManage={can(membership.role, "treasury.manage")} capability={capability} /> : null,
          },
          // What the workspace used this month and its limits, for every member (accountant console U3, U4).
          { id: "usage-title", title: "Usage this month", content: <UsagePanel orgSlug={slug} usage={usage} limits={limits} /> },
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
            id: "discord-title",
            title: "Discord",
            content: discord ? <DiscordPanel orgSlug={slug} view={discord} canManage={canManageIntegrations} /> : null,
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
            id: "xero-title",
            title: "Xero",
            content: xero ? (
              <AccountingPanel provider="xero" orgSlug={slug} view={xero} canManage={canManageIntegrations} notice={typeof xeroOutcome === "string" ? xeroOutcome : null} />
            ) : null,
          },
          {
            id: "quickbooks-title",
            title: "QuickBooks",
            content: quickBooks ? (
              <AccountingPanel
                provider="quickbooks"
                orgSlug={slug}
                view={quickBooks}
                canManage={canManageIntegrations}
                notice={typeof quickBooksOutcome === "string" ? quickBooksOutcome : null}
              />
            ) : null,
          },
          {
            id: "zohobooks-title",
            title: "Zoho Books",
            content: zohoBooks ? (
              <AccountingPanel
                provider="zohobooks"
                orgSlug={slug}
                view={zohoBooks}
                canManage={canManageIntegrations}
                notice={typeof zohoBooksOutcome === "string" ? zohoBooksOutcome : null}
              />
            ) : null,
          },
          {
            id: "hubspot-title",
            title: "HubSpot",
            content: hubspot ? (
              <HubSpotPanel
                orgSlug={slug}
                view={hubspot}
                canManage={canManageIntegrations}
                notice={typeof hubspotOutcome === "string" ? hubspotOutcome : null}
                receipts={hubspotReceipts}
              />
            ) : null,
          },
          {
            id: "pipedrive-title",
            title: "Pipedrive",
            content: pipedrive ? (
              <PipedrivePanel
                orgSlug={slug}
                view={pipedrive}
                canManage={canManageIntegrations}
                notice={typeof pipedriveOutcome === "string" ? pipedriveOutcome : null}
                receipts={pipedriveReceipts}
              />
            ) : null,
          },
          {
            id: "zohocrm-title",
            title: "Zoho CRM",
            content: zohoCrm ? (
              <ZohoCrmPanel orgSlug={slug} view={zohoCrm} canManage={canManageIntegrations} notice={typeof zohoCrmOutcome === "string" ? zohoCrmOutcome : null} />
            ) : null,
          },
          {
            id: "bank-payouts-title",
            title: "Bank payouts",
            content: bankPayouts ? (
              <BankPayoutsPanel
                orgSlug={slug}
                view={bankPayouts}
                canSetUp={can(membership.role, "org.administer")}
                canMint={canManageIntegrations}
                notice={typeof bankPayoutsOutcome === "string" ? bankPayoutsOutcome : null}
              />
            ) : null,
          },
          {
            id: "asana-title",
            title: "Asana",
            content: asana ? (
              <AsanaPanel orgSlug={slug} view={asana} canManage={canManageIntegrations} notice={typeof asanaOutcome === "string" ? asanaOutcome : null} />
            ) : null,
          },
          {
            id: "googlesheets-title",
            title: "Google Sheets",
            content: googleSheets ? (
              <GoogleSheetsPanel
                orgSlug={slug}
                view={googleSheets}
                canManage={canManageIntegrations}
                notice={typeof googleSheetsOutcome === "string" ? googleSheetsOutcome : null}
              />
            ) : null,
          },
          {
            id: "chrome-extension-title",
            title: "Chrome extension",
            content: extensions ? (
              <ChromeExtensionPanel orgSlug={slug} available={extensions.available} connections={extensions.connections} seesEveryone={seesEveryoneExtension} />
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
          {
            id: "payee-lock-title",
            title: "Payee lock",
            content: payeeLock ? <PayeeLockPanel orgSlug={slug} status={payeeLock} canChange={can(membership.role, "approval.policy")} /> : null,
          },
          {
            // Beside the payee lock: an owner's switch for asking vendors for a bill's missing document (document requests ER1).
            id: "document-requests-title",
            title: "Ask vendors for missing documents",
            content: documentRequests ? (
              <DocumentRequestsPanel orgSlug={slug} status={documentRequests} canChange={can(membership.role, "approval.policy")} />
            ) : null,
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
          // Every member's own account, whatever their role: deleting it needs none (delete account in Settings DA3).
          { id: "delete-account-title", title: "Delete account", content: <DeleteAccountPanel /> },
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
