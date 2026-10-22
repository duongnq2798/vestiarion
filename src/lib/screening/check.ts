import type { ScreeningCandidate, ScreeningResult } from "../compliance";
import { screeningSettingsFromEnv, screeningVariableSet, type ScreeningVariableSet } from "../config";
import { PROVIDER_NAMES, SCREENING_FAILURE_WORDS, screeningHttpFailure, screeningProvider, type ScreeningFailureKind, type ScreeningProviderId } from "./providers";

/**
 * Screens one name with the provider the environment names: before its key is set in the deployment (screening
 * providers SP5, `npm run screening:check`), and on the deployment itself, from the team's /admin/screening (screening
 * health SH1). The verdict, the best matches and how long it took. Never the key, and of the address only its origin:
 * a provider's own error is shown with both taken out.
 */

/** The one name the team's check screens (SH1): a fictitious company, so no real person's name leaves the deployment. */
export const HEALTH_CHECK_NAME = "Zenith Trading Example LLC";

/** What the environment sets up, without calling anyone. Names, an origin and whether a key is set; never a value. */
export interface ScreeningSetup {
  variableSet: ScreeningVariableSet | null;
  provider: ScreeningProviderId | null;
  /** The provider's name, as the console gives it. */
  label: string | null;
  origin: string | null;
  keySet: boolean;
  /** Why no lookup can be made: the settings are refused at start, missing, or the address is not a URL. */
  problem: string | null;
}

/** One check's outcome: the setup, then what the provider answered. */
export interface ScreeningCheck extends ScreeningSetup {
  ok: boolean;
  ms: number | null;
  /** The HTTP status a provider refused with (SH2), and what it means. */
  httpStatus: number | null;
  failure: ScreeningFailureKind | null;
  /** Why the lookup failed, with the key and every address but its origin taken out. */
  error: string | null;
  riskLevel: ScreeningResult["riskLevel"] | null;
  notes: string | null;
  /** The best three matches. */
  matches: ScreeningCandidate[];
}

const NO_PROVIDER =
  "No screening provider is configured: set SCREENING_PROVIDER=opensanctions with SCREENING_API_KEY, or SCREENING_PROVIDER=yente with SCREENING_API_URL.";

interface Resolved {
  setup: ScreeningSetup;
  target?: { provider: ScreeningProviderId; url: string; apiKey?: string };
}

function resolve(env: Record<string, string | undefined>): Resolved {
  const variableSet = screeningVariableSet(env);
  const keyNamed = Boolean((variableSet === "SCREENING_*" ? env.SCREENING_API_KEY : env.OPENSANCTIONS_API_KEY)?.trim());
  const refused = (problem: string, provider: ScreeningProviderId | null = null): Resolved => ({
    setup: { variableSet, provider, label: provider ? PROVIDER_NAMES[provider].label : null, origin: null, keySet: keyNamed, problem },
  });
  let settings: ReturnType<typeof screeningSettingsFromEnv>;
  try {
    settings = screeningSettingsFromEnv(env);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  if (!settings.url || !settings.provider) return refused(NO_PROVIDER);
  const label = PROVIDER_NAMES[settings.provider].label;
  let origin: string;
  try {
    origin = new URL(settings.url).origin;
  } catch {
    return refused(`The address for ${label} is not a URL: give it as https://host or https://host/match/<dataset>.`, settings.provider);
  }
  return {
    setup: { variableSet, provider: settings.provider, label, origin, keySet: Boolean(settings.apiKey), problem: null },
    target: { provider: settings.provider, url: settings.url, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) },
  };
}

/** The environment's screening setup, read without calling the provider. */
export function screeningSetup(env: Record<string, string | undefined>): ScreeningSetup {
  return resolve(env).setup;
}

/**
 * Text with the key and every address but its origin taken out. An error a fetch throws can quote the address it was
 * asked for, and a self-hosted address can carry its own key (`?api_key=`); neither is ever shown or logged.
 */
export function redactScreeningSecrets(text: string, secrets: { apiKey?: string }): string {
  const keyless = secrets.apiKey ? text.split(secrets.apiKey).join("[redacted]") : text;
  return keyless.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, (address) => {
    try {
      const { origin } = new URL(address);
      return origin === "null" ? "[redacted]" : origin;
    } catch {
      return "[redacted]";
    }
  });
}

