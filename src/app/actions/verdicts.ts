"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { inOrg } from "@/lib/dal/scope";
import { giveVerdict, VerdictError, type GivenVerdict } from "@/lib/verdicts";

/**
 * A person's verdict on a decision of the agent's, from the console (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S3, S4): by someone who may decide payments. What follows it, Agree and pay or Disagree and return or reject, runs
 * through the payable commands Approvals uses, so it is checked and worded the same.
 */

export interface VerdictActionResult {
  ok: boolean;
  message: string;
  given?: GivenVerdict;
}

const inputSchema = z.object({
  entrySeq: z.number().int().positive(),
  verdict: z.enum(["agree", "disagree"]),
  reason: z.string().max(2000).optional(),
  then: z.enum(["pay", "return", "reject"]).optional(),
  /** The payee's address the card showed: a payment goes there or not at all, as Approve and pay's does (review C1). */
  shownAddress: z.string().max(200).optional(),
});

export async function giveVerdictAction(orgSlug: string, input: unknown): Promise<VerdictActionResult> {
  const auth = await authorize(orgSlug, "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That verdict could not be read." };
  return inOrg(auth, async () => {
    const actor = consoleActor(auth);
    try {
      const result = await giveVerdict(
        { actorId: auth.user.id, ...parsed.data },
        {
          approve: (invoiceId, shownAddress) => approvePayable(actor, { invoiceId, ...(shownAddress ? { shownAddress } : {}) }),
          reject: (invoiceId, reason) => rejectPayable(actor, { invoiceId, reason: reason ?? "" }),
          returnToAgent: (invoiceId) => returnPayable(actor, { invoiceId }),
        }
      );
      revalidateOrgPages();
      if (result.already) {
        return { ok: true, message: `A verdict was given on this decision already: ${result.given.verdict === "agree" ? "agreed" : "disagreed"}.`, given: result.given };
      }
      if (!result.recorded && result.after) return { ok: false, message: `Nothing was paid, and your verdict was not recorded: ${result.after.message}` };
      const said = result.given.verdict === "agree" ? "You agreed with the agent." : "You disagreed with the agent.";
      if (!result.after) return { ok: true, message: said, given: result.given };
      return { ok: result.after.ok, message: `${said} ${result.after.message}`, given: result.given };
    } catch (error) {
      if (error instanceof VerdictError) return { ok: false, message: error.message };
      console.error("verdict failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
