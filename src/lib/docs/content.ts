import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import type { MDXProps } from "mdx/types";

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

type MdxModule = { default: ComponentType<MDXProps> };

/**
 * One loader per MDX file. Each import is a literal the bundler can see, so
 * every page is compiled at build time; a page added to `content/docs` needs
 * its line here too, which the content test checks.
 */
export const PAGE_LOADERS: Record<string, () => Promise<MdxModule>> = {
  "": () => import("../../../content/docs/index.mdx"),
  api: () => import("../../../content/docs/api.mdx"),
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
export const NOTES_LOADERS: Record<string, () => Promise<MdxModule>> = {};

/** The compiled notes for an operation's reference page, and their source; null when it has none. */
export async function loadNotes(id: string): Promise<{ Content: ComponentType<MDXProps>; source: string } | null> {
  const load = Object.hasOwn(NOTES_LOADERS, id) ? NOTES_LOADERS[id] : undefined;
  if (!load) return null;
  const mod = await load();
  return { Content: mod.default, source: readSource(`api/${id}`) };
}
