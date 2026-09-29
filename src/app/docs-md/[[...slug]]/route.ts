import { publishedPages } from "@/lib/docs/content";
import { pageMarkdown } from "@/lib/docs/markdown";
import { publicOrigin } from "@/lib/docs/origin";

/**
 * Each docs page as Markdown. Reached through rewrites in `next.config.ts`:
 * `/docs.md` and `/docs/<slug>.md` land here, since the App Router has no
 * suffix on a catch-all segment. Public and built once, one file per page; an
 * address that is not a page answers 404.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return publishedPages().map((page) => ({ slug: page.slug ? page.slug.split("/") : [] }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const markdown = pageMarkdown(((await params).slug ?? []).join("/"), publicOrigin());
  if (markdown === null) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
