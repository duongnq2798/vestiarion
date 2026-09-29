/**
 * Docs URLs and slugs. Kept apart from the navigation, which is built from
 * the API operations and their schemas, so a client component can use these
 * without bundling them.
 */

/** The URL path of a docs page. */
export function docsHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/**
 * The URL path of a page's Markdown view: `/docs.md`, `/docs/api/list-invoices.md`.
 * A rewrite in `next.config.ts` serves it from `/docs-md/…`; a plain `<a>`
 * links it, since it is a document, not a page to navigate to.
 */
export function docsMarkdownPath(slug: string): string {
  return `${docsHref(slug)}.md`;
}

/** The docs slug of a pathname: `/docs` is `""`, `/docs/webhooks/verify/` is `webhooks/verify`; null outside /docs. */
export function slugOfPathname(pathname: string): string | null {
  const match = /^\/docs(?:\/(.*?))?\/?$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}

/**
 * Whether `href` is a page of this site, which a link reaches by client-side
 * navigation (`next/link`). A document is not: a `.md` view, `llms.txt`, the
 * OpenAPI JSON or anything else under `/api/` is served by a route handler
 * and opened with a plain `<a>`; so is another site, and an anchor.
 */
export function isPageHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return false;
  return !/\.(?:md|txt|json)(?:[?#]|$)/.test(href);
}
