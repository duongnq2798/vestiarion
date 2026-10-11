"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { checkBillList } from "@/lib/bill-import/check";
import { countFates, type ImportedFate, type RowFate } from "@/lib/bill-import/rows";
import { consoleActor, importInvoices, type ImportOutcome } from "@/lib/commands";
import { inOrg } from "@/lib/dal/scope";

/**
 * A bill list's check and import (docs/superpowers/specs/2026-10-10-import-wizard-design.md B11, B12). Both take the
 * list's text and the person's answers, and read the list again on the server: what the browser read is never trusted.
 */

export interface BillCheckResult {
  ok: boolean;
  message: string;
  fates?: RowFate[];
  counts?: { add: number; duplicate: number; error: number };
}

export interface BillImportResult {
  ok: boolean;
  message: string;
  fates?: ImportedFate[];
  counts?: ImportOutcome["counts"];
}

const TRY_AGAIN = "That did not work. Try again in a moment.";

/** Every row's fate, with nothing written. */
export async function checkBillListAction(orgSlug: string, text: string, settings: unknown): Promise<BillCheckResult> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const checked = await checkBillList(typeof text === "string" ? text : "", settings);
      if (!checked.ok) return { ok: false, message: checked.message };
      const counts = countFates(checked.fates);
      return { ok: true, message: `${counts.add} to add, ${counts.duplicate} already in Vestiarion, ${counts.error} can't be added.`, fates: checked.fates, counts };
    } catch (error) {
      console.error("checking a bill list failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Adds the list's rows through the `invoice.import` command. */
export async function importBillListAction(orgSlug: string, text: string, settings: unknown): Promise<BillImportResult> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const outcome = await importInvoices(consoleActor(auth), { text: typeof text === "string" ? text : "", settings });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    if (outcome.counts.added > 0) {
      revalidatePath("/");
      revalidateOrgPages();
    }
    return { ok: true, message: outcome.message, fates: outcome.fates, counts: outcome.counts };
  });
}
