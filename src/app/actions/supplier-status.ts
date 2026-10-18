"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { shareSupplierStatus, stopSupplierStatus } from "@/lib/commands/supplier-status";
import { inOrg } from "@/lib/dal/scope";
import { publicOrigin } from "@/lib/public-origin";

/**
 * A supplier's payment status link, from Bills & receivables' Bills tab
 * (docs/superpowers/specs/2026-10-18-supplier-status-design.md V1, V6): an owner or admin makes or stops a link
 * (`records.write`). Through the commands, inside the workspace's scope.
 */

export interface SupplierStatusActionResult {
  ok: boolean;
  message: string;
  /** The new link, given once, when it is made. */
  url?: string;
}

export async function shareSupplierStatusAction(_previous: SupplierStatusActionResult, formData: FormData): Promise<SupplierStatusActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = z.string().uuid().safeParse(formData.get("counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: "Choose a supplier." };
  const days = Number(formData.get("days"));
  return inOrg(auth, async () => {
    const outcome = await shareSupplierStatus(consoleActor(auth), { counterpartyId: counterpartyId.data, days });
    if (outcome.ok || outcome.changed) revalidateOrgPages();
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, message: outcome.message, url: `${publicOrigin()}/supplier/${outcome.token}` };
  });
}

export async function stopSupplierStatusAction(_previous: SupplierStatusActionResult, formData: FormData): Promise<SupplierStatusActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const linkId = z.string().uuid().safeParse(formData.get("linkId"));
  if (!linkId.success) return { ok: false, message: "That is not one of this workspace's." };
  return inOrg(auth, async () => consoleAnswer(await stopSupplierStatus(consoleActor(auth), { linkId: linkId.data })));
}
