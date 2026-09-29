import { siteOrigin } from "@/lib/auth/env";
import { buildOpenApiDocument } from "@/lib/api/openapi";

/**
 * The OpenAPI 3.1 document for `/api/v1`. Public and static: it describes the
 * surface and holds no workspace data, so it takes no key, and it is built
 * once at build time from the same schemas the tests hold the routes to.
 */
export const dynamic = "force-static";

/** The origin the app is served from, or the production site when none is configured for this build. */
const PRODUCTION_ORIGIN = "https://www.vestiarion.xyz";

export function GET() {
  // `siteOrigin()` throws in a production build without `SITE_URL`, which is
  // right for sign-in links and wrong for a document that only names a
  // server: a build without it still gets a usable document.
  const origin = process.env.SITE_URL?.trim() ? siteOrigin() : PRODUCTION_ORIGIN;
  return Response.json(buildOpenApiDocument(origin), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
