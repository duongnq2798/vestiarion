import { z } from "zod";
import type { ScreeningResult } from "../compliance";

/**
 * The services a deployment screens names with (docs/superpowers/specs/2026-10-21-screening-providers-design.md
 * SP1-SP3). A provider turns a name into the verdict the compliance sweep writes; which one runs is the deployment's
 * choice, in its environment, so a new key, plan or server needs no code. Another service is one more entry here.
 */

/** How many matches a counterparty keeps for review (migration 0060's bound). */
export const MATCHES_KEPT = 25;

/**
 * Above yente's 0.70 default match cutoff on purpose: a high tier removes payment authority, so a fuzzy sanctions match
 * stays medium for review while a strong same-entity match fails closed at high.
 */
export const STRONG_SANCTIONS_MATCH_THRESHOLD = 0.85;

export type ScreeningProviderId = "opensanctions" | "yente";

export interface ScreeningProvider {
  id: ScreeningProviderId;
  /** The name the console and the evidence give it. */
  label: string;
  /** What a verdict records as its `source`. */
  source: string;
  screen(name: string, jurisdiction: string | null | undefined, dismissed: ReadonlySet<string>): Promise<ScreeningResult>;
}

/** Where a provider is reached, and its key when it needs one. */
export interface ProviderSettings {
  url: string;
  apiKey?: string;
}

/** OpenSanctions' hosted API, the default address for the `opensanctions` provider. */
export const OPENSANCTIONS_API_URL = "https://api.opensanctions.org";

const yenteMatchSchema = z.object({
  responses: z.record(
    z.string(),
    z.object({
      status: z.number(),
      results: z.array(
        z.object({
          id: z.string(),
          caption: z.string().optional(),
          score: z.number().min(0).max(1),
          target: z.boolean().optional(),
          properties: z.record(z.string(), z.array(z.string())).default({}),
        })
      ),
    })
  ),
});

export type YenteCandidate = z.infer<typeof yenteMatchSchema>["responses"][string]["results"][number];

/** A yente match's best candidate as a verdict: a strong sanctions match high, any other match medium, none clear. */
export function classifyYenteCandidate(candidate: YenteCandidate | undefined, source: string, label: string): ScreeningResult {
  if (!candidate) {
    return { riskLevel: "clear", notes: `${label} returned no matching entity`, source, screeningMode: "live", rawScore: null, matchedEntityId: null, matchedTopics: [] };
  }
  const topics = candidate.properties.topics ?? [];
  const sanctionsHit = topics.some((topic) => topic === "sanction" || topic.startsWith("sanction."));
  const riskLevel = sanctionsHit && candidate.score >= STRONG_SANCTIONS_MATCH_THRESHOLD ? "high" : "medium";
  return {
    riskLevel,
    notes: `${candidate.caption ?? candidate.id} matched at ${candidate.score.toFixed(3)}${topics.length ? ` (${topics.join(", ")})` : ""}`,
    source,
    screeningMode: "live",
    rawScore: candidate.score,
    matchedEntityId: candidate.id,
    matchedTopics: topics,
  };
}

function matchEndpoint(baseUrl: string, limit: number): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = new URL(/\/match\/[^/]+$/.test(trimmed) ? trimmed : `${trimmed}/match/default`);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

/**
 * A provider that speaks yente's match API (SP2): OpenSanctions' hosted API and a self-hosted yente server ask and
 * answer the same way. `dismissed` names entities a person dismissed as not this counterparty (dismiss screening match
 * R2): they are skipped, and the best match left, if any, is judged as usual.
 */
function yenteProvider(id: ScreeningProviderId, label: string, source: string, settings: ProviderSettings): ScreeningProvider {
  return {
    id,
    label,
    source,
    async screen(name, jurisdiction, dismissed) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (settings.apiKey) headers.Authorization = `ApiKey ${settings.apiKey}`;
      // Enough candidates that the dismissed ones can never crowd out one that is not (review every match R1).
      const response = await fetch(matchEndpoint(settings.url, Math.min(200, dismissed.size + MATCHES_KEPT)), {
        method: "POST",
        headers,
        body: JSON.stringify({
          queries: { counterparty: { schema: "LegalEntity", properties: { name: [name], ...(jurisdiction ? { jurisdiction: [jurisdiction] } : {}) } } },
        }),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`${label} screening failed with HTTP ${response.status}`);
      const parsed = yenteMatchSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error(`${label} returned an invalid match response`);
      const query = parsed.data.responses.counterparty;
      if (!query || query.status >= 400) throw new Error(`${label} query failed with status ${query?.status ?? "missing"}`);
      const remaining = query.results.filter((candidate) => !dismissed.has(candidate.id));
      const result = classifyYenteCandidate(remaining[0], source, label);
      return remaining.length === 0
        ? result
        : {
            ...result,
            matches: remaining.slice(0, MATCHES_KEPT).map((candidate) => ({
              id: candidate.id,
              caption: candidate.caption ?? candidate.id,
              score: Number(candidate.score.toFixed(3)),
              topics: candidate.properties.topics ?? [],
            })),
          };
    },
  };
}

/** Each provider's name and the `source` its verdicts record. */
export const PROVIDER_NAMES: Record<ScreeningProviderId, { label: string; source: string }> = {
  opensanctions: { label: "OpenSanctions", source: "opensanctions:yente" },
  yente: { label: "a yente server", source: "yente:self-hosted" },
};

/** The provider for a deployment's choice and its settings. */
export function screeningProvider(id: ScreeningProviderId, settings: ProviderSettings): ScreeningProvider {
  const { label, source } = PROVIDER_NAMES[id];
  return yenteProvider(id, label, source, settings);
}

/** The provider a verdict's `source` names, if a live one. */
export function providerOfSource(source: string): ScreeningProviderId | null {
  if (source.startsWith("opensanctions")) return "opensanctions";
  if (source.startsWith("yente")) return "yente";
  return null;
}
