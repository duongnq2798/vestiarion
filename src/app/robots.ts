import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Served at /robots.txt (docs/superpowers/specs/2026-10-28-robots-sitemap-design.md): every crawler may read every
 * page, as when the file was missing, and it names /sitemap.xml so a search engine finds the public pages, a new free
 * tool's included, without waiting for a link to each. It disallows nothing: a page kept out of search says so itself
 * with `noindex`, which a crawler barred from the page would never read.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${publicOrigin()}/sitemap.xml`,
  };
}
