"use server";

import "server-only";

import { redirect } from "next/navigation";
import { authorize } from "@/lib/auth/authorize";
import { orgHref } from "@/lib/auth/org-paths";
import { getSessionUser } from "@/lib/auth/session";
import { currentConfig } from "@/lib/context";
import { inOrg } from "@/lib/dal/scope";
import { recordFirstTouch } from "@/lib/growth/record";
import { MAINNET_NOT_OPEN, mayUseMainnet } from "@/lib/mainnet";
import { createWorkspace, WorkspaceLimitError } from "@/lib/platform/workspace";
import { SHADOW_NOT_STARTED, startShadowMode } from "@/lib/shadow-mode";

export interface CreateWorkspaceResult {
  ok: boolean;
  message: string;
}

/**
 * Shadow mode for the workspace just created (shadow mode S1), as Settings turns it on: an owner's (`approval.policy`),
 * through `startShadowMode`, which refuses Arc mainnet and writes the signed entry. In USDC, with the person who
 * created it as the actor. Says whether it turned on: the workspace stays created either way.
 */
async function startShadowModeIn(slug: string): Promise<boolean> {
  try {
    const auth = await authorize(slug, "approval.policy");
    if (!auth.ok) {
      console.error("shadow mode at creation refused", auth.message);
      return false;
    }
    await inOrg(auth, () => startShadowMode({ actorId: auth.user.id, currency: "USDC" }));
    return true;
  } catch (error) {
    console.error("shadow mode at creation failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

/**
 * Not an organization action: there is no organization to authorize against
 * yet, so the session is the gate. Only the limit is worth saying in words;
 * anything else may carry a database or configuration message, which stays in
 * the server log rather than reaching the browser.
 */
export async function createWorkspaceAction(_previous: CreateWorkspaceResult, formData: FormData): Promise<CreateWorkspaceResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) return { ok: false, message: "Give the workspace a name." };
  // Arc mainnet only for a person on the allowlist while it is on, checked here whatever the form sent (mainnet go-live
  // M1, M2); any other value is Arc testnet.
  const network = formData.get("network") === "arc-mainnet" ? "arc-mainnet" : "arc-testnet";
  if (network === "arc-mainnet" && !mayUseMainnet(user.email, currentConfig())) return { ok: false, message: MAINNET_NOT_OPEN };
  // Shadow mode is for Arc testnet only: asked for with an Arc mainnet workspace, it is not turned on.
  const shadow = network === "arc-testnet" && formData.get("shadow") === "on";
  let slug: string;
  let orgId: string;
  try {
    ({ slug, orgId } = await createWorkspace({ userId: user.id, name, network }));
  } catch (error) {
    if (error instanceof WorkspaceLimitError) return { ok: false, message: error.message };
    console.error("workspace creation failed", error);
    return { ok: false, message: "The workspace could not be created. Try again in a moment." };
  }
  // Which campaign brought this person, from the first-touch cookie, recorded once; it never fails or holds up the
  // workspace, which already exists (src/lib/growth/record.ts).
  await recordFirstTouch(orgId);
  const shadowStarted = shadow ? await startShadowModeIn(slug) : true;
  // `redirect` throws to navigate, so it stays outside the `try` above.
  redirect(orgHref(slug, shadowStarted ? "/console" : `/console?shadow=${SHADOW_NOT_STARTED}`));
}
