import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { CONTENT_DIR, hasSource, NOTES_LOADERS, PAGE_LOADERS, readSource } from "@/lib/docs/content";
import { slugifyHeadings, splitCodeSpans, stripFences } from "@/lib/docs/headings";
import { DOCS_NAV, flatPages, neighbours, slugOfPathname } from "@/lib/docs/nav";
import { referenceSectionIds } from "@/lib/docs/reference";

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
/** Generated from the OpenAPI operations; they need no MDX file, and may have a notes file. */
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
  "webhooks",
  "webhooks/payload",
  "webhooks/verify",
  "webhooks/retries",
  "webhooks/security",
  "webhooks/guarantees",
  "ai-integration",
  "changelog",
]);

/** Real app pages outside /docs that a docs page may link to. */
const APP_ROUTES = new Set(["/", "/login", "/signup", "/onboarding"]);

/** The source without code: fenced blocks and inline code spans, where a link is an example, not a link. */
function withoutCode(source: string): string {
  return stripFences(source)
    .split(/(\n[ \t]*\n)/)
    .map((block) =>
      splitCodeSpans(block)
        .filter((piece) => !piece.code)
        .map((piece) => piece.text)
        .join(" ")
    )
    .join("");
}

/**
 * Every link target in `source`, in document order: inline links `](x)`,
 * reference definitions `[r]: x` and JSX `href="x"` or `href={"x"}`.
 */
function linkTargets(source: string): string[] {
  const text = withoutCode(source);
  const found: Array<{ at: number; target: string }> = [];
  const add = (matches: IterableIterator<RegExpMatchArray>) => {
    for (const match of matches) {
      const target = match.slice(1).find((group) => group !== undefined) ?? "";
      found.push({ at: match.index ?? 0, target: target.replace(/^<|>$/g, "") });
    }
  };
  add(text.matchAll(/\]\(\s*(<[^>]*>|[^)\s]*)/g));
  add(text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm));
  add(text.matchAll(/\bhref=(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g));
  return found.sort((a, b) => a.at - b.at).map((link) => link.target);
}

