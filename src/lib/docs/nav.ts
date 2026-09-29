/**
 * The developer docs' navigation: the one list the sidebar, the pager, the
 * static pages, search, the Markdown views and `llms.txt` are all built from.
 * A page exists when it is here and its MDX file is in `content/docs`; the
 * content test checks both directions.
 */

export interface NavPage {
  /** `""` is `/docs`; `"get-started/quickstart"` is `/docs/get-started/quickstart`. */
  slug: string;
  title: string;
  description: string;
}

export interface NavSection {
  title: string;
  pages: NavPage[];
}

export const DOCS_NAV: NavSection[] = [
  {
    title: "Overview",
    pages: [
      { slug: "", title: "Overview", description: "What Vestiarion is, and what its API and webhooks give an integration." },
      { slug: "data-delivery", title: "Data delivery methods", description: "REST pull or webhook push: how each delivers data, and when to use which." },
    ],
  },
  {
    title: "Get started",
    pages: [
      { slug: "get-started/quickstart", title: "Quickstart", description: "Create a workspace API key and make your first requests." },
      { slug: "get-started/authentication", title: "Authentication", description: "Workspace API keys: their format, scope, revocation and use." },
      { slug: "get-started/errors", title: "Errors", description: "The error codes, their HTTP statuses and the error body." },
      { slug: "get-started/pagination", title: "Pagination", description: "Page through collections with limit and an opaque cursor." },
      { slug: "get-started/limits", title: "Limits", description: "Page sizes, backing off on 429 and 503, and how fresh the data is." },
    ],
  },
  {
    title: "API reference",
    pages: [{ slug: "api", title: "Endpoint overview", description: "Every v1 endpoint, what it answers, and the conventions they share." }],
  },
  {
    title: "Webhooks",
    pages: [
      { slug: "webhooks", title: "Webhooks overview", description: "Signed webhooks that push each ledger entry to your endpoint." },
      { slug: "webhooks/payload", title: "Payload and headers", description: "The body and headers of every webhook delivery." },
      { slug: "webhooks/verify", title: "Verifying signatures", description: "Check a delivery's signature, and a ledger entry's Ed25519 signature." },
      { slug: "webhooks/retries", title: "Retries and disabling", description: "How a failed delivery is retried, and when an endpoint is disabled." },
      { slug: "webhooks/security", title: "Security", description: "Which endpoint URLs are accepted, how long deliveries are kept, and who sees them." },
      { slug: "webhooks/guarantees", title: "Delivery guarantees", description: "At-least-once and out-of-order delivery, and how a receiver handles both." },
    ],
  },
  {
    title: "AI integration",
    pages: [{ slug: "ai-integration", title: "AI integration", description: "Markdown views, llms.txt and the OpenAPI document, for coding agents." }],
  },
  {
    title: "Changelog",
    pages: [{ slug: "changelog", title: "Changelog", description: "Changes to the API and webhooks, newest first." }],
  },
];

/** Every page, in nav order. */
export function flatPages(): NavPage[] {
  return DOCS_NAV.flatMap((section) => section.pages);
}

/** The pages before and after `slug` in nav order, across sections. */
export function neighbours(slug: string): { prev?: NavPage; next?: NavPage } {
  const pages = flatPages();
  const index = pages.findIndex((page) => page.slug === slug);
  if (index < 0) return {};
  return { prev: pages[index - 1], next: pages[index + 1] };
}

/** The URL path of a docs page. */
export function docsHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/** The page at `slug` and the title of its section, or undefined when the nav has no such page. */
export function findPage(slug: string): { page: NavPage; section: string } | undefined {
  for (const section of DOCS_NAV) {
    const page = section.pages.find((candidate) => candidate.slug === slug);
    if (page) return { page, section: section.title };
  }
  return undefined;
}

/** The docs slug of a pathname: `/docs` is `""`, `/docs/webhooks/verify/` is `webhooks/verify`; null outside /docs. */
export function slugOfPathname(pathname: string): string | null {
  const match = /^\/docs(?:\/(.*?))?\/?$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}
