import type { MetadataRoute } from "next";
import { publishedPages } from "@/lib/docs/content";
import { publicOrigin } from "@/lib/public-origin";
import { docsHref } from "@/lib/docs/paths";

/**
 * Served at /sitemap.xml: the landing page, the open numbers, the page for
 * studios, how the agent decides, every docs page (the API reference included), then the terms and the privacy page.
 * Sign-in and the workspaces are not public pages, so they are not listed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  return [
    { url: `${origin}/` },
    { url: `${origin}/open` },
    { url: `${origin}/studios` },
    { url: `${origin}/how-it-decides` },
    ...publishedPages().map((page) => ({ url: `${origin}${docsHref(page.slug)}` })),
    { url: `${origin}/terms` },
    { url: `${origin}/privacy` },
  ];
}
