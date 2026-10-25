"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { revokeDocumentRequest, RevokeDocumentRequestError } from "@/lib/document-requests/read";
import { DOCUMENT_REQUESTS_SETTINGS, type DocumentRequestsSetting } from "@/lib/document-requests/rules";
import { changeDocumentRequests, DocumentRequestsError } from "@/lib/document-requests/setting";

/**
 * Asking vendors for a bill's missing document (docs/superpowers/specs/2026-10-23-document-requests-design.md): the
 * owner's setting in Settings, off, shadow or on (ER1), an owner's alone, as the payee lock is; and an owner's or admin's
 * Revoke of a request out, from the bill's card (ER6). The library refuses a change while a cycle runs and writes the
 * signed entries. Shadow or on starts a cycle now, so the bills waiting already are weighed without waiting for the
 * schedule.
 */

export interface DocumentRequestsActionResult {
  ok: boolean;
  message: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";

const SET: Record<DocumentRequestsSetting, string> = {
  off: "Vendor requests are off. Links already sent still work until they expire.",
  shadow: "Vendor requests are in shadow: each bill's card says what Vestiarion would ask, and nothing is sent.",
  on: "Vendor requests are on: Vestiarion emails vendors for a bill's missing purchase order or goods receipt.",
};
/** On, once the workspace checks what vendors send (document checks DK1). */
const SET_ON_CHECKED = "Vendor requests are on: Vestiarion emails vendors for a bill's missing purchase order or goods receipt, and checks what they send.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function setDocumentRequestsAction(_previous: DocumentRequestsActionResult, formData: FormData): Promise<DocumentRequestsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const setting = formString(formData, "setting");
    if (!(DOCUMENT_REQUESTS_SETTINGS as readonly string[]).includes(setting)) return { ok: false, message: "Choose off, shadow or on." };
    try {
      const { to, checks } = await changeDocumentRequests({ actorId: auth.user.id, to: setting as DocumentRequestsSetting });
      if (to !== "off") raiseCycleEvent(auth, "document_requests_on");
      revalidateOrgPages();
      return { ok: true, message: to === "on" && checks ? SET_ON_CHECKED : SET[to] };
    } catch (error) {
      if (error instanceof DocumentRequestsError) return { ok: false, message: error.message };
      console.error("document requests change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

export async function revokeDocumentRequestAction(_previous: DocumentRequestsActionResult, formData: FormData): Promise<DocumentRequestsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await revokeDocumentRequest({ actorId: auth.user.id, role: auth.membership.role, requestId: formString(formData, "requestId") });
      revalidateOrgPages();
      return { ok: true, message: "Revoked. The link no longer works, and Vestiarion will not ask the vendor about this bill again." };
    } catch (error) {
      if (error instanceof RevokeDocumentRequestError) return { ok: false, message: error.message };
      console.error("document request revoke failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
