"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { acceptLinearWork, checkLinearIssue, consoleActor, linkLinearIssue, setLinearAcceptanceCriteria, unlinkLinearIssue } from "@/lib/commands";
import { disconnectConnection } from "@/lib/connectors/connections";
import { inOrg } from "@/lib/dal/scope";
import { linearContext, syncLinearConnection } from "@/lib/linear/workspace";
import { consoleAnswer } from "./command-result";

/**
 * Linear from the console (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN4, LN5, LN8, LN12):
 * checking the linked issues now and disconnecting are an owner's or admin's (`integrations.manage`); linking and
 * unlinking an issue, writing a milestone's criteria, accepting its work and checking one issue now are for whoever
 * verifies milestones (`records.write`), through their commands. Every action reads the person's role again and works
 * in the workspace's scope; nothing returned carries a token.
 */

export interface LinearActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_CONNECTED = "Linear is not connected to this workspace.";

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

/** Disconnects Linear: the grant is revoked at Linear, then the tokens are deleted. Linear makes no webhook to delete. */
export async function disconnectLinearAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await linearContext();
      const connection = found.connection;
      if (!connection || connection.status === "revoked") return { ok: false, message: NOT_CONNECTED };
      const provider = "missing" in found ? null : found.provider;
      await disconnectConnection({ connection, by: auth.user.id, revoke: provider ? provider.revoke : async () => false });
      revalidateOrgPages();
      return { ok: true, message: "Linear is disconnected. Acceptances already recorded stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectLinearAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Check linked issues now: one run of the sweeper's read, for this workspace. */
export async function syncLinearNowAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await linearContext();
      if ("missing" in found) return { ok: false, message: found.missing === "reconnect" ? "Linear needs you to reconnect. Reconnect it from this card." : NOT_CONNECTED };
      const result = await syncLinearConnection(found.connection.id, found.provider);
      revalidateOrgPages();
      if (result.outcome === "synced") {
        const read = result.summary?.read ?? 0;
        return { ok: true, message: read === 0 ? "Checked. No open milestone is linked to a Linear issue." : `Checked ${read} linked ${read === 1 ? "issue" : "issues"}.` };
      }
      if (result.outcome === "busy") return { ok: false, message: "A check is running already. Look again in a minute." };
      if (result.outcome === "reconnect") return { ok: false, message: "Linear needs you to reconnect. Reconnect it from this card." };
      return { ok: false, message: "The check stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncLinearNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Links a milestone to the issue a pasted link or ID names (`issue`: `https://linear.app/.../issue/ENG-123/...` or `ENG-123`). */
export async function linkLinearIssueAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(await linkLinearIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId"), issue: text(formData, "issue").slice(0, 1000) }))
  );
}

export async function unlinkLinearIssueAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await unlinkLinearIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId") })));
}

export async function setLinearCriteriaAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(await setLinearAcceptanceCriteria(consoleActor(auth), { milestoneId: text(formData, "milestoneId"), criteria: text(formData, "criteria").slice(0, 4000) }))
  );
}

/** Accepts the work against its criteria, as the deliverables and the criteria the page showed. */
export async function acceptLinearWorkAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    consoleAnswer(
      await acceptLinearWork(consoleActor(auth), {
        milestoneId: text(formData, "milestoneId"),
        fingerprint: text(formData, "fingerprint"),
        criteriaSha256: text(formData, "criteriaSha256"),
        confirmed: text(formData, "confirmed") === "yes",
      })
    )
  );
}

export async function checkLinearIssueAction(_previous: LinearActionResult, formData: FormData): Promise<LinearActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await checkLinearIssue(consoleActor(auth), { milestoneId: text(formData, "milestoneId") })));
}