/** What is wrong with each link on the page at `slug`; empty when every link lands. */
function linkProblems(slug: string, source: string, sourceOf: (slug: string) => string | null): string[] {
  const problems: string[] = [];
  for (const link of linkTargets(source)) {
    // Another site, or mail: not ours to check.
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) continue;
    if (!link.startsWith("/") && !link.startsWith("#")) {
      problems.push(`${link}: a relative link; docs links are absolute, /docs/…`);
      continue;
    }

    const [target, anchor] = link.split("#", 2) as [string, string | undefined];
    const pathOnly = target.replace(/\?.*$/, "");
    const trimmed = pathOnly.length > 1 ? pathOnly.replace(/\/$/, "") : pathOnly;

    let targetSlug: string;
    if (trimmed === "") {
      targetSlug = slug;
    } else if (trimmed === "/docs" || trimmed === "/docs.md") {
      targetSlug = "";
    } else if (trimmed.startsWith("/docs/")) {
      targetSlug = trimmed.slice("/docs/".length).replace(/\.md$/, "");
    } else {
      if (trimmed.startsWith("/api/") || trimmed.startsWith("/llms")) {
        if (!OTHER_TARGETS.has(trimmed)) problems.push(`${link}: no such public document`);
      } else if (!APP_ROUTES.has(trimmed)) {
        problems.push(`${link}: not a docs page, a public document or a known app page`);
      }
      continue;
    }

    if (!NAV_SLUGS.has(targetSlug) && !GENERATED_SLUGS.has(targetSlug)) {
      problems.push(`${link}: no docs page "${targetSlug}"`);
      continue;
    }
    if (anchor === undefined) continue;
    const targetSource = sourceOf(targetSlug);
    if (GENERATED_SLUGS.has(targetSlug)) {
      // A reference page's headings are its fixed sections, then its notes' headings.
      if (!referenceSectionIds(targetSource).includes(anchor)) problems.push(`${link}: no section #${anchor} on "${targetSlug}"`);
      continue;
    }
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

  it("lists the endpoint overview, then one generated page per operation in table order, titled with its summary", () => {
    const api = DOCS_NAV.find((section) => section.title === "API reference")!;
    expect(api.pages.map((page) => [page.slug, page.title])).toEqual([
      ["api", "Endpoint overview"],
      ...OPERATIONS.map((op) => [`api/${op.id}`, op.summary]),
    ]);
    expect(api.pages.find((page) => page.slug === "api/get-counterparty")?.description).toBe(
      "One counterparty, with up to 20 recent compliance screenings, newest first."
    );
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

describe("slugOfPathname", () => {
  it("reads the docs slug from a pathname, and nothing outside /docs", () => {
    expect(slugOfPathname("/docs")).toBe("");
    expect(slugOfPathname("/docs/")).toBe("");
    expect(slugOfPathname("/docs/get-started/quickstart")).toBe("get-started/quickstart");
    expect(slugOfPathname("/docs/webhooks/verify/")).toBe("webhooks/verify");
    expect(slugOfPathname("/docsfoo")).toBeNull();
    expect(slugOfPathname("/o/acme/docs")).toBeNull();
    expect(slugOfPathname("/")).toBeNull();
  });
});

describe("every docs page has its MDX", () => {
  it("names only real nav pages as written later", () => {
    expect([...WRITTEN_LATER].filter((slug) => !NAV_SLUGS.has(slug))).toEqual([]);
  });

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
    expect(FILE_SLUGS.filter((slug) => !GENERATED_SLUGS.has(slug)).sort()).toEqual(Object.keys(PAGE_LOADERS).sort());
  });

  it("of a reference page's notes has a notes loader, and every notes loader has its file", () => {
    expect(FILE_SLUGS.filter((slug) => GENERATED_SLUGS.has(slug)).sort()).toEqual(Object.keys(NOTES_LOADERS).map((id) => `api/${id}`).sort());
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
      '<a href="/llms.txt">llms</a> <Link href="/docs/webhooks/verify#node">node</Link> <a href={"/docs"}>docs</a>',
      "[console](/onboarding) [home](/) [site](https://www.vestiarion.xyz/x) [mail](mailto:a@b.test) [by ref][r]",
      "Code is not a link: `[in code](/docs/nope)` and ``[also](errors)``.",
      "```md\n[in code](/docs/nope)\n```",
      "",
      "[r]: /docs/webhooks/verify#node",
    ].join("\n");
    expect(linkProblems("", `## Start here\n\n${page}`, sourceOf)).toEqual([]);
  });

  it("checks an anchor into a reference page against its fixed sections, and its notes' headings when it has notes", () => {
    const [plain, noted] = [OPERATIONS[0].id, OPERATIONS[1].id];
    const withNotes = (slug: string) => (slug === `api/${noted}` ? "## Watermark cursor\n" : sourceOf(slug));
    const page = [
      `[a](/docs/api/${plain}#parameters) [b](/docs/api/${plain}#code-samples) [c](/docs/api/${plain}#response) [d](/docs/api/${plain}#errors)`,
      `[e](/docs/api/${noted}#notes) [f](/docs/api/${noted}#watermark-cursor)`,
      `[g](/docs/api/${plain}#notes) [h](/docs/api/${plain}#nowhere)`,
    ].join("\n");
    expect(linkProblems("", page, withNotes)).toEqual([
      `/docs/api/${plain}#notes: no section #notes on "api/${plain}"`,
      `/docs/api/${plain}#nowhere: no section #nowhere on "api/${plain}"`,
    ]);
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

  it("reports a relative link: docs links are absolute", () => {
    expect(linkProblems("", '[a](errors) [b](../webhooks) <Link href="verify">c</Link>', sourceOf)).toEqual([
      "errors: a relative link; docs links are absolute, /docs/…",
      "../webhooks: a relative link; docs links are absolute, /docs/…",
      "verify: a relative link; docs links are absolute, /docs/…",
    ]);
  });

  it("reports a root link outside /docs, /api and /llms that is not a known app page", () => {
    expect(linkProblems("", "[a](/o/acme/settings) [b](/login) [c](/pricing)", sourceOf)).toEqual([
      "/o/acme/settings: not a docs page, a public document or a known app page",
      "/pricing: not a docs page, a public document or a known app page",
    ]);
  });

  it("checks the target of a reference definition", () => {
    expect(linkProblems("", "[a][r]\n\n[r]: /docs/nope\n", sourceOf)).toEqual(['/docs/nope: no docs page "nope"']);
  });
});
