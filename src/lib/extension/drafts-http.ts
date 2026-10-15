import type { NextResponse } from "next/server";
import { orgHref } from "../auth/org-paths";
import { billsHref } from "../bills-view";
import type { Refused } from "../commands/outcome";
import { extensionView, type DraftRow } from "../invoice-drafts/model";
import { publicOrigin } from "../public-origin";
import { extensionError, extensionJson, INTERNAL } from "./http";
import { workspaceOf, type ExtensionPrincipal } from "./tokens";

/**
 * A draft as the extension's routes answer it (invoice capture design C3, C19): its view, and once it was sent, the
 * console's page where it is reviewed, which **Open in Vestiarion** opens.
 */
export async function reviewUrlFor(principal: ExtensionPrincipal): Promise<string> {
  const { slug } = await workspaceOf(principal.orgId);
  return `${publicOrigin()}${orgHref(slug, billsHref({ tab: "bills", review: "captured" }))}`;
}

export async function draftAnswer(
  request: Request,
  principal: ExtensionPrincipal,
  draft: DraftRow,
  init: { status?: number; headers?: Record<string, string> } = {}
): Promise<NextResponse> {
  const reviewUrl = draft.state === "draft" ? null : await reviewUrlFor(principal);
  return extensionJson(request, { data: extensionView(draft, reviewUrl) }, init);
}

/** A command's refusal, as the extension's routes answer it. */
export function refusedAnswer(request: Request, refusal: Refused): NextResponse {
  switch (refusal.code) {
    case "not_found":
      return extensionError(request, "not_found", refusal.message);
    case "not_editable":
      return extensionError(request, "not_editable", refusal.message);
    case "idempotency_conflict":
      return extensionError(request, "conflict", refusal.message);
    case "unreadable":
      return extensionError(request, "unreadable", refusal.message);
    case "rate_limited":
      return extensionError(request, "rate_limited", refusal.message, { "Retry-After": "12" });
    case "forbidden":
    case "surface":
      return extensionError(request, "forbidden", refusal.message);
    default:
      return extensionError(request, "internal", INTERNAL);
  }
}
