"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { EscrowHoldError, lockMilestone, refundMilestone } from "@/lib/circle/escrow-holds";
import { EscrowSetupError, setUpEscrow } from "@/lib/circle/escrow-setup";
import { inOrg } from "@/lib/dal/scope";
import { FeatureOffError } from "@/lib/network";
import { PaymentsDisabledError } from "@/lib/payments-switch";

export interface EscrowActionResult {
  ok: boolean;
  message: string;
  /** Circle failed a step: the form makes a new request id (as the Gateway funding form does). */
  renew?: true;
}

const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LIVE_ONLY = "Escrow is a contract on Arc testnet, for a live workspace. Take this workspace live first.";

/**
 * Sets up the workspace's milestone escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E2):
 * an owner's or admin's deliberate act, in a live workspace. Pressed again, it finishes a setup that was
 * interrupted; it never deploys twice.
 */
export async function setUpEscrowAction(_previous: EscrowActionResult, formData: FormData): Promise<EscrowActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.membership.mode !== "live") {
    return { ok: false, message: LIVE_ONLY };
  }
  return inOrg(auth, async () => {
    try {
      const escrow = await setUpEscrow({ actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: `Escrow is set up at ${escrow.address}. Lock a milestone in it from its card.` };
    } catch (error) {
      if (error instanceof PaymentsDisabledError || error instanceof FeatureOffError) return { ok: false, message: error.message };
      if (error instanceof EscrowSetupError) {
        revalidateOrgPages();
        return { ok: false, message: error.message };
      }
      console.error("setUpEscrowAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "Setting up escrow did not finish. Try again: what was done is kept, and nothing is sent twice." };
    }
  });
}

/**
 * Locks a milestone's USDC in the workspace's escrow until a refund date (milestone escrow E3): an owner's or
 * admin's act. The form carries an id made when it was shown, so a double click locks once.
 */
export async function lockMilestoneAction(_previous: EscrowActionResult, formData: FormData): Promise<EscrowActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.membership.mode !== "live") return { ok: false, message: LIVE_ONLY };
  const milestoneId = idSchema.safeParse(formData.get("milestoneId"));
  if (!milestoneId.success) return { ok: false, message: "That milestone is not in this workspace." };
  const refundAfter = dateSchema.safeParse(formData.get("refundAfter"));
  if (!refundAfter.success) return { ok: false, message: "Choose a refund date after today, and within a year." };
  const requestId = idSchema.safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: "Reload the page and try again." };
  return inOrg(auth, async () => {
    try {
      await lockMilestone({ actorId: auth.user.id, milestoneId: milestoneId.data, refundAfter: refundAfter.data, requestId: requestId.data });
      revalidateOrgPages();
      return { ok: true, message: `Locked in escrow until ${refundAfter.data}.` };
    } catch (error) {
      if (error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      if (error instanceof EscrowHoldError) return error.renew ? { ok: false, message: error.message, renew: true } : { ok: false, message: error.message };
      console.error("lockMilestoneAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "Locking did not finish. Try again: nothing is locked twice." };
    }
  });
}

/** Takes a milestone's hold back to the workspace from its refund date (milestone escrow E5): an owner's or admin's act. */
export async function refundMilestoneAction(_previous: EscrowActionResult, formData: FormData): Promise<EscrowActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.membership.mode !== "live") return { ok: false, message: LIVE_ONLY };
  const milestoneId = idSchema.safeParse(formData.get("milestoneId"));
  if (!milestoneId.success) return { ok: false, message: "That milestone is not in this workspace." };
  const requestId = idSchema.safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: "Reload the page and try again." };
  return inOrg(auth, async () => {
    try {
      await refundMilestone({ actorId: auth.user.id, milestoneId: milestoneId.data, requestId: requestId.data });
      revalidateOrgPages();
      return { ok: true, message: "Refunded from escrow to this workspace." };
    } catch (error) {
      if (error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      if (error instanceof EscrowHoldError) {
        revalidateOrgPages();
        return error.renew ? { ok: false, message: error.message, renew: true } : { ok: false, message: error.message };
      }
      console.error("refundMilestoneAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "The refund did not finish. Try again: nothing is sent twice." };
    }
  });
}
