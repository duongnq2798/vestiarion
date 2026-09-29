/**
 * Docs URLs and slugs. Kept apart from the navigation, which is built from
 * the API operations and their schemas, so a client component can use these
 * without bundling them.
 */

/** The URL path of a docs page. */
export function docsHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/** The docs slug of a pathname: `/docs` is `""`, `/docs/webhooks/verify/` is `webhooks/verify`; null outside /docs. */
export function slugOfPathname(pathname: string): string | null {
  const match = /^\/docs(?:\/(.*?))?\/?$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}
