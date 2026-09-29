"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { ApiKeyError, createApiKey, revokeApiKey } from "@/lib/platform/api-keys";

export interface ApiKeyActionResult {
  ok: boolean;
  message: string;
  /** Only on a successful create — the full token, shown once. Never logged, revalidated into a page, or stored. */
  token?: string;
}

const keyIdSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** An `ApiKeyError` carries a message safe to show; anything else stays in the server log — never the token. */
function fail(error: unknown): ApiKeyActionResult {
  if (error instanceof ApiKeyError) return { ok: false, message: error.message };
  console.error("API key action failed", error);
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function createApiKeyAction(_previous: ApiKeyActionResult, formData: FormData): Promise<ApiKeyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "api_keys.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { key, token } = await createApiKey({ orgId: auth.membership.orgId, actorId: auth.user.id, name: formString(formData, "name") });
      revalidateOrgPages();
      return { ok: true, message: `"${key.name}" was created. Copy this key now — it will not be shown again.`, token };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function revokeApiKeyAction(_previous: ApiKeyActionResult, formData: FormData): Promise<ApiKeyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "api_keys.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = keyIdSchema.safeParse(formString(formData, "keyId"));
    if (!parsed.success) return { ok: false, message: "No active API key with that id in this workspace." };
    try {
      await revokeApiKey({ orgId: auth.membership.orgId, actorId: auth.user.id, keyId: parsed.data });
      revalidateOrgPages();
      return { ok: true, message: "API key revoked." };
    } catch (error) {
      return fail(error);
    }
  });
}
