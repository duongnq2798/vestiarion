"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor, fillCrmEmail, keepCrmChange, overwriteCrmReceipt, setCrmReceiptWrites } from "@/lib/commands";
import { connectionFor, disconnectConnection, NotSetUpError, type Connection } from "@/lib/connectors/connections";
import type { CrmProvider } from "@/lib/connectors/crm";
import { crmReady } from "@/lib/connectors/crm-review";
import { receiptsInScope } from "@/lib/connectors/crm-receipts-sync";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { crmProvider } from "@/lib/crm-providers";
import { inOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";

/**
 * HubSpot from the console (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H3, H7, H12, H13, H15):
 * syncing now and disconnecting are an owner's or admin's (`integrations.manage`); keeping a deal's changes and filling
 * a billing email from HubSpot are for whoever adds deals (`records.write`), through their commands. Writing receipts to
 * HubSpot, turned on or off, and Vestiarion's figures written over a conflict are an owner's or admin's
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3, R5). Every action reads the person's role again and works
 * in the workspace's scope; nothing returned carries a token.
 */

export interface HubSpotActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "HubSpot is not set up on this deployment yet.";
const NOT_CONNECTED = "HubSpot is not connected to this workspace.";
const RECONNECT = "HubSpot needs you to reconnect. Reconnect HubSpot from this card, then try again.";

/** The workspace's HubSpot connection and the provider, or why there is none. */
async function connected(): Promise<{ connection: Connection; provider: CrmProvider } | { message: string }> {
  const provider = crmProvider("hubspot");
  if (!provider) return { message: NOT_SET_UP };
  try {
    const connection = await connectionFor("hubspot");
    await crmReady();
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
export async function syncHubSpotNowAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
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
        const changed = result.changed > 0 ? ` ${result.changed} planned ${result.changed === 1 ? "deal" : "deals"} changed in HubSpot.` : "";
        return {
          ok: true,
          message: `${result.newDeals === 0 ? "Synced. No new deals." : `Synced. ${result.newDeals} new ${result.newDeals === 1 ? "deal" : "deals"} on Bills & receivables.`}${changed}`,
        };
      }
      if (result.outcome in SYNC_WORDS) return { ok: result.outcome === "partial", message: SYNC_WORDS[result.outcome] };
      return { ok: false, message: "The sync stopped. The card says why, and when Vestiarion tries again." };
    } catch (error) {
      console.error("syncHubSpotNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

export async function disconnectHubSpotAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await connected();
      if ("message" in found) return { ok: false, message: found.message };
      await disconnectConnection({ connection: found.connection, by: auth.user.id, revoke: found.provider.revoke });
      revalidateOrgPages();
      return { ok: true, message: "HubSpot is disconnected. Deals already planned stay in Vestiarion." };
    } catch (error) {
      console.error("disconnectHubSpotAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps a deal as it is although HubSpot changed it: the changes are marked as seen (H12). */
export async function keepCrmChangeAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formData.get("dealId");
    if (typeof dealId !== "string" || !UUID.test(dealId)) return { ok: false, message: "That deal was not found." };
    // The changes the page showed: only those are kept (H12).
    const seen = formData.get("seen");
    return consoleAnswer(await keepCrmChange(consoleActor(auth), { dealId, seen: typeof seen === "string" ? seen.slice(0, 64) : "" }));
  });
}

/** Fills a customer's empty billing email with the email HubSpot has for its company (H13). */
export async function fillCrmEmailAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const counterpartyId = formData.get("counterpartyId");
    if (typeof counterpartyId !== "string" || !UUID.test(counterpartyId)) return { ok: false, message: "That customer was not found." };
    // The email the person was shown: only that one is filled (H13).
    const email = formData.get("email");
    return consoleAnswer(await fillCrmEmail(consoleActor(auth), { counterpartyId, email: typeof email === "string" ? email.slice(0, 320) : "" }));
  });
}

/** Write receipts to HubSpot, or Stop writing to HubSpot (CRM receipts R3). */
export async function setHubSpotReceiptsAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const answer = consoleAnswer(await setCrmReceiptWrites(consoleActor(auth), { provider: "hubspot", on: formData.get("on") === "yes" }));
    revalidateOrgPages();
    return answer;
  });
}

/**
 * Write Vestiarion's figures over what someone changed in HubSpot (CRM receipts R5): only over what the page showed
 * (`seen`). The write is tried at once, best effort; the next sync tries it otherwise.
 */
export async function overwriteHubSpotReceiptAction(_previous: HubSpotActionResult, formData: FormData): Promise<HubSpotActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formData.get("dealId");
    if (typeof dealId !== "string" || !UUID.test(dealId)) return { ok: false, message: "That deal was not found." };
    const seen = formData.get("seen");
    const outcome = await overwriteCrmReceipt(consoleActor(auth), { dealId, seen: typeof seen === "string" ? seen.slice(0, 64) : "", label: "HubSpot" });
    if (!outcome.ok) return consoleAnswer(outcome);
    try {
      const found = await connected();
      if (!("message" in found) && found.connection.status === "connected") {
        const run = await receiptsInScope(found.connection.id, found.provider);
        revalidateOrgPages();
        if (run && run.written > 0) return { ok: true, message: "Written to HubSpot, and HubSpot read it back the same." };
        if (run && run.conflicts > 0) return { ok: false, message: "HubSpot changed again since this page was opened. Reload the page to see what it holds now." };
      }
    } catch (error) {
      console.error("overwriteHubSpotReceiptAction: the write was left for the next sync", error instanceof Error ? error.message : "unknown error");
    }
    revalidateOrgPages();
    return consoleAnswer(outcome);
  });
}
