import "server-only";
import { z } from "zod";
import { platformDb } from "../dal";

/**
 * Live screening across every workspace (docs/superpowers/specs/2026-10-22-screening-health-design.md SH3), for the
 * team's /admin/screening only, after its gate: the last complete live check, the last failed one with its note's first
 * 120 characters, and how many of each in the last 24 hours and 7 days. `screening_health()` (migration 0139) reads it
 * as the service role, live checks only, naming each workspace by its slug: no counterparty, no person. Nothing else
 * calls this; a workspace reads its own checks in its own scope (src/lib/screening/health.ts).
 */

const at = z.string().min(1);
const counts = z.object({ complete: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });

const healthSchema = z.object({
  lastComplete: z.object({ at, slug: z.string(), source: z.string() }).nullable(),
  lastFailed: z.object({ at, slug: z.string(), source: z.string(), note: z.string().nullable() }).nullable(),
  day: counts,
  week: counts,
});

export type PlatformScreeningHealth = z.infer<typeof healthSchema>;

/** The platform's live screening, or null when it could not be read, as before migration 0139 runs. */
export async function readPlatformScreeningHealth(): Promise<PlatformScreeningHealth | null> {
  try {
    const { data, error } = await platformDb().rpc("screening_health");
    if (error) throw new Error(error.message);
    return healthSchema.parse(data);
  } catch (error) {
    console.error("screening health: screening_health not read", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
