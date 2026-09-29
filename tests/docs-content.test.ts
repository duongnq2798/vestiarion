import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { CONTENT_DIR, hasSource, PAGE_LOADERS, readSource } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";
import { DOCS_NAV, flatPages, neighbours } from "@/lib/docs/nav";

/**
 * The docs' content and its navigation agree: every page in the nav has its
 * MDX, every MDX file is in the nav, and every link between pages lands on a
 * page and a heading that exist.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every MDX file under content/docs, as the slug it would be served at. */
const FILE_SLUGS = walk(CONTENT_DIR)
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => path.relative(CONTENT_DIR, file).split(path.sep).join("/").replace(/\.mdx$/, ""))
  .map((slug) => (slug === "index" ? "" : slug));

const NAV_SLUGS = new Set(flatPages().map((page) => page.slug));
/** Generated from the OpenAPI operations; they need no MDX file. */
const GENERATED_SLUGS = new Set(OPERATIONS.map((op) => `api/${op.id}`));
/** Internal addresses outside /docs that a page may link to. */
const OTHER_TARGETS = new Set(["/api/v1/openapi.json", "/llms.txt", "/llms-full.txt"]);

/**
 * Pages whose MDX is written later: the endpoint overview comes with the
 * generated reference, the rest with the content. Until each file exists its
 * check is a todo; once it exists it is checked like any other page.
 */
const WRITTEN_LATER = new Set([
  "data-delivery",
  "get-started/quickstart",
  "get-started/authentication",
  "get-started/errors",
  "get-started/pagination",
  "get-started/limits",
  "api",
  "webhooks",
  "webhooks/payload",
  "webhooks/verify",
  "webhooks/retries",
  "webhooks/security",
  "webhooks/guarantees",
  "ai-integration",
  "changelog",
]);

/** The source without its fenced code blocks, where a link is an example, not a link. */
function withoutCode(source: string): string {
  return source.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, "");
}

