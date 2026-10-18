"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { orgHref } from "@/lib/auth/org-paths";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { currentConfig } from "@/lib/context";
import { inOrg } from "@/lib/dal/scope";
import { SliceError, startLiveSlice } from "@/lib/live-slice";
import { MAINNET_NOT_OPEN, MAINNET_OFF, mayUseMainnet } from "@/lib/mainnet";

/**
 * Start the live slice, from the workspace report (docs/superpowers/specs/2026-10-18-live-slice-design.md L1, L6): an
 * owner (`org.administer`), to whom Arc mainnet is open, opens a workspace on Arc mainnet with the vendors they chose.
 * The new workspace is theirs; the answer links its Settings, where it goes live.
 */

export interface LiveSliceActionResult {
  ok: boolean;
  message: string;
  /** The new workspace's Settings, once it is made. */
  url?: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";

export async function startLiveSliceAction(_previous: LiveSliceActionResult, formData: FormData): Promise<LiveSliceActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  // Arc mainnet open to this person, as for creating a workspace there (mainnet go-live M2).
  if (!mayUseMainnet(auth.user.email, currentConfig())) return { ok: false, message: MAINNET_NOT_OPEN };
  const vendorIds = formData.getAll("vendorId").map(String);
  return inOrg(auth, async () => {
    try {
      const started = await startLiveSlice({ userId: auth.user.id, vendorIds });
      revalidateOrgPages();
      const skipped = started.skipped > 0 ? ` ${started.skipped} without a payment limit stayed here.` : "";
      return {
        ok: true,
        message: `Opened ${started.slug} on Arc mainnet with ${started.carried.length} ${started.carried.length === 1 ? "vendor" : "vendors"}.${skipped} Next: take it live from its Settings.`,
        url: orgHref(started.slug, "/settings"),
      };
    } catch (error) {
      if (error instanceof SliceError) return { ok: false, message: error.message };
      if (error instanceof Error && error.message === MAINNET_OFF) return { ok: false, message: MAINNET_OFF };
      console.error("starting a live slice failed", auth.membership.orgId, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
