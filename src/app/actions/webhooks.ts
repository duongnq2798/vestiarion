"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { createWebhookEndpoint, removeWebhookEndpoint, WebhookError } from "@/lib/platform/webhooks";
import { sendTestEvent } from "@/lib/webhooks/deliver";

export interface WebhookActionResult {
  ok: boolean;
  message: string;
  /** Only on a successful create — the signing secret, shown once. Never logged, revalidated into a page, or stored. */
  secret?: string;
}

const endpointIdSchema = z.string().uuid();
const NOT_FOUND_MESSAGE = "No active webhook endpoint with that id in this workspace.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** A `WebhookError` carries a message safe to show; anything else stays in the server log — never the secret. */
function fail(error: unknown): WebhookActionResult {
  if (error instanceof WebhookError) return { ok: false, message: error.message };
  console.error("Webhook action failed", error);
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function createWebhookEndpointAction(_previous: WebhookActionResult, formData: FormData): Promise<WebhookActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "webhooks.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { secret } = await createWebhookEndpoint({ orgId: auth.membership.orgId, actorId: auth.user.id, url: formString(formData, "url") });
      revalidateOrgPages();
      return { ok: true, message: "Copy this signing secret now. It will not be shown again.", secret };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function removeWebhookEndpointAction(_previous: WebhookActionResult, formData: FormData): Promise<WebhookActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "webhooks.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = endpointIdSchema.safeParse(formString(formData, "endpointId"));
    if (!parsed.success) return { ok: false, message: NOT_FOUND_MESSAGE };
    try {
      await removeWebhookEndpoint({ orgId: auth.membership.orgId, actorId: auth.user.id, endpointId: parsed.data });
      revalidateOrgPages();
      return { ok: true, message: "Webhook endpoint removed." };
    } catch (error) {
      return fail(error);
    }
  });
}

/** "Delivered (HTTP 200)." or "Not delivered: <reason>." — never a status when there was none to report. */
export async function sendTestWebhookAction(_previous: WebhookActionResult, formData: FormData): Promise<WebhookActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "webhooks.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = endpointIdSchema.safeParse(formString(formData, "endpointId"));
    if (!parsed.success) return { ok: false, message: `Not delivered: ${NOT_FOUND_MESSAGE}` };
    const result = await sendTestEvent({ orgId: auth.membership.orgId, endpointId: parsed.data });
    return result.ok
      ? { ok: true, message: `Delivered (HTTP ${result.status}).` }
      : { ok: false, message: `Not delivered: ${result.error}.` };
  });
}
