import type { MetadataRoute } from "next";
import { publishedPages } from "@/lib/docs/content";
import { publicOrigin } from "@/lib/public-origin";
import { docsHref } from "@/lib/docs/paths";

/**
 * Served at /sitemap.xml: the landing page and every docs page, the API
 * reference included. Sign-in and the workspaces are not public pages, so
 * they are not listed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  return [{ url: `${origin}/` }, ...publishedPages().map((page) => ({ url: `${origin}${docsHref(page.slug)}` }))];
}
