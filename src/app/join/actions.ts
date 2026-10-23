"use server";

import "server-only";

import { redirect } from "next/navigation";
import { orgHref } from "@/lib/auth/org-paths";
import { getSessionUser } from "@/lib/auth/session";
import { recordFirstTouch } from "@/lib/growth/record";
import {
  ACCOUNTANT_NOT_ADDED,
  claimClientLink,
  CLIENT_LINK_MESSAGES,
  CLIENT_LINK_VIA,
  ClientLinkError,
  clientLinkPreview,
  clientLinkTokenHash,
  JOIN_REFUSALS,
  joinView,
  type JoinView,
} from "@/lib/platform/client-links";
import { createWorkspace, WorkspaceLimitError } from "@/lib/platform/workspace";
import { SHADOW_NOT_STARTED } from "@/lib/shadow-mode";
import { startShadowModeAtCreation } from "@/lib/shadow-mode-at-creation";

export interface JoinFromClientLinkResult {
  ok: boolean;
  message: string;
}

/**
 * Opening a workspace from an accountant's client link (docs/superpowers/specs/2026-10-23-accountant-client-links-
 * design.md AC3). Not an organization action: there is no organization to authorize against yet, so the session is the
 * gate, as for `createWorkspaceAction`. The link is checked first, so a dead link, one bound to another address or the
 * accountant's own opens nothing.
 *
 * The workspace is made by the usual `createWorkspace`, always on Arc testnet and always in shadow mode, whatever the
 * form sent: Arc mainnet's allowlist protects nothing where it lets everyone in. Only then is the link claimed, which
 * adds the accountant as accountant. A claim that fails leaves the client their workspace and the link open, and the
 * console says the accountant was not added. `redirect` stays outside every `try`, since it works by throwing.
 */
export async function joinFromClientLinkAction(_previous: JoinFromClientLinkResult, formData: FormData): Promise<JoinFromClientLinkResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const token = formData.get("token");
  const tokenHash = clientLinkTokenHash(token);
  if (typeof token !== "string" || !tokenHash) return { ok: false, message: CLIENT_LINK_MESSAGES.client_link_not_found };
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) return { ok: false, message: "Give the workspace a name." };
  if (formData.get("consent") !== "on") return { ok: false, message: "Tick the box to let your accountant into the workspace." };

  let view: JoinView;
  try {
    view = joinView(await clientLinkPreview(token), user);
  } catch (error) {
    console.error("client link not read", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
  if (view.kind !== "open") return { ok: false, message: JOIN_REFUSALS[view.kind] };

  let slug: string;
  let orgId: string;
  try {
    ({ slug, orgId } = await createWorkspace({ userId: user.id, name, network: "arc-testnet", via: CLIENT_LINK_VIA }));
  } catch (error) {
    if (error instanceof WorkspaceLimitError) return { ok: false, message: error.message };
    console.error("workspace creation from a client link failed", error);
    return { ok: false, message: "The workspace could not be created. Try again in a moment." };
  }

  let accountantAdded = true;
  try {
    await claimClientLink({ tokenHash, userId: user.id, orgId });
  } catch (error) {
    accountantAdded = false;
    // Never the token: only which refusal, or the database's message.
    console.error("client link not claimed", orgId, error instanceof ClientLinkError ? error.code : error instanceof Error ? error.message : "unknown error");
  }
  // The claim recorded the accountant's link as the workspace's first touch; without it, the first-touch cookie's, as
  // onboarding records it (src/lib/growth/record.ts).
  if (!accountantAdded) await recordFirstTouch(orgId);
  const shadowStarted = await startShadowModeAtCreation(slug);

  const notices = new URLSearchParams();
  if (!accountantAdded) notices.set("accountant", ACCOUNTANT_NOT_ADDED);
  if (!shadowStarted) notices.set("shadow", SHADOW_NOT_STARTED);
  const query = notices.toString();
  redirect(orgHref(slug, query ? `/console?${query}` : "/console"));
}
