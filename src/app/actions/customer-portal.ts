"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { closeCustomerRequestCommand, replyToCustomerRequest, shareCustomerStatement, stopCustomerStatement } from "@/lib/commands/customer-portal";
import { inOrg } from "@/lib/dal/scope";
import { publicOrigin } from "@/lib/public-origin";

/**
 * A customer's statement link, and answering what customers said through it, from Bills & receivables' Receivables tab
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P8, P9): an owner or admin makes or stops a link, replies
 * and closes a request (`records.write`). Through the commands, inside the workspace's scope.
 */

export interface CustomerPortalActionResult {
  ok: boolean;
  message: string;
  /** The new link, given once, when it is made. */
  url?: string;
}

const NOT_FOUND = "That is not one of this workspace's.";

export async function shareCustomerStatementAction(_previous: CustomerPortalActionResult, formData: FormData): Promise<CustomerPortalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = z.string().uuid().safeParse(formData.get("counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: "Choose a customer." };
  const days = Number(formData.get("days"));
  return inOrg(auth, async () => {
    const outcome = await shareCustomerStatement(consoleActor(auth), { counterpartyId: counterpartyId.data, days });
    if (outcome.ok || outcome.changed) revalidateOrgPages();
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, message: outcome.message, url: `${publicOrigin()}/statement/${outcome.token}` };
  });
}

export async function stopCustomerStatementAction(_previous: CustomerPortalActionResult, formData: FormData): Promise<CustomerPortalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const linkId = z.string().uuid().safeParse(formData.get("linkId"));
  if (!linkId.success) return { ok: false, message: NOT_FOUND };
  return inOrg(auth, async () => consoleAnswer(await stopCustomerStatement(consoleActor(auth), { linkId: linkId.data })));
}

export async function replyToCustomerAction(_previous: CustomerPortalActionResult, formData: FormData): Promise<CustomerPortalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "receivables.reconcile");
  if (!auth.ok) return { ok: false, message: auth.message };
  const requestId = z.string().uuid().safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: NOT_FOUND };
  const body = String(formData.get("body") ?? "").slice(0, 4000);
  return inOrg(auth, async () => consoleAnswer(await replyToCustomerRequest(consoleActor(auth), { requestId: requestId.data, body })));
}

export async function closeCustomerRequestAction(_previous: CustomerPortalActionResult, formData: FormData): Promise<CustomerPortalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "receivables.reconcile");
  if (!auth.ok) return { ok: false, message: auth.message };
  const requestId = z.string().uuid().safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: NOT_FOUND };
  const outcome = z.enum(["resolved", "not_received"]).safeParse(formData.get("outcome"));
  if (!outcome.success) return { ok: false, message: "Choose how to close it." };
  return inOrg(auth, async () => consoleAnswer(await closeCustomerRequestCommand(consoleActor(auth), { requestId: requestId.data, outcome: outcome.data })));
}
