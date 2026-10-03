"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { createLinkCode, disconnect, linkFor } from "@/lib/telegram/links";
import { telegramLink, telegramSettingsFromEnv } from "@/lib/telegram/settings";

export interface TelegramActionResult {
  ok: boolean;
  message: string;
  /** The one-time link that opens the bot and connects this chat (Telegram bot design R4). */
  url?: string;
  expiresAt?: string;
}

/**
 * A one-time link that connects the signed-in member's own Telegram chat to their membership (R4). Gated on
 * `workspace.read`: every member may get the agent's decisions in their own chat. The membership is always the
 * session's, taken from `auth`, never from the form.
 */
export async function connectTelegramAction(_previous: TelegramActionResult, formData: FormData): Promise<TelegramActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const settings = telegramSettingsFromEnv();
    if (!settings) return { ok: false, message: "Telegram is not set up for this deployment." };
    try {
      const { code, expiresAt } = await createLinkCode(auth.membership.orgId, auth.user.id);
      return { ok: true, message: "Open Telegram to finish connecting.", url: telegramLink(settings, code), expiresAt };
    } catch (error) {
      console.error("connectTelegramAction failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

/** Disconnects the signed-in member's own chat from this workspace (R6); only theirs, whatever the form says. */
export async function disconnectTelegramAction(_previous: TelegramActionResult, formData: FormData): Promise<TelegramActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const link = await linkFor(auth.membership.orgId, auth.user.id);
      if (!link) return { ok: true, message: "Telegram is not connected." };
      await disconnect(link, "settings", auth.user.id);
      revalidateOrgPages();
      return { ok: true, message: "Telegram disconnected." };
    } catch (error) {
      console.error("disconnectTelegramAction failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
