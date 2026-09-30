import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_FOR, type ApiErrorCode } from "@/lib/api/contract";
import { DOCS_TARGET } from "@/components/vx/command-items";
import { DOCS_LINK } from "@/components/vx/nav";
import { OPERATIONS } from "@/lib/api/openapi";
import sitemap from "@/app/sitemap";
import { CONTENT_DIR, hasSource, NOTES_LOADERS, PAGE_LOADERS, publishedPages, readSource } from "@/lib/docs/content";
import { slugifyHeadings, splitCodeSpans, stripFences } from "@/lib/docs/headings";
import { DOCS_NAV, flatPages, neighbours, slugOfPathname } from "@/lib/docs/nav";
import { publicOrigin } from "@/lib/public-origin";
import { isPageHref } from "@/lib/docs/paths";
import { ERROR_MEANINGS, referenceSectionIds } from "@/lib/docs/reference";
import { parseApiKey } from "@/lib/platform/api-keys";

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
    expect(DOCS_NAV.map((section) => section.title)).toEqual(["Overview", "Guides", "Get started", "API reference", "Webhooks", "AI integration", "Changelog"]);
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

  it("lists the user guides right after Overview: going live, then the first payment", () => {
    const section = DOCS_NAV.find((candidate) => candidate.title === "Guides")!;
    expect(section.pages.map((page) => [page.slug, page.title])).toEqual([
      ["guides/go-live", "Go live on Arc testnet"],
      ["guides/first-payment", "Your first payment"],
    ]);
  });

  it("lists the MCP server right after the AI integration page", () => {
    const section = DOCS_NAV.find((candidate) => candidate.title === "AI integration")!;
    expect(section.pages.map((page) => [page.slug, page.title])).toEqual([
      ["ai-integration", "AI integration"],
      ["ai-integration/mcp", "MCP server"],
    ]);
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
    expect(neighbours("data-delivery").next?.slug).toBe("guides/go-live");
    expect(neighbours("guides/first-payment").next?.slug).toBe("get-started/quickstart");
    expect(neighbours(pages[pages.length - 1].slug).next).toBeUndefined();
    expect(neighbours("no-such-page")).toEqual({});
  });
});

describe("isPageHref", () => {
  it("is true for a page of this site, and false for a document, another site or an anchor", () => {
    for (const href of ["/docs", "/docs/webhooks", "/docs/api/list-invoices#errors", "/", "/login", "/docs/x?y=1"]) expect(isPageHref(href), href).toBe(true);
    for (const href of ["/docs.md", "/docs/api/list-invoices.md", "/docs/webhooks/verify.md#node", "/llms.txt", "/llms-full.txt", "/api/v1/openapi.json", "/api/v1/status", "https://example.com/docs", "//example.com", "#top", "mailto:a@b.test"]) {
      expect(isPageHref(href), href).toBe(false);
    }
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
  const written = flatPages().filter((page) => !GENERATED_SLUGS.has(page.slug));
  it.each(written.map((page) => [`/docs${page.slug ? `/${page.slug}` : ""}`, page.slug] as const))("%s has its MDX file", (_name, slug) => {
    expect(hasSource(slug), `content/docs/${slug || "index"}.mdx`).toBe(true);
  });

  it("publishes every page in the nav, so none is left out of search, the Markdown views, llms.txt or the sitemap", () => {
    expect(publishedPages().map((page) => page.slug)).toEqual(flatPages().map((page) => page.slug));
  });
});

describe("the Errors page", () => {
  it("lists every error code with its status and the meaning the reference pages use", () => {
    const source = readSource("get-started/errors");
    for (const code of Object.keys(STATUS_FOR) as ApiErrorCode[]) {
      expect(source, code).toContain(`| ${STATUS_FOR[code]} | \`${code}\` | ${ERROR_MEANINGS[code]} |`);
    }
  });
});

describe("the sitemap", () => {
  it("lists the landing page and every published docs page, each as an absolute URL, in nav order", () => {
    const origin = publicOrigin();
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([`${origin}/`, ...publishedPages().map((page) => `${origin}${page.slug ? `/docs/${page.slug}` : "/docs"}`)]);
    for (const url of urls) expect(url).toMatch(/^https?:\/\/[^/]+\//);
    expect(new Set(urls).size).toBe(urls.length);
  });
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

const SRC_DIR = path.join(process.cwd(), "src");
const TSX_FILES = walk(SRC_DIR).filter((file) => file.endsWith(".tsx"));
const relative = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");

/**
 * The docs links a component writes as a literal: `href="/docs…"` or
 * ``href={`/docs…`}`` with nothing interpolated. A link built at run time
 * cannot be checked here, and is left to the page it is built from.
 */
function tsxDocsLinks(source: string): string[] {
  return [...source.matchAll(/\bhref=(?:"(\/docs[^"]*)"|\{\s*`(\/docs[^`]*)`\s*\})/g)]
    .map((match) => match[1] ?? match[2])
    .filter((target) => !target.includes("${"));
}

describe("docs links written in components", () => {
  const found = TSX_FILES.map((file) => [relative(file), tsxDocsLinks(readFileSync(file, "utf8"))] as const).filter(([, links]) => links.length > 0);

  it("are found where the app links into the docs", () => {
    const files = found.map(([file]) => file);
    for (const file of ["src/components/docs/TryIt.tsx", "src/components/ApiKeysPanel.tsx", "src/components/WebhooksPanel.tsx", "src/app/docs/api/[operation]/page.tsx"]) {
      expect(files, file).toContain(file);
    }
  });

  it.each(found)("%s links only to pages and headings that exist", (_file, links) => {
    expect(linkProblems("", links.map((link) => `<a href="${link}">`).join("\n"), sourceOnDisk)).toEqual([]);
  });

  it("include the console's Docs link and the palette's Developer docs", () => {
    expect(linkProblems("", [DOCS_LINK.href, DOCS_TARGET.href].map((link) => `<a href="${link}">`).join("\n"), sourceOnDisk)).toEqual([]);
  });

  it("are read from both forms of literal, and not from a built one", () => {
    expect(tsxDocsLinks('<Link href="/docs/webhooks">a</Link> <a href={`/docs/api#errors`}>b</a> <a href={`/docs/api/${id}`}>c</a> <a href="/login">d</a>')).toEqual([
      "/docs/webhooks",
      "/docs/api#errors",
    ]);
    expect(linkProblems("", '<a href="/docs/nope">', sourceOnDisk)).toEqual(['/docs/nope: no docs page "nope"']);
  });
});

describe("an example API key", () => {
  /** A whole key, not a placeholder such as `vxk_<prefix>_<secret>` or `vxk_...`. */
  const KEY = /vxk_[a-z2-7]{8}_[A-Za-z0-9_-]+/g;
  const EXAMPLE_KEY = "vxk_example2_NotARealKey_ExampleOnly_NotARealKey_Example";

  it("is well-formed, and plainly invented", () => {
    expect(parseApiKey(EXAMPLE_KEY)).toEqual({ prefix: "example2", secret: EXAMPLE_KEY.slice("vxk_example2_".length) });
  });

  it("is the one invented key wherever the docs or the app write a whole key", () => {
    const files = [...walk(CONTENT_DIR), ...walk(SRC_DIR)].filter((file) => /\.(mdx?|tsx?)$/.test(file));
    const keys = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(KEY)].map((match) => `${relative(file)}: ${match[0]}`));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.slice(key.indexOf(": ") + 2), key).toBe(EXAMPLE_KEY);
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
