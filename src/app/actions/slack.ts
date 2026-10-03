"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { uninstallApp } from "@/lib/slack/api";
import { botTokenOf, installFor, removeInstall, setDecisionsLimit } from "@/lib/slack/installs";
import { linkFor, linkMember, unlink } from "@/lib/slack/links";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

export interface SlackActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_CONNECTED = "Slack is not connected to this workspace.";
/** A USDC amount as the invoice form takes one: at most six decimals. */
const LIMIT = /^\d{1,7}(\.\d{1,6})?$/;
const LIMIT_MAX = 1_000_000;

/**
 * Removes the workspace's Slack (Slack design S13): an owner's or admin's. The app is uninstalled from the Slack
 * workspace first, best effort, so its token and webhook stop working there too; the install and every link go either
 * way, and the removal is recorded.
 */
export async function removeSlackAction(_previous: SlackActionResult, formData: FormData): Promise<SlackActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const install = await installFor(auth.membership.orgId);
      if (!install) return { ok: true, message: NOT_CONNECTED };
      const settings = slackSettingsFromEnv();
      if (settings) {
        try {
          await uninstallApp(settings, botTokenOf(install));
        } catch (error) {
          console.error("slack: the app was not uninstalled from Slack", auth.membership.orgId, error instanceof Error ? error.message : "unknown error");
        }
      }
      await removeInstall(install, "settings", auth.user.id);
      revalidateOrgPages();
      return { ok: true, message: "Slack is disconnected. The agent's decisions no longer go there." };
    } catch (error) {
      console.error("removeSlackAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Sets the most a payment approved from Slack may be, or turns deciding there off when left empty (Slack design S8):
 * an owner's decision alone, like taking the workspace live.
 */
export async function setSlackDecisionsLimitAction(_previous: SlackActionResult, formData: FormData): Promise<SlackActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const raw = formString(formData, "limit").trim();
    let limit: number | null = null;
    if (raw !== "") {
      if (!LIMIT.test(raw) || Number(raw) <= 0 || Number(raw) > LIMIT_MAX) {
        return { ok: false, message: "Enter an amount in USDC above 0, with at most 6 decimals, or leave it empty to turn deciding from Slack off." };
      }
      limit = Number(raw);
    }
    try {
      const install = await installFor(auth.membership.orgId);
      if (!install) return { ok: false, message: NOT_CONNECTED };
      await setDecisionsLimit(install, limit, auth.user.id);
      revalidateOrgPages();
      return {
        ok: true,
        message:
          limit === null
            ? "Deciding payments from Slack is off."
            : `Payments up to ${limit} USDC can now be decided from Slack, under every check Vestiarion makes.`,
      };
    } catch (error) {
      console.error("setSlackDecisionsLimitAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Connects the signed-in member's own Slack account with the code `/vestiarion connect` gave it (Slack design S4): the
 * database uses the code up and links it, only for this workspace's own Slack, only to the session's membership.
 */
export async function connectSlackAccountAction(_previous: SlackActionResult, formData: FormData): Promise<SlackActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const link = await linkMember(formString(formData, "code"), auth.membership.orgId, auth.user.id);
      if (!link) {
        return {
          ok: false,
          message: "This link was already used, has expired, or is for another workspace's Slack. Type /vestiarion connect in Slack for a new one.",
        };
      }
      revalidateOrgPages();
      return { ok: true, message: "Connected. Back in Slack, try /vestiarion today." };
    } catch (error) {
      console.error("connectSlackAccountAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Disconnects the signed-in member's own Slack account; only theirs, whatever the form says. */
export async function disconnectSlackAccountAction(_previous: SlackActionResult, formData: FormData): Promise<SlackActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const link = await linkFor(auth.membership.orgId, auth.user.id);
      if (!link) return { ok: true, message: "Your Slack account is not connected." };
      await unlink(link, "settings", auth.user.id);
      revalidateOrgPages();
      return { ok: true, message: "Your Slack account is disconnected." };
    } catch (error) {
      console.error("disconnectSlackAccountAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
