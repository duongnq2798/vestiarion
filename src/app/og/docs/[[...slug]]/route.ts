import { docsPreviewImage } from "@/app/_og/DocsPreview";
import { flatPages } from "@/lib/docs/nav";

/**
 * The social image of each docs page, at `docsImagePath(slug)`. It is a
 * route handler rather than an `opengraph-image` file because Next.js allows
 * nothing after an optional catch-all such as `docs/[[...slug]]`. Every page
 * in the nav is rendered at build time; any other address is a 404.
 */
export function generateStaticParams() {
  return flatPages().map((page) => ({ slug: page.slug ? page.slug.split("/") : [] }));
}

export const dynamicParams = false;

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const image = docsPreviewImage(((await params).slug ?? []).join("/"));
  return image ?? new Response(null, { status: 404 });
}
