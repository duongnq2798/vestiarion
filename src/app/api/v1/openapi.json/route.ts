import { buildOpenApiDocument } from "@/lib/api/openapi";
import { publicOrigin } from "@/lib/docs/origin";

/**
 * The OpenAPI 3.1 document for `/api/v1`. Public and static: it describes the
 * surface and holds no workspace data, so it takes no key, and it is built
 * once at build time from the same schemas the tests hold the routes to.
 */
export const dynamic = "force-static";

export function GET() {
  // A build without `SITE_URL` still gets a usable document, naming production.
  return Response.json(buildOpenApiDocument(publicOrigin()), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
