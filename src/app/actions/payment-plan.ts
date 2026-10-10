"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { approvePlanLines } from "@/lib/commands/payment-plan";
import { inOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";

export interface PlanActionResult {
  ok: boolean;
  message: string;
}

const fingerprintSchema = z.string().regex(/^[a-z0-9]{1,40}$/);
const lineSchema = z.string().transform((value, context) => {
  const [invoiceId, fingerprint, ...rest] = value.split(":");
  const parsed = z.object({ invoiceId: z.string().uuid(), fingerprint: fingerprintSchema }).safeParse({ invoiceId, fingerprint });
  if (!parsed.success || rest.length > 0) {
    context.addIssue({ code: "custom", message: "not a plan line" });
    return z.NEVER;
  }
  return parsed.data;
});
const requestSchema = z.object({ planFingerprint: fingerprintSchema, lines: z.array(lineSchema).min(1).max(100) });

/**
 * Approve, or Approve all shown, on Bills & receivables' payment plan (docs/superpowers/specs/2026-10-11-payment-plan-design.md
 * P9, P10): authorizes `approval.decide` first, then hands the plan's fingerprint and each line's (`<invoice id>:<line
 * fingerprint>`) to the command, which reads the plan again and checks every line on its own.
 */
export async function approvePlanAction(_previous: PlanActionResult, formData: FormData): Promise<PlanActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = requestSchema.safeParse({ planFingerprint: formData.get("planFingerprint"), lines: formData.getAll("line") });
    if (!parsed.success) return { ok: false, message: "Reload the page and try again." };
    return consoleAnswer(await approvePlanLines(consoleActor(auth), parsed.data));
  });
}
