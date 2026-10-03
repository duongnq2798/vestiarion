import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import type { MDXProps } from "mdx/types";
import { operationById } from "@/lib/api/openapi";
import { slugifyHeadings, type Heading } from "./headings";
import { flatPages, type NavPage } from "./nav";
import { referenceHeadings } from "./reference";

/**
 * The docs pages' MDX, in `content/docs`: `""` is `index.mdx`, and
 * `get-started/quickstart` is `get-started/quickstart.mdx`.
 */

export const CONTENT_DIR = path.join(process.cwd(), "content", "docs");

/** The file a slug's page is written in. */
export function sourcePath(slug: string): string {
  return path.join(CONTENT_DIR, `${slug || "index"}.mdx`);
}

/** The page's raw MDX. Throws when the file does not exist. */
export function readSource(slug: string): string {
  return readFileSync(sourcePath(slug), "utf8");
}

export function hasSource(slug: string): boolean {
  return existsSync(sourcePath(slug));
}

/** Whether `slug` is a generated API reference page, `api/<operation id>`. */
export function isReferenceSlug(slug: string): boolean {
  return slug.startsWith("api/") && operationById(slug.slice("api/".length)) !== undefined;
}

/**
 * The pages that are served, in nav order: every generated reference page,
 * and every other page whose MDX is written. The nav also lists pages still
 * to be written; the Markdown views, `llms.txt`, search and the sitemap
 * leave those out, so none of them points at a 404.
 */
export function publishedPages(): NavPage[] {
  return flatPages().filter((page) => isReferenceSlug(page.slug) || hasSource(page.slug));
}

type MdxModule = { default: ComponentType<MDXProps> };

/**
 * One loader per MDX file. Each import is a literal the bundler can see, so
 * every page is compiled at build time; a page added to `content/docs` needs
 * its line here too, which the content test checks.
 */
export const PAGE_LOADERS: Record<string, () => Promise<MdxModule>> = {
  "": () => import("../../../content/docs/index.mdx"),
  "data-delivery": () => import("../../../content/docs/data-delivery.mdx"),
  contracts: () => import("../../../content/docs/contracts.mdx"),
  "guides/try-it": () => import("../../../content/docs/guides/try-it.mdx"),
  "guides/go-live": () => import("../../../content/docs/guides/go-live.mdx"),
  "guides/first-payment": () => import("../../../content/docs/guides/first-payment.mdx"),
  "guides/pay-a-contractor": () => import("../../../content/docs/guides/pay-a-contractor.mdx"),
  "guides/get-paid": () => import("../../../content/docs/guides/get-paid.mdx"),
  "guides/telegram": () => import("../../../content/docs/guides/telegram.mdx"),
  "guides/email-invoices": () => import("../../../content/docs/guides/email-invoices.mdx"),
  "guides/slack": () => import("../../../content/docs/guides/slack.mdx"),
  "guides/api-invoices": () => import("../../../content/docs/guides/api-invoices.mdx"),
  "guides/api-milestones": () => import("../../../content/docs/guides/api-milestones.mdx"),
  "guides/github": () => import("../../../content/docs/guides/github.mdx"),
  "guides/audit-export": () => import("../../../content/docs/guides/audit-export.mdx"),
  "research/model-vs-policy": () => import("../../../content/docs/research/model-vs-policy.mdx"),
  "get-started/quickstart": () => import("../../../content/docs/get-started/quickstart.mdx"),
  "get-started/sdk": () => import("../../../content/docs/get-started/sdk.mdx"),
  "get-started/authentication": () => import("../../../content/docs/get-started/authentication.mdx"),
  "get-started/errors": () => import("../../../content/docs/get-started/errors.mdx"),
  "get-started/pagination": () => import("../../../content/docs/get-started/pagination.mdx"),
  "get-started/limits": () => import("../../../content/docs/get-started/limits.mdx"),
  api: () => import("../../../content/docs/api.mdx"),
  webhooks: () => import("../../../content/docs/webhooks.mdx"),
  "webhooks/payload": () => import("../../../content/docs/webhooks/payload.mdx"),
  "webhooks/verify": () => import("../../../content/docs/webhooks/verify.mdx"),
  "webhooks/retries": () => import("../../../content/docs/webhooks/retries.mdx"),
  "webhooks/security": () => import("../../../content/docs/webhooks/security.mdx"),
  "webhooks/guarantees": () => import("../../../content/docs/webhooks/guarantees.mdx"),
  "ai-integration": () => import("../../../content/docs/ai-integration.mdx"),
  "ai-integration/mcp": () => import("../../../content/docs/ai-integration/mcp.mdx"),
  changelog: () => import("../../../content/docs/changelog.mdx"),
};

/** The compiled page, or null when no MDX file is registered for `slug`. */
export async function loadPage(slug: string): Promise<{ Content: ComponentType<MDXProps> } | null> {
  const load = Object.hasOwn(PAGE_LOADERS, slug) ? PAGE_LOADERS[slug] : undefined;
  if (!load) return null;
  const mod = await load();
  return { Content: mod.default };
}

/**
 * One loader per notes file, `content/docs/api/<id>.mdx`, keyed by operation
 * id: what a reference page says beyond its schema. A reference page renders
 * its notes only when it has a loader here; the content test checks that
 * every notes file has one and every loader its file.
 */
export const NOTES_LOADERS: Record<string, () => Promise<MdxModule>> = {
  "get-status": () => import("../../../content/docs/api/get-status.mdx"),
  "list-ledger-entries": () => import("../../../content/docs/api/list-ledger-entries.mdx"),
  "verify-ledger": () => import("../../../content/docs/api/verify-ledger.mdx"),
};

/** The MDX of an operation's notes, `content/docs/api/<id>.mdx`, or null when it has none. */
export function notesSource(id: string): string | null {
  return Object.hasOwn(NOTES_LOADERS, id) ? readSource(`api/${id}`) : null;
}

/** The `##` and `###` headings a published page renders, with their anchors: its MDX's, or a reference page's sections and notes. */
export function pageHeadings(slug: string): Heading[] {
  if (!isReferenceSlug(slug)) return slugifyHeadings(readSource(slug));
  const id = slug.slice("api/".length);
  return referenceHeadings(notesSource(id), { body: operationById(id)?.requestBody !== undefined });
}

/** The compiled notes for an operation's reference page, and their source; null when it has none. */
export async function loadNotes(id: string): Promise<{ Content: ComponentType<MDXProps>; source: string } | null> {
  const load = Object.hasOwn(NOTES_LOADERS, id) ? NOTES_LOADERS[id] : undefined;
  if (!load) return null;
  const mod = await load();
  return { Content: mod.default, source: readSource(`api/${id}`) };
}
