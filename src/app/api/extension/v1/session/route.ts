import { extensionJson, extensionPreflight, guardExtensionRequest, inExtensionScope } from "@/lib/extension/http";
import { workspaceOf } from "@/lib/extension/tokens";
import { orgHref } from "@/lib/auth/org-paths";
import { publicOrigin } from "@/lib/public-origin";
import { scopeString } from "@/lib/extension/settings";

export const dynamic = "force-dynamic";

/**
 * What the extension shows of its connection (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C19, C25):
 * the workspace it captures into, what it was granted, and until when the access token works. Nothing else of the
 * workspace.
 */
export function OPTIONS(request: Request) {
  return extensionPreflight(request, "GET");
}

export async function GET(request: Request) {
  const guard = await guardExtensionRequest(request, "invoice_draft:read");
  if ("denied" in guard) return guard.denied;
  const { principal } = guard;
  return inExtensionScope(request, principal, "GET /api/extension/v1/session", async () => {
    const workspace = await workspaceOf(principal.orgId);
    return extensionJson(request, {
      data: {
        workspace,
        consoleUrl: `${publicOrigin()}${orgHref(workspace.slug, "/invoices")}`,
        audience: principal.audience,
        scope: scopeString(principal.scopes),
        expiresAt: principal.accessExpiresAt,
      },
    });
  });
}