/** Where each internal link in `source` points: `](/docs/x#y)`, `href="/docs/x"`, `](#y)`. */
function internalLinks(source: string): string[] {
  const text = withoutCode(source);
  const markdown = [...text.matchAll(/\]\((\/[^)\s]*|#[^)\s]*)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
  const jsx = [...text.matchAll(/href=["'{`]+(\/[^"'`}\s]*|#[^"'`}\s]*)/g)].map((match) => match[1]);
  return [...markdown, ...jsx];
}

/** What is wrong with each internal link on the page at `slug`; empty when every link lands. */
function linkProblems(slug: string, source: string, sourceOf: (slug: string) => string | null): string[] {
  const problems: string[] = [];
  for (const link of internalLinks(source)) {
    const [target, anchor] = link.split("#", 2) as [string, string | undefined];
    const pathOnly = target.replace(/\/$/, "");

    let targetSlug: string;
    if (pathOnly === "") {
      targetSlug = slug;
    } else if (pathOnly === "/docs" || pathOnly === "/docs.md") {
      targetSlug = "";
    } else if (pathOnly.startsWith("/docs/")) {
      targetSlug = pathOnly.slice("/docs/".length).replace(/\.md$/, "");
    } else {
      if ((pathOnly.startsWith("/api/") || pathOnly.startsWith("/llms")) && !OTHER_TARGETS.has(pathOnly)) {
        problems.push(`${link}: no such public document`);
      }
      continue;
    }

    if (!NAV_SLUGS.has(targetSlug) && !GENERATED_SLUGS.has(targetSlug)) {
      problems.push(`${link}: no docs page "${targetSlug}"`);
      continue;
    }
    if (anchor === undefined) continue;
    const targetSource = sourceOf(targetSlug);
    if (targetSource === null) {
      problems.push(`${link}: "${targetSlug}" has no MDX source to check the anchor against`);
      continue;
    }
    if (!slugifyHeadings(targetSource).some((heading) => heading.id === anchor)) {
      problems.push(`${link}: no heading #${anchor} on "${targetSlug}"`);
    }
  }
  return problems;
}

const sourceOnDisk = (slug: string) => (hasSource(slug) ? readSource(slug) : null);

describe("the docs navigation", () => {
  it("lists every page once", () => {
    const slugs = flatPages().map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(DOCS_NAV.map((section) => section.title)).toEqual(["Overview", "Get started", "API reference", "Webhooks", "AI integration", "Changelog"]);
  });

  it("gives every page a title and a description", () => {
    for (const page of flatPages()) {
      expect(page.title.trim(), page.slug).not.toBe("");
      expect(page.description.trim(), page.slug).not.toBe("");
    }
  });

  it("links each page to the ones before and after it, across sections", () => {
    const pages = flatPages();
    expect(neighbours("").prev).toBeUndefined();
    expect(neighbours("").next?.slug).toBe(pages[1].slug);
    expect(neighbours("data-delivery").next?.slug).toBe("get-started/quickstart");
    expect(neighbours(pages[pages.length - 1].slug).next).toBeUndefined();
    expect(neighbours("no-such-page")).toEqual({});
  });
});

describe("every docs page has its MDX", () => {
  const written = flatPages().filter((page) => !GENERATED_SLUGS.has(page.slug));
  for (const page of written) {
    const name = `/docs${page.slug ? `/${page.slug}` : ""} has content/docs/${page.slug || "index"}.mdx`;
    if (WRITTEN_LATER.has(page.slug) && !hasSource(page.slug)) {
      it.todo(name);
    } else {
      it(name, () => expect(hasSource(page.slug)).toBe(true));
    }
  }
});

describe("every MDX file", () => {
  it("is a page in the nav", () => {
    expect(FILE_SLUGS.filter((slug) => !NAV_SLUGS.has(slug))).toEqual([]);
  });

  it("has a loader, so the bundler compiles it, and every loader has its file", () => {
    expect([...FILE_SLUGS].sort()).toEqual(Object.keys(PAGE_LOADERS).sort());
  });

  it.each(FILE_SLUGS.map((slug) => [slug || "index"] as const))("%s leaves the page title to the nav: no `#` heading", (name) => {
    const slug = name === "index" ? "" : name;
    expect(withoutCode(readSource(slug))).not.toMatch(/^ {0,3}# /m);
  });

  it.each(FILE_SLUGS.map((slug) => [slug || "index", slug] as const))("%s links only to pages and headings that exist", (_name, slug) => {
    expect(linkProblems(slug, readSource(slug), sourceOnDisk)).toEqual([]);
  });
});

describe("the link check", () => {
  const sources: Record<string, string> = {
    "": "## Start here\n",
    "webhooks/verify": "## Node\n\n## Example\n\n## Example\n",
  };
  const sourceOf = (slug: string) => sources[slug] ?? null;

  it("accepts pages, generated pages, public documents and existing anchors", () => {
    const page = [
      "[home](/docs) [verify](/docs/webhooks/verify#example-2) [same](#start-here)",
      `[ref](/docs/api/${OPERATIONS[0].id}) [md](/docs/webhooks/verify.md) [spec](/api/v1/openapi.json)`,
      '<a href="/llms.txt">llms</a> <Link href="/docs/webhooks/verify#node">node</Link>',
      "```md\n[in code](/docs/nope)\n```",
    ].join("\n");
    expect(linkProblems("", `## Start here\n\n${page}`, sourceOf)).toEqual([]);
  });

  it("reports a missing page, a missing anchor and an unknown public document", () => {
    const page = "[a](/docs/nope) [b](/docs/webhooks/verify#example-3) [c](/api/v1/status) [d](#nowhere)";
    expect(linkProblems("", page, sourceOf)).toEqual([
      '/docs/nope: no docs page "nope"',
      '/docs/webhooks/verify#example-3: no heading #example-3 on "webhooks/verify"',
      "/api/v1/status: no such public document",
      '#nowhere: no heading #nowhere on ""',
    ]);
  });
});
