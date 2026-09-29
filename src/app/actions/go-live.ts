"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { connectCircle, createWallets, goLive, GoLiveError } from "@/lib/platform/go-live";

/**
 * The three Go live steps (docs/superpowers/specs/2026-09-29-go-live-design.md),
 * owner only (L1). The Circle credentials arrive in form data, go straight to
 * `connectCircle`, and are never returned, logged or revalidated into a page:
 * the result is only ever `{ ok, message }` with a fixed message.
 */

export interface GoLiveActionResult {
  ok: boolean;
  message: string;
}

const GENERIC = "Something went wrong; try again.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * A `GoLiveError` carries a message safe to show. Anything else is logged by
 * the action's name alone: its message may be Circle's, or quote the request.
 */
function fail(action: string, error: unknown): GoLiveActionResult {
  if (error instanceof GoLiveError) return { ok: false, message: error.message };
  console.error(`go-live: ${action} failed`);
  return { ok: false, message: GENERIC };
}

/** Form fields: `orgSlug`, `apiKey`, `entitySecret`. */
export async function connectCircleAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await connectCircle({
        orgId: auth.membership.orgId,
        actorId: auth.user.id,
        apiKey: formString(formData, "apiKey"),
        entitySecret: formString(formData, "entitySecret"),
      });
      revalidateOrgPages();
      return { ok: true, message: "Circle is connected." };
    } catch (error) {
      return fail("connectCircleAction", error);
    }
  });
}

/** Form fields: `orgSlug`. */
export async function createWalletsAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { created } = await createWallets({ orgId: auth.membership.orgId, actorId: auth.user.id });
      return {
        ok: true,
        message: created > 0 ? `Treasury wallets created: ${created}.` : "Every account already has a wallet.",
      };
    } catch (error) {
      return fail("createWalletsAction", error);
    } finally {
      // Wallets written before a failure are kept (provisioning is idempotent), so the page shows them either way.
      revalidateOrgPages();
    }
  });
}

/** Form fields: `orgSlug`. */
export async function goLiveAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await goLive({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: "This workspace is live." };
    } catch (error) {
      return fail("goLiveAction", error);
    }
  });
}
