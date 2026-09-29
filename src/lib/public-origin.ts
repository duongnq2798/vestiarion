import { resolveSiteOrigin } from "./auth/env";

export const PRODUCTION_ORIGIN = "https://www.vestiarion.xyz";

/**
 * Public metadata always names www.vestiarion.xyz on the production Vercel
 * deployment. Preview and local builds may use SITE_URL; sign-in links keep
 * their stricter, separate `siteOrigin()` policy.
 */
export function resolvePublicOrigin(
  raw: string | undefined,
  vercelEnv: string | undefined,
): string {
  if (vercelEnv === "production") return PRODUCTION_ORIGIN;
  return raw?.trim()
    ? resolveSiteOrigin(raw, "production")
    : PRODUCTION_ORIGIN;
}

export function publicOrigin(): string {
  return resolvePublicOrigin(process.env.SITE_URL, process.env.VERCEL_ENV);
}
