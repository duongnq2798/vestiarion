"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { loadSampleData, removeSampleData, SampleDataError } from "@/lib/sample-data";

/**
 * Loading and removing a sandbox's sample data (sample-data design §1). Both
 * are for the people who add records; the library refuses a workspace that
 * pays through Circle, and removal while money could be moving.
 */

export interface SampleDataActionResult {
  ok: boolean;
  message: string;
}

function failure(error: unknown, what: string): SampleDataActionResult {
  if (error instanceof SampleDataError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function loadSampleDataAction(_previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const counts = await loadSampleData({ actorId: auth.user.id });
      revalidateOrgPages();
      raiseCycleEvent(auth, "sample_loaded");
      return {
        ok: true,
        message: `Sample data loaded: ${counts.counterparties} counterparties, ${counts.invoices} invoices and ${counts.milestones} milestones. The agent will decide on them within a minute.`,
      };
    } catch (error) {
      return failure(error, "sample data load failed");
    }
  });
}

export async function removeSampleDataAction(_previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const removed = await removeSampleData({ actorId: auth.user.id });
      revalidateOrgPages();
      return {
        ok: true,
        message: `Sample data removed: ${removed.counterparties} counterparties, with ${removed.invoices} invoices and ${removed.milestones} milestones. The ledger keeps its entries.`,
      };
    } catch (error) {
      return failure(error, "sample data removal failed");
    }
  });
}
