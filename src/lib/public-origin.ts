import { resolveSiteOrigin } from "./auth/env";

export const PRODUCTION_ORIGIN = "https://www.vestiarion.xyz";

/**
 * Public metadata must always name the canonical site. Unlike authentication
 * links, it can safely fall back to production when a build has no SITE_URL.
 */
export function resolvePublicOrigin(raw: string | undefined): string {
  return raw?.trim()
    ? resolveSiteOrigin(raw, "production")
    : PRODUCTION_ORIGIN;
}

export function publicOrigin(): string {
  return resolvePublicOrigin(process.env.SITE_URL);
}
