/**
 * Organization URLs. Deliberately free of imports: `next.config.ts` loads this
 * file to build its redirects.
 */

export const FOUNDING_ORG_SLUG = "founding";

/** Mirrors the `orgs.slug` check constraint in migration 0015. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function orgHref(slug: string, path: string): string {
  if (!isValidSlug(slug)) throw new Error(`not an organization slug: ${slug}`);
  if (!path.startsWith("/")) throw new Error(`organization paths start with "/": ${path}`);
  return `/o/${slug}${path}`;
}

/** The id of a payable's card on Approvals, so a link from another page opens the page at that card. */
export function approvalAnchor(invoiceId: string): string {
  return `payable-${invoiceId}`;
}

export const LEGACY_PRODUCT_PATHS = [
  "/console", "/audit", "/compliance", "/contractors", "/counterparties", "/insights", "/invoices",
] as const;

/** Temporary (307): these paths belonged to the only business there was. */
export function legacyRedirects(): { source: string; destination: string; permanent: false }[] {
  return [
    ...LEGACY_PRODUCT_PATHS.map((path) => ({
      source: path,
      destination: orgHref(FOUNDING_ORG_SLUG, path),
      permanent: false as const,
    })),
    { source: "/app", destination: orgHref(FOUNDING_ORG_SLUG, "/console"), permanent: false as const },
  ];
}
