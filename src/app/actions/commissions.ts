"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { createCommissionPayable, endCommissionPlan, setCommissionPlan } from "@/lib/commands/commissions";
import { parsePlanForm, type PlanFormField } from "@/lib/commissions/model";
import { inOrg } from "@/lib/dal/scope";

/**
 * Commissions (docs/superpowers/specs/2026-10-14-commissions-design.md C2, C10, C13): a partner's plan set, changed or
 * ended, and the payable made from what a partner is due, by an owner or admin (`records.write`, as adding a bill).
 * Through the commands, inside the workspace's scope.
 */

export interface CommissionActionResult {
  ok: boolean;
  message: string;
  /** The field a refusal is about, on the plan form. */
  field?: PlanFormField;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELOAD = "Reload the page and try again.";

function formString(formData: FormData, key: string, max = 200): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Sets a partner's plan, or changes the one in force when the form names it (`replaces`). */
export async function setCommissionPlanAction(_previous: CommissionActionResult, formData: FormData): Promise<CommissionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const read = parsePlanForm({
      beneficiaryId: formString(formData, "beneficiaryId", 64),
      rate: formString(formData, "rate", 20),
      basis: formString(formData, "basis", 20),
      scope: formString(formData, "scope", 20),
      dealIds: formData.getAll("dealIds").slice(0, 500).map((value) => (typeof value === "string" ? value.slice(0, 64) : "")),
      holdDays: formString(formData, "holdDays", 10),
      reference: formString(formData, "reference", 400),
      memberId: formString(formData, "memberId", 64),
    });
    if (!read.ok) return { ok: false, message: read.message, field: read.field };
    const replacesText = formString(formData, "replaces", 64);
    if (replacesText !== "" && !UUID.test(replacesText)) return { ok: false, message: RELOAD };
    return consoleAnswer(await setCommissionPlan(consoleActor(auth), { draft: read.draft, replaces: replacesText === "" ? null : replacesText }));
  });
}

/** Ends a partner's plan. */
export async function endCommissionPlanAction(_previous: CommissionActionResult, formData: FormData): Promise<CommissionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const planId = formString(formData, "planId", 64);
    if (!UUID.test(planId)) return { ok: false, message: RELOAD };
    return consoleAnswer(await endCommissionPlan(consoleActor(auth), { planId }));
  });
}

/** Creates one payable for exactly the commissions the review showed as due for a partner, in one currency. */
export async function createCommissionPayableAction(_previous: CommissionActionResult, formData: FormData): Promise<CommissionActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const beneficiaryId = formString(formData, "beneficiaryId", 64);
    const currency = formString(formData, "currency", 10);
    const lineIds = formString(formData, "lineIds", 40_000).split(",").filter(Boolean);
    if (!UUID.test(beneficiaryId) || (currency !== "USDC" && currency !== "EURC") || lineIds.length === 0 || lineIds.length > 1000 || !lineIds.every((id) => UUID.test(id))) {
      return { ok: false, message: RELOAD };
    }
    return consoleAnswer(await createCommissionPayable(consoleActor(auth), { beneficiaryId, currency, lineIds }));
  });
}
