import { installFor } from "./installs";
import { linkFor } from "./links";

/**
 * What Settings shows of a workspace's Slack (Slack design S3, S4, S8): names, a date, the limit and whether the viewer
 * connected their own account. Never a token, a webhook URL or an envelope: this crosses into a client component.
 */
export type SlackPanelView =
  | { installed: false }
  | {
      installed: true;
      teamName: string | null;
      channelName: string | null;
      installedAt: string;
      decisionsLimitUsdc: number | null;
      youConnected: boolean;
    };

export async function slackPanelView(orgId: string, userId: string): Promise<SlackPanelView> {
  const install = await installFor(orgId);
  if (!install) return { installed: false };
  const link = await linkFor(orgId, userId);
  return {
    installed: true,
    teamName: install.teamName,
    channelName: install.channelName,
    installedAt: install.installedAt,
    decisionsLimitUsdc: install.decisionsLimitUsdc,
    youConnected: link !== null,
  };
}
