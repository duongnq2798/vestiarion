"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { utcDay } from "@/lib/copy";
import { inOrg } from "@/lib/dal/scope";
import { parseRecurringForm } from "@/lib/recurring";
import { createRecurringPayable, RecurringPayableError, stopRecurringPayable } from "@/lib/recurring-payables";

/**
 * Recurring payments on AP / AR (docs/superpowers/specs/2026-10-02-recurring-payables-design.md §2):
 * an owner or admin (`records.write`) sets one up or stops it. Setting one up starts a cycle, so a
 * period already near has its invoice within a minute.
 */

export interface RecurringActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function failure(error: unknown, what: string): RecurringActionResult {
  if (error instanceof RecurringPayableError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function createRecurringPayableAction(_previous: RecurringActionResult, formData: FormData): Promise<RecurringActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = parseRecurringForm({
    counterpartyId: formString(formData, "counterpartyId"),
    amount: formString(formData, "amount"),
    currency: formString(formData, "currency"),
    memo: formString(formData, "memo"),
    poReference: formString(formData, "poReference"),
    everyCount: formString(formData, "everyCount"),
    everyUnit: formString(formData, "everyUnit"),
    startsOn: formString(formData, "startsOn"),
    endsOn: formString(formData, "endsOn"),
    goodsReceived: formData.get("goodsReceived") === "on",
  });
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return inOrg(auth, async () => {
    try {
      const created = await createRecurringPayable({ actorId: auth.user.id, form: parsed.value });
      revalidateOrgPages();
      raiseCycleEvent(auth, "recurring_added");
      return {
        ok: true,
        message: `${created.counterpartyName} is paid ${parsed.value.amount} ${parsed.value.currency} ${created.cadence}, first due ${utcDay(`${parsed.value.startsOn}T00:00:00Z`)}. Each period's invoice appears under Payables as it comes near.`,
      };
    } catch (error) {
      return failure(error, "recurring payment not created");
    }
  });
}

const idSchema = z.string().uuid();

export async function stopRecurringPayableAction(_previous: RecurringActionResult, formData: FormData): Promise<RecurringActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const id = idSchema.safeParse(formString(formData, "recurringId"));
  if (!id.success) return { ok: false, message: "That recurring payment was not found." };
  return inOrg(auth, async () => {
    try {
      const stopped = await stopRecurringPayable({ actorId: auth.user.id, id: id.data });
      revalidateOrgPages();
      return { ok: true, message: `Stopped the recurring payment to ${stopped.counterpartyName}. Invoices it already created stay as they are.` };
    } catch (error) {
      return failure(error, "recurring payment not stopped");
    }
  });
}
