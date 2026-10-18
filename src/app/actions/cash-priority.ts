"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { setCashPriorityOrder } from "@/lib/commands/cash-priority";
import { inOrg } from "@/lib/dal/scope";

/**
 * A person's order for which bills the cash goes to first, from the Payment plan tab
 * (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md O2, O3): owners, admins and approvers, through the
 * command, inside the workspace's scope.
 */

export interface CashPriorityActionResult {
  ok: boolean;
  message: string;
}

const orderSchema = z.array(z.string().uuid()).min(2).max(200);

export async function setCashPriorityOrderAction(_previous: CashPriorityActionResult, formData: FormData): Promise<CashPriorityActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  const fingerprint = z.string().regex(/^[0-9a-f]{32}$/).safeParse(formData.get("fingerprint"));
  const basedOn = z.string().min(1).max(64).safeParse(formData.get("basedOn"));
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(formData.get("order") ?? "null"));
  } catch {
    parsed = null;
  }
  const order = orderSchema.safeParse(parsed);
  if (!fingerprint.success || !basedOn.success || !order.success) return { ok: false, message: "The order must name each bill once." };
  return inOrg(auth, async () => consoleAnswer(await setCashPriorityOrder(consoleActor(auth), { fingerprint: fingerprint.data, basedOn: basedOn.data, order: order.data })));
}
