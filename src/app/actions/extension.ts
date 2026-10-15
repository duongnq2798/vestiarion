"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { can } from "@/lib/auth/roles";
import { inOrg } from "@/lib/dal/scope";
import { checkAuthorizeRequest, redirectWith } from "@/lib/extension/authorize-request";
import { extensionSettingsFromEnv } from "@/lib/extension/settings";
import { CaptureNotSetUpError, connectionOwner, issueAuthorizationCode, revokeConnection } from "@/lib/extension/tokens";
import { takeExtensionConsentToken } from "@/lib/rate-limit";

/**
 * The Chrome extension's consent and its Disconnect in Settings (docs/superpowers/specs/2026-10-15-invoice-capture-
 * design.md C13, C17). Consent is for a workspace where the person can add bills, an owner's or admin's; it issues a
 * one-time code and answers the address to send it back to, which the page opens. A person disconnects their own
 * extension; an owner or admin, anyone's in the workspace.
 */

export interface ExtensionConsentResult {
  ok: boolean;
  message: string;
  /** Where the consent page goes next: the extension's own address, with the code and its state. */
  redirectTo?: string;
}

export interface ExtensionActionResult {
  ok: boolean;
  message: string;
}

const NOT_SET_UP = "Invoice capture is not set up on this deployment yet.";
const TRY_AGAIN = "That did not work. Try again in a moment.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Allow on /extension/authorize (C13): checks the request again, as the form carried it, and issues the code. */
export async function allowExtensionAction(_previous: ExtensionConsentResult, formData: FormData): Promise<ExtensionConsentResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const settings = extensionSettingsFromEnv();
    if (!settings) return { ok: false, message: NOT_SET_UP };
    const check = checkAuthorizeRequest(settings, {
      response_type: "code",
      client_id: formString(formData, "clientId"),
      redirect_uri: formString(formData, "redirectUri"),
      code_challenge: formString(formData, "codeChallenge"),
      code_challenge_method: "S256",
      state: formString(formData, "state"),
      scope: formString(formData, "scope"),
    });
    if (check.kind !== "ok") return { ok: false, message: "This request to connect is not valid. Start again from the extension." };
    if (!takeExtensionConsentToken(auth.user.id)) return { ok: false, message: "Too many connections at once. Try again in a minute." };
    try {
      const code = await issueAuthorizationCode({
        orgId: auth.membership.orgId,
        userId: auth.user.id,
        clientId: check.request.clientId,
        redirectUri: check.request.redirectUri,
        codeChallenge: check.request.codeChallenge,
        scopes: check.request.scopes,
      });
      return {
        ok: true,
        message: `Connected to ${auth.membership.name}. Going back to the extension…`,
        redirectTo: redirectWith(check.request.redirectUri, { code, state: check.request.state }),
      };
    } catch (error) {
      if (error instanceof CaptureNotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("allowExtensionAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Disconnect in Settings (C17): the connection's tokens stop at once. */
export async function disconnectExtensionAction(_previous: ExtensionActionResult, formData: FormData): Promise<ExtensionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  const connectionId = formString(formData, "connectionId");
  if (!UUID.test(connectionId)) return { ok: false, message: "This extension was already disconnected." };
  return inOrg(auth, async () => {
    try {
      const owner = await connectionOwner(auth.membership.orgId, connectionId);
      if (!owner) return { ok: false, message: "This extension was already disconnected." };
      if (owner !== auth.user.id && !can(auth.membership.role, "integrations.manage")) {
        return { ok: false, message: "Only an owner or admin can disconnect someone else's extension." };
      }
      const revoked = await revokeConnection({ orgId: auth.membership.orgId, connectionId, by: auth.user.id, reason: "settings" });
      revalidateOrgPages();
      return revoked ? { ok: true, message: "Disconnected. That extension can no longer send drafts." } : { ok: false, message: "This extension was already disconnected." };
    } catch (error) {
      if (error instanceof CaptureNotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("disconnectExtensionAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
