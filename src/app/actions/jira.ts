"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { acceptJiraWork, checkJiraIssue, consoleActor, linkJiraIssue, setJiraAcceptanceCriteria, unlinkJiraIssue } from "@/lib/commands";
import { disconnectConnection } from "@/lib/connectors/connections";
import { connectionTokenStore } from "@/lib/connectors/token-store";
import { inOrg } from "@/lib/dal/scope";
import { jiraProviderFromEnv } from "@/lib/jira/provider";
import { jiraSession } from "@/lib/jira/session";
import { clearSite } from "@/lib/jira/sites";
import { stopJiraWebhooks } from "@/lib/jira/webhooks";
import { jiraContext, syncJiraConnection } from "@/lib/jira/workspace";
import { consoleAnswer } from "./command-result";

/**
 * Jira from the console (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR4, JR6, JR7, JR11, JR16):
 * checking the linked issues now and disconnecting are an owner's or admin's (`integrations.manage`); linking and
 * unlinking an issue, writing a milestone's criteria, accepting its work and checking one issue now are for whoever
 * verifies milestones (`records.write`), through their commands. Every action reads the person's role again and works
 * in the workspace's scope; nothing returned carries a token.
 */

export interface JiraActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_CONNECTED = "Jira is not connected to this workspace.";
const AT_ATLASSIAN = "To end Vestiarion's access at Atlassian too, remove it from Connected apps in your Atlassian account settings.";

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

/**
 * Disconnects Jira (JR4), in Asana's order: the webhooks are deleted at Jira while the token still works, current and
 * retired, and the site row with them whatever Jira answered; then the tokens. Atlassian gives apps no way to end their
 * own grant, so nothing is revoked at Atlassian, and the person is told where to end it.
 */
export async function disconnectJiraAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await jiraContext();
      const connection = found.connection;
      if (!connection || connection.status === "revoked") return { ok: false, message: NOT_CONNECTED };
      // A connection to reconnect has a token that may still work for the delete; if not, Jira ends the webhook itself.
      const provider = "missing" in found ? jiraProviderFromEnv() : found.provider;
      let deleted = false;
      if (provider) {
        const session = "missing" in found ? jiraSession({ provider, tokens: connectionTokenStore(connection.orgId, connection.id) }) : found.session;
        deleted = (await stopJiraWebhooks({ connection, provider, session })).deleted;
      } else {
        await clearSite(connection.orgId, connection.id);
      }
      await disconnectConnection({ connection, by: auth.user.id, revoke: async () => false });
      revalidateOrgPages();
      return {
        ok: true,
        message: deleted
          ? `Jira is disconnected, and its webhook deleted. Acceptances already recorded stay in Vestiarion. ${AT_ATLASSIAN}`
          : `Jira is disconnected. Jira ends its webhook within 30 days. Acceptances already recorded stay in Vestiarion. ${AT_ATLASSIAN}`,
      };
    } catch (error) {
      console.error("disconnectJiraAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Check linked issues now: one forced run of the sweeper's read, for this workspace (JR16). */
export async function syncJiraNowAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await jiraContext();
      if ("missing" in found) return { ok: false, message: found.missing === "reconnect" ? "Jira needs you to reconnect. Reconnect it from this card." : NOT_CONNECTED };
      const result = await syncJiraConnection(found.connection.id, found.provider, { force: true });
      revalidateOrgPages();
      if (result.outcome === "synced") {
        const read = result.summary?.read ?? 0;
        return { ok: true, message: read === 0 ? "Checked. No open milestone is linked to a Jira issue." : `Checked ${read} linked ${read === 1 ? "issue" : "issues"}.` };
      }
      if (result.outcome === "busy") return { ok: false, message: "A check is running already. Look again in a minute." };
      if (result.outcome === "reconnect") return { ok: false, message: "Jira needs you to reconnect. Reconnect it from this card." };
      return { ok: false, message: "The check stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncJiraNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Links a milestone to the issue a pasted link or key names (`issue`: `https://<site>/browse/ENG-123` or `ENG-123`). A
 * link over 1,000 characters is refused by the command, not cut to fit.
 */
export async function linkJiraIssueAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await linkJiraIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId"), issue: text(formData, "issue").slice(0, 1001) })));
}

export async function unlinkJiraIssueAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await unlinkJiraIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId") })));
}

export async function setJiraCriteriaAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(await setJiraAcceptanceCriteria(consoleActor(auth), { milestoneId: text(formData, "milestoneId"), criteria: text(formData, "criteria").slice(0, 4000) }))
  );
}

/** Accepts the work against its criteria, as the deliverables and the criteria the page showed (JR11). */
export async function acceptJiraWorkAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(
      await acceptJiraWork(consoleActor(auth), {
        milestoneId: text(formData, "milestoneId"),
        fingerprint: text(formData, "fingerprint"),
        criteriaSha256: text(formData, "criteriaSha256"),
        confirmed: text(formData, "confirmed") === "yes",
      })
    )
  );
}

export async function checkJiraIssueAction(_previous: JiraActionResult, formData: FormData): Promise<JiraActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await checkJiraIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId") })));
}
