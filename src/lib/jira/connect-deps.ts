import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { NotSetUpError } from "../connectors/connections";
import { JiraNotSetUpError, jiraReady } from "./links";
import { jiraProvider, type JiraProvider } from "./provider";
import type { JiraSettings } from "./settings";
import { ensureJiraSite } from "./webhooks";

/**
 * Jira's connect flow as the routes run it (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2): the
 * deployment's own origin, whose callback is registered for the app as
 * https://www.vestiarion.xyz/api/integrations/jira/callback, and a check that migration 0149 has run before anyone goes
 * to Atlassian. One site is connected at once; several are offered on the connect page, and the one picked is posted to
 * the choose route. Once the answer is sent, the first upkeep runs in the workspace's scope, as Pipedrive's first sync
 * does: the site row saved, the app's orphan webhooks on the site deleted, and the webhook made only when links exist.
 * No issue is read then: an issue is read when a person links it to a milestone.
 */
export function jiraConnectDeps(settings: JiraSettings, provider: JiraProvider = jiraProvider(settings)): ConnectDeps {
  return {
    provider,
    origin: siteOrigin(),
    ready: async () => {
      try {
        await jiraReady();
      } catch (error) {
        if (error instanceof JiraNotSetUpError) throw new NotSetUpError();
        throw error;
      }
    },
    afterConnect: (work) => after(work),
    firstSync: (connection) => ensureJiraSite(connection, provider),
  };
}
