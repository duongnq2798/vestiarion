"use server";

import "server-only";

import { after } from "next/server";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import type { AsanaChoice } from "@/lib/asana/map";
import { readFailureWords } from "@/lib/asana/reads";
import { asanaContext, markReconnect, needsReconnect, stopWebhooks, syncAsanaConnection } from "@/lib/asana/workspace";
import { acceptMilestoneWork, checkAsanaTask, consoleActor, linkAsanaTask, setAcceptanceCriteria, unlinkAsanaTask } from "@/lib/commands";
import { disconnectConnection } from "@/lib/connectors/connections";
import { inOrg, withOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";

/**
 * Asana from the console (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A4, A5, A8): checking the
 * linked tasks now and disconnecting are an owner's or admin's (`integrations.manage`); browsing Asana to pick a task,
 * linking and unlinking it, writing a milestone's criteria and accepting its work are for whoever verifies milestones
 * (`records.write`), through their commands. Every action reads the person's role again and works in the workspace's
 * scope; nothing returned carries a token.
 */

export interface AsanaActionResult {
  ok: boolean;
  message: string;
}

export interface AsanaChoicesResult {
  ok: boolean;
  message: string;
  choices: AsanaChoice[];
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_CONNECTED = "Asana is not connected to this workspace.";

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

const GID = /^[0-9]{1,32}$/;

/** Disconnects Asana: its webhooks are deleted while the token still works, then the token is revoked and deleted. */
export async function disconnectAsanaAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await asanaContext();
      const connection = "missing" in found ? found.connection : found.connection;
      if (!connection || connection.status === "revoked") return { ok: false, message: NOT_CONNECTED };
      await stopWebhooks("missing" in found ? { provider: null, session: null } : found, { connectionId: connection.id });
      const provider = "missing" in found ? null : found.provider;
      await disconnectConnection({ connection, by: auth.user.id, revoke: provider ? provider.revoke : async () => false });
      revalidateOrgPages();
      return { ok: true, message: "Asana is disconnected. Acceptances already recorded stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectAsanaAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Check linked tasks now: one run of the sweeper's read, for this workspace. */
export async function syncAsanaNowAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await asanaContext();
      if ("missing" in found) return { ok: false, message: found.missing === "reconnect" ? "Asana needs you to reconnect. Reconnect it from this card." : NOT_CONNECTED };
      const result = await syncAsanaConnection(found.connection.id, found.provider);
      revalidateOrgPages();
      if (result.outcome === "synced") {
        const read = result.summary?.read ?? 0;
        return { ok: true, message: read === 0 ? "Checked. No open milestone is linked to an Asana task." : `Checked ${read} linked ${read === 1 ? "task" : "tasks"}.` };
      }
      if (result.outcome === "busy") return { ok: false, message: "A check is running already. Look again in a minute." };
      if (result.outcome === "reconnect") return { ok: false, message: "Asana needs you to reconnect. Reconnect it from this card." };
      return { ok: false, message: "The check stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncAsanaNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** What the picker lists, read live from Asana with the connection's token: workspaces, a workspace's projects, a project's tasks. */
export async function asanaChoicesAction(_previous: AsanaChoicesResult, formData: FormData): Promise<AsanaChoicesResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message, choices: [] };
  return inOrg(auth, async () => {
    const level = text(formData, "level");
    const parent = text(formData, "parent");
    if (level !== "workspaces" && !GID.test(parent)) return { ok: false, message: "Pick one first.", choices: [] };
    try {
      const found = await asanaContext();
      if ("missing" in found) return { ok: false, message: NOT_CONNECTED, choices: [] };
      try {
        const choices = await found.session.call((token) =>
          level === "workspaces"
            ? found.provider.reader.workspaces(token)
            : level === "projects"
              ? found.provider.reader.projects(token, parent)
              : found.provider.reader.tasks(token, parent)
        );
        return { ok: true, message: "", choices };
      } catch (error) {
        if (needsReconnect(error)) await markReconnect(found.connection, new Date().toISOString());
        return { ok: false, message: readFailureWords(error), choices: [] };
      }
    } catch (error) {
      console.error("asanaChoicesAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN, choices: [] };
    }
  });
}

/** Links a milestone to the task picked, or to the task a pasted link names. */
export async function linkAsanaTaskAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const taskGid = text(formData, "taskGid");
    const pick = GID.test(taskGid)
      ? { workspaceGid: text(formData, "workspaceGid"), projectGid: GID.test(text(formData, "projectGid")) ? text(formData, "projectGid") : null, taskGid }
      : undefined;
    return consoleAnswer(
      await linkAsanaTask(
        consoleActor(auth),
        { milestoneId: text(formData, "milestoneId"), ...(pick ? { pick } : { taskUrl: text(formData, "taskUrl").slice(0, 1000) }) },
        { defer: (work) => after(() => withOrg(auth.membership.orgId, work, { userId: auth.user.id })) }
      )
    );
  });
}

export async function unlinkAsanaTaskAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(
      await unlinkAsanaTask(
        consoleActor(auth),
        { milestoneId: text(formData, "milestoneId") },
        // After the answer, back in the workspace's scope: `after()` keeps no scope of its own.
        { defer: (work) => after(() => withOrg(auth.membership.orgId, work, { userId: auth.user.id })) }
      )
    )
  );
}

export async function setAcceptanceCriteriaAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(await setAcceptanceCriteria(consoleActor(auth), { milestoneId: text(formData, "milestoneId"), criteria: text(formData, "criteria").slice(0, 4000) }))
  );
}

/** Accepts the work against its criteria, as the deliverables and the criteria the page showed. */
export async function acceptMilestoneWorkAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(
      await acceptMilestoneWork(consoleActor(auth), {
        milestoneId: text(formData, "milestoneId"),
        fingerprint: text(formData, "fingerprint"),
        criteriaSha256: text(formData, "criteriaSha256"),
        confirmed: text(formData, "confirmed") === "yes",
      })
    )
  );
}

export async function checkAsanaTaskAction(_previous: AsanaActionResult, formData: FormData): Promise<AsanaActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await checkAsanaTask(consoleActor(auth), { milestoneId: text(formData, "milestoneId") })));
}
