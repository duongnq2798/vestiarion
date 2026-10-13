"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { applyReceivedPayment, reverseAppliedPayment } from "@/lib/commands/allocations";
import { inOrg } from "@/lib/dal/scope";

/**
 * Applying money received to receivables, recording a fee, and reversing either, from Bills & receivables
 * (docs/superpowers/specs/2026-10-12-allocations-design.md L10): by someone who may enter records (`records.write`), as
 * adding an invoice is, through the commands, inside the workspace's scope. The server plans and checks every row again.
 */

const RULES = ["reference", "exact", "combination", "short_fee", "oldest_first"] as const;

const applySchema = z
  .object({
    paymentId: z.string().uuid().nullable(),
    version: z.number().int().min(0).nullable(),
    lines: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.string().max(40) })).max(50),
    fees: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.string().max(40), reason: z.string().max(2000) })).max(50),
    suggestion: z.object({ rule: z.enum(RULES), why: z.string().max(600) }).nullable().optional(),
  })
  // A person applies a payment as they read it: its version comes with it.
  .refine((input) => input.paymentId === null || input.version !== null);

const reverseSchema = z.object({ allocationId: z.string().uuid(), reason: z.string().max(2000) });

const UNREADABLE = "That could not be read. Reload the page and try again.";

export async function applyPaymentAction(orgSlug: string, input: unknown): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize(orgSlug, "receivables.reconcile");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: UNREADABLE };
  return inOrg(auth, async () => consoleAnswer(await applyReceivedPayment(consoleActor(auth), parsed.data)));
}

export async function reverseAllocationAction(orgSlug: string, input: unknown): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize(orgSlug, "receivables.reconcile");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: UNREADABLE };
  return inOrg(auth, async () => consoleAnswer(await reverseAppliedPayment(consoleActor(auth), parsed.data)));
}
