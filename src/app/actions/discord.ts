"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { postToDiscord, readDiscordWebhook, webhookGone, type DiscordResult } from "@/lib/discord/api";
import { clearFailure, readConnection, removeConnection, saveConnection, webhookUrlOf } from "@/lib/discord/connections";
import { connectedMessage, testMessage } from "@/lib/discord/messages";
import { parseDiscordWebhookUrl } from "@/lib/discord/webhook-url";

/**
 * Connecting, testing and disconnecting a workspace's Discord channel (docs/superpowers/specs/2026-10-22-discord-design.md
 * DC1, DC6): an owner's or admin's, under `integrations.manage`, so no other role can point the workspace's notices at a
 * channel of its own. A webhook is saved only once Discord took a test message on it. Its URL is never returned, logged or
 * put in the ledger: a result says what happened in words.
 */

export interface DiscordActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_READY = "Discord is not set up on this deployment yet.";
const NOT_CONNECTED = "Discord is not connected to this workspace.";
const ALREADY = "Discord is already connected. Disconnect it first to post to another channel.";
const NOT_A_WEBHOOK =
  "That is not a Discord webhook URL. In Discord, open the channel's settings, then Integrations, Webhooks, and copy the webhook's URL.";
const GONE = "Discord says this webhook does not exist. Copy its URL again from the channel's settings in Discord.";

/** Why Discord did not take a call, reading the webhook or posting to it, in words: never its URL. */
function refusal(result: DiscordResult, step: "read" | "post", nothingSaved: boolean): string {
  const after = nothingSaved ? " Nothing was saved." : "";
  if (webhookGone(result)) return GONE;
  if (result.status === 429) return `Discord asked Vestiarion to slow down. Try again in a minute.${after}`;
  if (result.status === 0 || result.status >= 500) return `Discord could not be reached. Try again in a moment.${after}`;
  return step === "read"
    ? `Discord did not describe this webhook (${result.status}). Copy its URL again from the channel's settings in Discord.${after}`
    : `Discord did not take the test message (${result.status}).${after}`;
}

/**
 * Connects a channel webhook (DC1): the pasted URL is parsed and rebuilt on discord.com, Discord is asked which channel
 * it posts to, a test message is posted, and only then is the connection saved and recorded.
 */
export async function connectDiscordAction(_previous: DiscordActionResult, formData: FormData): Promise<DiscordActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const webhook = parseDiscordWebhookUrl(formString(formData, "webhookUrl"));
    if (!webhook) return { ok: false, message: NOT_A_WEBHOOK };
    try {
      const found = await readConnection(auth.membership.orgId);
      if (!found.ready) return { ok: false, message: NOT_READY };
      if (found.connection) return { ok: false, message: ALREADY };
      const read = await readDiscordWebhook(webhook.url);
      if (!read.ok) return { ok: false, message: refusal(read, "read", true) };
      if (read.webhook.id !== webhook.id) return { ok: false, message: GONE };
      const posted = await postToDiscord(webhook.url, { content: connectedMessage(auth.membership.name) });
      if (!posted.ok) return { ok: false, message: refusal(posted, "post", true) };
      await saveConnection({ orgId: auth.membership.orgId, connectedBy: auth.user.id, webhook, info: read.webhook });
      revalidateOrgPages();
      return { ok: true, message: "Discord is connected. A test message was posted to the channel." };
    } catch (error) {
      console.error("connectDiscordAction failed", messageOf(error));
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Posts a test message to the connected channel (DC6). A webhook Discord says is gone is disconnected, as the stage does. */
export async function sendDiscordTestAction(_previous: DiscordActionResult, formData: FormData): Promise<DiscordActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await readConnection(auth.membership.orgId);
      if (!found.ready) return { ok: false, message: NOT_READY };
      const { connection } = found;
      if (!connection) return { ok: false, message: NOT_CONNECTED };
      const posted = await postToDiscord(webhookUrlOf(connection), { content: testMessage(auth.membership.name) });
      if (posted.ok) {
        if (connection.failures > 0 || connection.lastError !== null) await clearFailure(connection.id);
        revalidateOrgPages();
        return { ok: true, message: "A test message was posted to the Discord channel." };
      }
      if (webhookGone(posted)) {
        await removeConnection(connection, "discord", null);
        revalidateOrgPages();
        return { ok: false, message: "Discord says this webhook no longer exists, so Discord was disconnected. Connect a new webhook." };
      }
      return { ok: false, message: refusal(posted, "post", false) };
    } catch (error) {
      console.error("sendDiscordTestAction failed", messageOf(error));
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Disconnects the workspace's Discord (DC1, DC6): the connection and its encrypted URL are deleted, and the removal is
 * recorded. The webhook is the channel's: it stays in Discord until someone deletes it there.
 */
export async function removeDiscordAction(_previous: DiscordActionResult, formData: FormData): Promise<DiscordActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await readConnection(auth.membership.orgId);
      if (!found.ready) return { ok: false, message: NOT_READY };
      if (!found.connection) return { ok: true, message: NOT_CONNECTED };
      await removeConnection(found.connection, "settings", auth.user.id);
      revalidateOrgPages();
      return { ok: true, message: "Discord is disconnected. Bills waiting for approval are no longer posted there." };
    } catch (error) {
      console.error("removeDiscordAction failed", messageOf(error));
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