/** As `redactScreeningSecrets`, with every key the environment sets: for text the deployment recorded, such as a failed check's note. */
export function redactForEnv(text: string, env: Record<string, string | undefined>): string {
  return [env.SCREENING_API_KEY, env.OPENSANCTIONS_API_KEY].reduce<string>((out, key) => redactScreeningSecrets(out, { apiKey: key?.trim() || undefined }), text);
}

/** Screens `name` with the environment's provider, structured for the team's page. */
export async function runScreeningCheck(env: Record<string, string | undefined>, name: string, now: () => number = Date.now): Promise<ScreeningCheck> {
  const { setup, target } = resolve(env);
  const outcome = { ok: false, ms: null, httpStatus: null, failure: null, error: null, riskLevel: null, notes: null, matches: [] };
  if (!target) return { ...setup, ...outcome };
  const started = now();
  try {
    const result = await screeningProvider(target.provider, { url: target.url, ...(target.apiKey ? { apiKey: target.apiKey } : {}) }).screen(name, null, new Set());
    return { ...setup, ...outcome, ok: true, ms: now() - started, riskLevel: result.riskLevel, notes: result.notes, matches: (result.matches ?? []).slice(0, 3) };
  } catch (error) {
    const ms = now() - started;
    const http = screeningHttpFailure(error);
    const message = redactScreeningSecrets(error instanceof Error ? error.message : String(error), target);
    return { ...setup, ...outcome, ms, httpStatus: http?.status ?? null, failure: http?.kind ?? null, error: message };
  }
}

/** The check as the command prints it (SP5): the provider, then the verdict and the best matches, or why it failed. */
export function screeningCheckLines(check: ScreeningCheck, name: string): string[] {
  if (check.problem) return [check.problem];
  const lines = [`Provider: ${check.label} at ${check.origin}${check.keySet ? ", with a key" : ", without a key"}`];
  if (!check.ok) return [...lines, `Screening failed after ${check.ms} ms: ${check.error}`];
  lines.push(`Screened "${name}" in ${check.ms} ms: ${check.riskLevel}. ${check.notes}`);
  for (const match of check.matches) lines.push(`  ${match.caption}, ${match.score}${match.topics.length ? ` (${match.topics.join(", ")})` : ""}`);
  return lines;
}

export async function checkScreening(env: Record<string, string | undefined>, name: string, now: () => number = Date.now): Promise<{ ok: boolean; lines: string[] }> {
  const check = await runScreeningCheck(env, name, now);
  return { ok: check.ok, lines: screeningCheckLines(check, name) };
}

/** What the team's page shows of one check (SH1): plain data, never the key or more of the address than its origin. */
export interface ScreeningCheckView {
  name: string;
  provider: string | null;
  origin: string | null;
  keySet: boolean;
  variableSet: ScreeningVariableSet | null;
  /** "OK", "HTTP 401: the key is refused", "Failed: …", or why no lookup was made. */
  result: string;
  httpStatus: number | null;
  ms: number | null;
  /** "clear: OpenSanctions returned no matching entity", when it answered. */
  verdict: string | null;
  checkedAt: string;
}

export function screeningCheckView(check: ScreeningCheck, name: string, checkedAt: Date): ScreeningCheckView {
  const result = check.ok
    ? "OK"
    : check.problem
      ? check.problem
      : check.httpStatus !== null && check.failure
        ? `HTTP ${check.httpStatus}: ${SCREENING_FAILURE_WORDS[check.failure]}`
        : `Failed: ${check.error}`;
  return {
    name,
    provider: check.label,
    origin: check.origin,
    keySet: check.keySet,
    variableSet: check.variableSet,
    result,
    httpStatus: check.httpStatus,
    ms: check.ms,
    verdict: check.ok ? `${check.riskLevel}: ${check.notes}` : null,
    checkedAt: checkedAt.toISOString(),
  };
}

/** The one line a check writes for the deployment's logs (SH1): provider, origin, ok, status, ms. Never the key or the full address. */
export function screeningCheckLogLine(check: ScreeningCheck): string {
  const status = check.ok ? "2xx" : (check.httpStatus ?? "none");
  return `screening check: provider=${check.provider ?? "none"} origin=${check.origin ?? "none"} ok=${check.ok} status=${status} ms=${check.ms ?? "none"}`;
}
