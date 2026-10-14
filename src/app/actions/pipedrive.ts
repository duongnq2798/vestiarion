"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor, overwriteCrmReceipt, setCrmReceiptWrites } from "@/lib/commands";
import { connectionFor, disconnectConnection, NotSetUpError, type Connection } from "@/lib/connectors/connections";
import type { CrmProvider } from "@/lib/connectors/crm";
import { receiptsInScope } from "@/lib/connectors/crm-receipts-sync";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { crmProvider } from "@/lib/crm-providers";
import { inOrg } from "@/lib/dal/scope";
import { ensureWebhookInScope, pipedriveReady } from "@/lib/pipedrive/store";
import { consoleAnswer } from "./command-result";

/**
 * Pipedrive from the console (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P3, P7, P11, P15): Sync
 * now (with the webhook made sure of), disconnecting, and the receipts switch are an owner's or admin's
 * (`integrations.manage`), and so is Vestiarion's figures written over a conflict. Keeping a deal's changes and filling a
 * billing email are the CRM actions every CRM shares (`./hubspot.ts`). Every action reads the person's role again and
 * works in the workspace's scope; nothing returned carries a token.
 */

export interface PipedriveActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "Pipedrive is not set up on this deployment yet.";
const NOT_CONNECTED = "Pipedrive is not connected to this workspace.";
const RECONNECT = "Pipedrive needs you to reconnect. Reconnect Pipedrive from this card, then try again.";

/** The workspace's Pipedrive connection and the provider, or why there is none. */
async function connected(): Promise<{ connection: Connection; provider: CrmProvider } | { message: string }> {
  const provider = crmProvider("pipedrive");
  if (!provider) return { message: NOT_SET_UP };
  try {
    const connection = await connectionFor("pipedrive");
    await pipedriveReady();
    if (!connection || connection.status === "revoked") return { message: NOT_CONNECTED };
    return { connection, provider };
  } catch (error) {
    if (error instanceof NotSetUpError) return { message: NOT_SET_UP };
    throw error;
  }
}

const SYNC_WORDS: Record<string, string> = {
  partial: "Synced part of it. The rest follows within 15 minutes.",
  busy: "A sync is running already. Look again in a minute.",
  reconnect: RECONNECT,
};

/** Sync now: the webhook made sure of, then one run, with a smaller page budget than the sweeper's. */
export async function syncPipedriveNowAction(_previous: PipedriveActionResult, formData: FormData): Promise<PipedriveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      if (found.connection.status !== "connected") return { ok: false, message: RECONNECT };
      await ensureWebhookInScope(found.connection, found.provider);
      const result = await crmSyncInScope(found.connection.id, found.provider, { maxPages: 5 });
      revalidateOrgPages();
      if (result.outcome === "synced") {
        const changed = result.changed > 0 ? ` ${result.changed} planned ${result.changed === 1 ? "deal" : "deals"} changed in Pipedrive.` : "";
        return {
          ok: true,
          message: `${result.newDeals === 0 ? "Synced. No new deals." : `Synced. ${result.newDeals} new ${result.newDeals === 1 ? "deal" : "deals"} on Bills & receivables.`}${changed}`,
        };
      }
      if (result.outcome in SYNC_WORDS) return { ok: result.outcome === "partial", message: SYNC_WORDS[result.outcome] };
      return { ok: false, message: "The sync stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncPipedriveNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Disconnect Pipedrive: the refresh token revoked there, which uninstalls the app; planned deals stay (P15). */
export async function disconnectPipedriveAction(_previous: PipedriveActionResult, formData: FormData): Promise<PipedriveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      await disconnectConnection({ connection: found.connection, by: auth.user.id, revoke: found.provider.revoke });
      revalidateOrgPages();
      return { ok: true, message: "Pipedrive is disconnected. Deals already planned stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectPipedriveAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Write receipts to Pipedrive, or Stop writing to Pipedrive (P11, P12). */
export async function setPipedriveReceiptsAction(_previous: PipedriveActionResult, formData: FormData): Promise<PipedriveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const answer = consoleAnswer(await setCrmReceiptWrites(consoleActor(auth), { provider: "pipedrive", on: formData.get("on") === "yes" }));
    revalidateOrgPages();
    return answer;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Write Vestiarion's figures over what someone changed in Pipedrive (P11, as CRM receipts R5): only over what the page
 * showed (`seen`). The write is tried at once, best effort; the next sync tries it otherwise.
 */
export async function overwritePipedriveReceiptAction(_previous: PipedriveActionResult, formData: FormData): Promise<PipedriveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formData.get("dealId");
    if (typeof dealId !== "string" || !UUID.test(dealId)) return { ok: false, message: "That deal was not found." };
    const seen = formData.get("seen");
    const outcome = await overwriteCrmReceipt(consoleActor(auth), { dealId, seen: typeof seen === "string" ? seen.slice(0, 64) : "", label: "Pipedrive" });
    if (!outcome.ok) return consoleAnswer(outcome);
    try {
      const found = await connected();
      if (!("message" in found) && found.connection.status === "connected") {
        const run = await receiptsInScope(found.connection.id, found.provider);
        revalidateOrgPages();
        if (run && run.written > 0) return { ok: true, message: "Written to Pipedrive, and Pipedrive read it back the same." };
        if (run && run.conflicts > 0) return { ok: false, message: "Pipedrive changed again since this page was opened. Reload the page to see what it holds now." };
      }
    } catch (error) {
      console.error("overwritePipedriveReceiptAction: the write was left for the next sync", error instanceof Error ? error.message : "unknown error");
    }
    revalidateOrgPages();
    return consoleAnswer(outcome);
  });
}
