import { screeningSettingsFromEnv } from "../config";
import { PROVIDER_NAMES, screeningProvider } from "./providers";

/**
 * Screens one name with the provider the environment names (screening providers SP5), before its key is set in the
 * deployment: the verdict, the best matches and how long it took. Never the key, and of the address only its origin.
 */
export async function checkScreening(env: Record<string, string | undefined>, name: string, now: () => number = Date.now): Promise<{ ok: boolean; lines: string[] }> {
  let settings: ReturnType<typeof screeningSettingsFromEnv>;
  try {
    settings = screeningSettingsFromEnv(env);
  } catch (error) {
    return { ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
  if (!settings.url || !settings.provider) {
    return {
      ok: false,
      lines: ["No screening provider is configured: set SCREENING_PROVIDER=opensanctions with SCREENING_API_KEY, or SCREENING_PROVIDER=yente with SCREENING_API_URL."],
    };
  }
  const label = PROVIDER_NAMES[settings.provider].label;
  let origin: string;
  try {
    origin = new URL(settings.url).origin;
  } catch {
    return { ok: false, lines: [`The address for ${label} is not a URL: give it as https://host or https://host/match/<dataset>.`] };
  }
  const lines = [`Provider: ${label} at ${origin}${settings.apiKey ? ", with a key" : ", without a key"}`];
  const started = now();
  try {
    const result = await screeningProvider(settings.provider, { url: settings.url, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) }).screen(name, null, new Set());
    lines.push(`Screened "${name}" in ${now() - started} ms: ${result.riskLevel}. ${result.notes}`);
    for (const match of (result.matches ?? []).slice(0, 3)) lines.push(`  ${match.caption}, ${match.score}${match.topics.length ? ` (${match.topics.join(", ")})` : ""}`);
    return { ok: true, lines };
  } catch (error) {
    lines.push(`Screening failed after ${now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, lines };
  }
}
