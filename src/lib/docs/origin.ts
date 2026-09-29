import { siteOrigin } from "@/lib/auth/env";

/** The production site, named by public documents built without `SITE_URL`. */
export const PRODUCTION_ORIGIN = "https://www.vestiarion.xyz";

/**
 * The origin public documents name: the configured site, or production when
 * this build has none. `siteOrigin()` throws in a production build without
 * `SITE_URL`, which is right for sign-in links and wrong for a page that only
 * names where it lives.
 */
export function publicOrigin(): string {
  return process.env.SITE_URL?.trim() ? siteOrigin() : PRODUCTION_ORIGIN;
}
