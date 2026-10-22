"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { STATEMENT_MAX_BYTES, type StatementChoices } from "@/lib/bank-statement/lines";
import { inOrg } from "@/lib/dal/scope";
import { checkVendorStatement, VendorStatementError, type VendorStatementResult } from "@/lib/vendor-statement/check";

/** What Check their statement answers (vendor statement VS4): the check, or why there is none, in words. */
export interface VendorStatementAnswer {
  ok: boolean;
  message?: string;
  result?: VendorStatementResult;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a vendor's statement of account against its bills and the payments made to it (docs/superpowers/specs/
 * 2026-10-22-vendor-statement-design.md), for whoever may reconcile payables. The statement's text and the person's
 * choices are read again on the server; nothing of the file is kept, and nothing is paid or changed.
 */
export async function checkVendorStatementAction(orgSlug: string, counterpartyId: string, source: string, choices: StatementChoices): Promise<VendorStatementAnswer> {
  const auth = await authorize(orgSlug, "payables.reconcile");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (typeof counterpartyId !== "string" || !UUID.test(counterpartyId)) return { ok: false, message: "That vendor is not in this workspace." };
  if (typeof source !== "string" || source.trim() === "") return { ok: false, message: "Paste the statement's table or choose its file first." };
  if (source.length > STATEMENT_MAX_BYTES) return { ok: false, message: "Choose a statement smaller than 2 MB." };
  return inOrg(auth, async () => {
    try {
      const result = await checkVendorStatement({
        actorId: auth.user.id,
        counterpartyId,
        source,
        choices: choices && typeof choices === "object" ? choices : {},
        today: new Date().toISOString().slice(0, 10),
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof VendorStatementError) return { ok: false, message: error.message };
      console.error("vendor statement check failed", error instanceof Error ? error.message.slice(0, 160) : "unknown error");
      return { ok: false, message: "The statement could not be checked. Try again in a moment." };
    }
  });
}
