"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { connectionFor, disconnectConnection, NotSetUpError, type Connection } from "@/lib/connectors/connections";
import type { CrmProvider } from "@/lib/connectors/crm";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { crmProvider } from "@/lib/crm-providers";
import { inOrg } from "@/lib/dal/scope";
import { zohoCrmReady } from "@/lib/zohocrm/store";

/**
 * Zoho CRM from the console (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4, C15): Sync now and
 * disconnecting are an owner's or admin's (`integrations.manage`). Keeping a deal's changes and filling a billing email
 * are the CRM actions every CRM shares (`./hubspot.ts`). Zoho CRM is read only, so there is no receipts switch. Every
 * action reads the person's role again and works in the workspace's scope; nothing returned carries a token.
 */

export interface ZohoCrmActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "Zoho CRM is not set up on this deployment yet.";
const NOT_CONNECTED = "Zoho CRM is not connected to this workspace.";
const RECONNECT = "Zoho CRM needs you to reconnect. Reconnect Zoho CRM from this card, then try again.";

/** The workspace's Zoho CRM connection and the provider, or why there is none. */
async function connected(): Promise<{ connection: Connection; provider: CrmProvider } | { message: string }> {
  const provider = crmProvider("zohocrm");
  if (!provider) return { message: NOT_SET_UP };
  try {
    const connection = await connectionFor("zohocrm");
    await zohoCrmReady();
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

/** Sync now: one run, with a smaller page budget than the sweeper's. */
export async function syncZohoCrmNowAction(_previous: ZohoCrmActionResult, formData: FormData): Promise<ZohoCrmActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      if (found.connection.status !== "connected") return { ok: false, message: RECONNECT };
      const result = await crmSyncInScope(found.connection.id, found.provider, { maxPages: 5 });
      revalidateOrgPages();
      if (result.outcome === "synced") {
        const changed = result.changed > 0 ? ` ${result.changed} planned ${result.changed === 1 ? "deal" : "deals"} changed in Zoho CRM.` : "";
        return {
          ok: true,
          message: `${result.newDeals === 0 ? "Synced. No new deals." : `Synced. ${result.newDeals} new ${result.newDeals === 1 ? "deal" : "deals"} on Bills & receivables.`}${changed}`,
        };
      }
      if (result.outcome in SYNC_WORDS) return { ok: result.outcome === "partial", message: SYNC_WORDS[result.outcome] };
      return { ok: false, message: "The sync stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncZohoCrmNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Disconnect Zoho CRM: the refresh token revoked at Zoho; planned deals stay (C15). */
export async function disconnectZohoCrmAction(_previous: ZohoCrmActionResult, formData: FormData): Promise<ZohoCrmActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      await disconnectConnection({ connection: found.connection, by: auth.user.id, revoke: found.provider.revoke });
      revalidateOrgPages();
      return { ok: true, message: "Zoho CRM is disconnected. Deals already planned stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectZohoCrmAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
