import { ReportingCurrencyError, setReportingCurrency } from "../reporting-currency";
import { saveScenarioVersion, ScenarioVersionError } from "../scenario-versions";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * How the workspace reports and plans its money (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4,
 * M7): the reporting currency, and a cash scenario saved as a version with the rates typed into it. Owners and admins
 * (`reporting.manage`), from the console only. Neither changes what is paid.
 */

export async function setWorkspaceReportingCurrency(actor: Actor, input: { currency: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "workspace.reporting_currency");
  if (refusal) return refusal;
  try {
    const setting = await setReportingCurrency({ actorId: actor.userId, currency: input.currency });
    return done(`Reports and plans now total in ${setting.currency}, with the rates shown. Payments still settle in USDC.`);
  } catch (error) {
    if (error instanceof ReportingCurrencyError) return refused(error.code, error.message);
    console.error("setting the reporting currency failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function saveCashScenario(
  actor: Actor,
  input: { scenarioId: string | null; name: string; levers: unknown; rates: unknown; reportingCurrency: string | null }
): Promise<CommandOutcome<{ scenarioId: string; version: number }>> {
  const refusal = gate(actor, "cash_scenario.save");
  if (refusal) return refusal;
  try {
    const saved = await saveScenarioVersion({ actorId: actor.userId, ...input });
    return done(`Saved as version ${saved.version} of "${saved.name}".`, { scenarioId: saved.scenarioId, version: saved.version });
  } catch (error) {
    if (error instanceof ScenarioVersionError) return refused(error.code, error.message);
    console.error("saving a cash scenario failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
