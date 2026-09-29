import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { hasSource, publishedPages } from "@/lib/docs/content";
import { splitCodeSpans, stripFences } from "@/lib/docs/headings";
import { llmsFull, llmsIndex, markdownHref, mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { flatPages } from "@/lib/docs/nav";
import { docsMarkdownPath } from "@/lib/docs/paths";
import { generateStaticParams } from "@/app/docs-md/[[...slug]]/route";
import nextConfig from "../next.config";

/**
 * The Markdown view of every docs page, `/docs/<slug>.md`, and the two
 * documents built from them, `/llms.txt` and `/llms-full.txt`. Pages are the
 * ones that exist: the generated reference pages and every page whose MDX is
 * written, so a page added to `content/docs` is checked here without an edit.
 */

const ORIGIN = "https://x.test";
const PAGES = publishedPages();

/** The Markdown outside fenced blocks and code spans: where a JSX tag would be a leftover, not an example. */
function prose(markdown: string): string {
  return stripFences(markdown)
    .split(/(\n[ \t]*\n)/)
    .map((block) =>
      splitCodeSpans(block)
        .filter((piece) => !piece.code)
        .map((piece) => piece.text)
        .join(" ")
    )
    .join("");
}

describe("pageMarkdown", () => {
  it("covers every generated reference page and every written page, in nav order", () => {
    const slugs = PAGES.map((page) => page.slug);
    expect(slugs).toEqual(flatPages().map((page) => page.slug).filter((slug) => slugs.includes(slug)));
    for (const op of OPERATIONS) expect(slugs).toContain(`api/${op.id}`);
    for (const page of flatPages()) expect(slugs.includes(page.slug), page.slug).toBe(page.slug.startsWith("api/") || hasSource(page.slug));
  });

  it.each(PAGES.map((page) => [page.slug || "(index)", page.slug] as const))("%s renders to Markdown with no JSX left", (_name, slug) => {
    const md = pageMarkdown(slug, ORIGIN);
    expect(md).not.toBeNull();
    expect(prose(md!)).not.toMatch(/<[A-Z][A-Za-z]*[\s/>]/);
    expect(md!).not.toMatch(/^\s*(?:import|export)\s/m);
    expect(md!.startsWith(`# ${PAGES.find((page) => page.slug === slug)!.title}\n`)).toBe(true);
  });

  it("returns null for an unknown page, an unknown operation and a page not written yet", () => {
    expect(pageMarkdown("nope", ORIGIN)).toBeNull();
    expect(pageMarkdown("api/nope", ORIGIN)).toBeNull();
    const unwritten = flatPages().find((page) => !page.slug.startsWith("api") && !hasSource(page.slug));
    if (unwritten) expect(pageMarkdown(unwritten.slug, ORIGIN)).toBeNull();
  });

  it("writes an operation as its request line, parameters, cURL sample, example, fields and errors", () => {
    const md = pageMarkdown("api/list-invoices", ORIGIN)!;
    expect(md).toMatch(/^# List invoices\n\n`GET \/api\/v1\/invoices`\n/);
    expect(md).toContain("## Parameters\n\n| Name | In | Type | Required | Default | Allowed values | Description |");
    expect(md).toMatch(/\| `direction` \| query \| string \| Optional \| — \| `payable`, `receivable` \|/);
    expect(md).toContain("## Code samples\n\n```bash\ncurl \"https://x.test/api/v1/invoices\" \\\n");
    expect(md).toContain("```json\n{");
    expect(md).toContain("- `data` (array of object, required)");
    expect(md).toContain("  - `id` (");
    expect(md).toContain("## Errors\n\n| Status | Code | When |");
    expect(md).toContain("| 400 | `invalid_request` |");
    // Try it is the page's own form; the Markdown has nothing to send it from.
    expect(md).not.toContain("## Try it");
  });

  it("says so when an operation takes no parameters", () => {
    expect(pageMarkdown("api/get-status", ORIGIN)).toContain("## Parameters\n\nNo parameters.\n");
  });

  it("writes the endpoint table as Markdown tables linking each reference page", () => {
    const md = pageMarkdown("api", ORIGIN)!;
    for (const op of OPERATIONS) expect(md).toContain(`| [\`GET ${op.path}\`](${ORIGIN}/docs/api/${op.id}) | ${op.summary} |`);
  });
});

describe("mdxToMarkdown", () => {
  it("drops frontmatter, imports, exports and comments", () => {
    const source = ['---', 'title: X', '---', 'import { A } from "a";', 'export const meta = {', '  x: 1,', '};', '', 'Text {/* hidden */} here.', ''].join("\n");
    expect(mdxToMarkdown(source, ORIGIN)).toBe("Text  here.\n");
  });

  it("turns a Callout into a quote with its title in bold, keeping its Markdown", () => {
    expect(mdxToMarkdown('<Callout title="Heads up">\nKeys are shown **once**.\n\nStore them.\n</Callout>\n', ORIGIN)).toBe(
      "> **Heads up** Keys are shown **once**.\n>\n> Store them.\n"
    );
    expect(mdxToMarkdown("<Callout tone='held'>No title.</Callout>", ORIGIN)).toBe("> No title.\n");
    expect(mdxToMarkdown('<Callout title="List">\n- one\n- two\n</Callout>', ORIGIN)).toBe("> **List**\n>\n> - one\n> - two\n");
  });

  it("keeps a fence inside a Callout inside the quote", () => {
    expect(mdxToMarkdown('<Callout title="T">\n```sh\n<Tag />\n```\n</Callout>', ORIGIN)).toBe("> **T**\n>\n> ```sh\n> <Tag />\n> ```\n");
  });

  it("leaves JSX in code alone and makes root links absolute", () => {
    const source = "Use `<Callout />` and [keys](/docs/get-started/authentication#scope).\n\n```tsx\n<EndpointTable />\n[x](/docs)\n```\n\n[r]: /docs/api\n";
    expect(mdxToMarkdown(source, ORIGIN)).toBe(
      "Use `<Callout />` and [keys](https://x.test/docs/get-started/authentication#scope).\n\n```tsx\n<EndpointTable />\n[x](/docs)\n```\n\n[r]: https://x.test/docs/api\n"
    );
  });

  it("refuses a component it has no conversion for, naming it", () => {
    expect(() => mdxToMarkdown("<Card title=\"x\" />", ORIGIN)).toThrow(/<Card>/);
    expect(() => mdxToMarkdown("<Callout>unclosed", ORIGIN)).toThrow(/<Callout>/);
  });
});

describe("llms.txt and llms-full.txt", () => {
  it("llms.txt lists every page once, by its .md URL, in nav order", () => {
    const index = llmsIndex(ORIGIN);
    expect(index.startsWith("# Vestiarion\n\n> Vestiarion is an autonomous treasury agent")).toBe(true);
    let last = -1;
    for (const page of PAGES) {
      const link = `](${ORIGIN}/docs${page.slug ? `/${page.slug}` : ""}.md)`;
      expect(index.split(link).length - 1, page.slug).toBe(1);
      expect(index.indexOf(link)).toBeGreaterThan(last);
      last = index.indexOf(link);
      expect(index).toContain(`- [${page.title}](${markdownHref(page.slug, ORIGIN)}): ${page.description}`);
    }
    expect(index).toContain(`## Optional\n\n- [OpenAPI document](${ORIGIN}/api/v1/openapi.json)`);
  });

  it("llms.txt links no page that has no Markdown view", () => {
    for (const page of flatPages().filter((candidate) => !PAGES.includes(candidate))) {
      expect(llmsIndex(ORIGIN)).not.toContain(`(${markdownHref(page.slug, ORIGIN)})`);
    }
  });

  it("llms-full.txt carries every page's Markdown, in nav order, separated by rules", () => {
    const full = llmsFull(ORIGIN);
    let last = -1;
    for (const page of PAGES) {
      const at = full.indexOf(`${pageMarkdown(page.slug, ORIGIN)!.trimEnd()}\n`);
      expect(at, page.slug).toBeGreaterThan(last);
      last = at;
      expect(full).toContain(page.title);
    }
    expect(full.startsWith(`# ${PAGES[0].title}\n`)).toBe(true);
    expect(full.split("\n\n---\n\n# ").length).toBe(PAGES.length);
  });
});

describe("the Markdown route and its rewrites", () => {
  it("prerenders one Markdown view per page", () => {
    expect(generateStaticParams()).toEqual(PAGES.map((page) => ({ slug: page.slug ? page.slug.split("/") : [] })));
  });

  it("names each page's .md path", () => {
    expect(docsMarkdownPath("")).toBe("/docs.md");
    expect(docsMarkdownPath("api/list-invoices")).toBe("/docs/api/list-invoices.md");
  });

  it("rewrites /docs.md and /docs/<slug>.md to the route, and no docs page ends in .md", async () => {
    const rewrites = await nextConfig.rewrites!();
    expect(rewrites).toEqual(
      expect.arrayContaining([
        { source: "/docs.md", destination: "/docs-md" },
        { source: "/docs/:path+\\.md", destination: "/docs-md/:path+" },
      ])
    );
    // A page slug with a dot could be taken for a Markdown view; none has one.
    for (const page of flatPages()) expect(page.slug).toMatch(/^[a-z0-9/-]*$/);
  });
});
