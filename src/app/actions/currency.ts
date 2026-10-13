"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { saveCashScenario, setWorkspaceReportingCurrency } from "@/lib/commands/currency";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { reportingCurrencyOrNull } from "@/lib/reporting-currency";

/**
 * The reporting currency from Settings, and a cash scenario saved as a version from Treasury's What if section
 * (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4, M7): an owner's or admin's
 * (`reporting.manage`), through the commands, inside the workspace's scope.
 */

export interface CurrencyActionResult {
  ok: boolean;
  message: string;
  /** A saved scenario's id and version, so the next save of it is the version after. */
  scenarioId?: string;
  version?: number;
}

function formString(formData: FormData, key: string, max: number): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** A JSON field of the form, or undefined when it does not read. */
function formJson(formData: FormData, key: string): unknown {
  const text = formString(formData, key, 32_768);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function setReportingCurrencyAction(_previous: CurrencyActionResult, formData: FormData): Promise<CurrencyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "reporting.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const currency = formString(formData, "currency", 8);
  return inOrg(auth, async () => consoleAnswer(await setWorkspaceReportingCurrency(consoleActor(auth), { currency })));
}

export async function saveCashScenarioAction(_previous: CurrencyActionResult, formData: FormData): Promise<CurrencyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "reporting.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const scenarioId = formString(formData, "scenarioId", 64);
  const name = formString(formData, "name", 200);
  return inOrg(auth, async () => {
    const outcome = await saveCashScenario(consoleActor(auth), {
      scenarioId: /^[0-9a-f-]{36}$/i.test(scenarioId) ? scenarioId : null,
      name,
      levers: formJson(formData, "levers"),
      rates: formJson(formData, "rates"),
      // The reporting currency the scenario was saved under, read here, never taken from the form.
      reportingCurrency: await reportingCurrencyOrNull(db()).catch(() => null),
    });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateOrgPages();
    return { ok: true, message: outcome.message, scenarioId: outcome.scenarioId, version: outcome.version };
  });
}
