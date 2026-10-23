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
 * The new workspace is theirs; the answer links its Settings, where it goes live. The accountants they kept ticked join
 * it as accountants (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC4).
 */

export interface LiveSliceActionResult {
  ok: boolean;
  message: string;
  /** The new workspace's Settings, once it is made. */
  url?: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";

/** What the result says of the accountants brought along (AC4): who joined, and who to invite on its Members. */
function sliceAccountantsLine(accountants: { added: string[]; notAdded: string[] }): string {
  const joined =
    accountants.added.length === 0 ? "" : accountants.added.length === 1 ? " Your accountant joined it." : ` ${accountants.added.length} accountants joined it.`;
  const left =
    accountants.notAdded.length === 0
      ? ""
      : accountants.notAdded.length === 1
        ? " An accountant could not be brought along: invite them on its Members."
        : ` ${accountants.notAdded.length} accountants could not be brought along: invite them on its Members.`;
  return joined + left;
}

export async function startLiveSliceAction(_previous: LiveSliceActionResult, formData: FormData): Promise<LiveSliceActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  // Arc mainnet open to this person, as for creating a workspace there (mainnet go-live M2).
  if (!mayUseMainnet(auth.user.email, currentConfig())) return { ok: false, message: MAINNET_NOT_OPEN };
  const vendorIds = formData.getAll("vendorId").map(String);
  const accountantIds = formData.getAll("accountantId").map(String);
  return inOrg(auth, async () => {
    try {
      const started = await startLiveSlice({ userId: auth.user.id, vendorIds, accountantIds });
      revalidateOrgPages();
      const skipped = started.skipped.length > 0 ? ` ${started.skipped.length} stayed here: ${started.skipped.map((vendor) => vendor.name).join(", ")}.` : "";
      return {
        ok: true,
        message: `Opened ${started.slug} on Arc mainnet with ${started.carried.length} ${started.carried.length === 1 ? "vendor" : "vendors"}.${skipped}${sliceAccountantsLine(started.accountants)} Next: take it live from its Settings.`,
        url: orgHref(started.slug, "/settings"),
      };
    } catch (error) {
      // Opened but not recorded here: its link, so no second one is opened.
      if (error instanceof SliceError) return { ok: false, message: error.message, ...(error.slug ? { url: orgHref(error.slug, "/settings") } : {}) };
      if (error instanceof Error && error.message === MAINNET_OFF) return { ok: false, message: MAINNET_OFF };
      console.error("starting a live slice failed", auth.membership.orgId, error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
