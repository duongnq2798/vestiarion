"use server";

import "server-only";

import { growthTeamUser } from "@/lib/growth/gate";
import { HEALTH_CHECK_NAME, runScreeningCheck, screeningCheckLogLine, screeningCheckView, type ScreeningCheckView } from "@/lib/screening/check";

/**
 * The team's screening check (/admin/screening, screening health SH1). An action is a public POST endpoint, so it asks
 * the team gate first, itself, whatever the page did; anyone off the team gets NOT_AVAILABLE and nothing is called.
 *
 * Check now screens one fixed fictitious company name with the deployment's own provider and key, sent to the provider
 * and nowhere else. It adds no counterparty, writes no compliance check and nothing to any ledger: it proves the key on
 * production without screening a real person. One line goes to the deployment's logs, never the key or the full address.
 */

export interface ScreeningCheckState {
  ok: boolean;
  message: string;
  check?: ScreeningCheckView;
}

const NOT_AVAILABLE = "This is not available.";

export async function checkScreeningNowAction(): Promise<ScreeningCheckState> {
  const user = await growthTeamUser();
  if (!user) return { ok: false, message: NOT_AVAILABLE };
  const check = await runScreeningCheck(process.env, HEALTH_CHECK_NAME);
  console.info(screeningCheckLogLine(check));
  const view = screeningCheckView(check, HEALTH_CHECK_NAME, new Date());
  const message = check.ok
    ? `${check.label} answered in ${check.ms} ms${check.keySet ? ": the key works" : ""}.`
    : check.problem
      ? "No lookup was made: the screening settings are not usable."
      : `${check.label} gave no verdict: ${view.result.replace(/[.!?]+$/, "")}.`;
  return { ok: check.ok, message, check: view };
}
