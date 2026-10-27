import type { MetadataRoute } from "next";
import { publishedPages } from "@/lib/docs/content";
import { FREE_TOOLS, type FreeToolSlug } from "@/lib/free-tools";
import { TERM_PAGES } from "@/lib/payment-terms/pages";
import { publicOrigin } from "@/lib/public-origin";
import { docsHref } from "@/lib/docs/paths";

/** A free tool's own pages under its path, listed right after it: the payment terms calculator's term pages. */
const TOOL_PAGES: Partial<Record<FreeToolSlug, readonly string[]>> = {
  "payment-terms": TERM_PAGES.map((page) => `/payment-terms/${page.slug}`),
};

/**
 * Served at /sitemap.xml: the landing page, the open numbers, the page for
 * studios, how the agent decides, the free tools (from their one list, free
 * tool attribution TA5), each followed by its own pages (the payment terms
 * calculator's term pages), every docs page (the API reference included), then
 * the terms, the privacy page and the security page.
 * Sign-in and the workspaces are not public pages, so they are not listed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  return [
    { url: `${origin}/` },
    { url: `${origin}/open` },
    { url: `${origin}/studios` },
    { url: `${origin}/how-it-decides` },
    ...FREE_TOOLS.flatMap((tool) => [tool.path, ...(TOOL_PAGES[tool.slug] ?? [])]).map((path) => ({ url: `${origin}${path}` })),
    ...publishedPages().map((page) => ({ url: `${origin}${docsHref(page.slug)}` })),
    { url: `${origin}/terms` },
    { url: `${origin}/privacy` },
    { url: `${origin}/security` },
  ];
}
