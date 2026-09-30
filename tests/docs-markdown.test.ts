import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { hasSource, publishedPages } from "@/lib/docs/content";
import { splitCodeSpans, stripFences } from "@/lib/docs/headings";
import { llmsFull, llmsIndex, markdownHref, mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { flatPages } from "@/lib/docs/nav";
import { docsMarkdownPath } from "@/lib/docs/paths";
import { GET, generateStaticParams } from "@/app/docs-md/[[...slug]]/route";
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
    // ESM is dropped; a code line that starts with `export`, such as a shell's, is code and stays.
    expect(prose(md!)).not.toMatch(/^\s*(?:import|export)\s/m);
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

describe("the MCP page's Markdown", () => {
  it("writes the tool table as a Markdown table: every tool with its arguments, what it answers and its reference page", () => {
    const md = pageMarkdown("ai-integration/mcp", ORIGIN)!;
    expect(md).toContain("| Tool | What it answers | Reference |");
    for (const tool of MCP_TOOLS) {
      const op = OPERATIONS.find((candidate) => candidate.id === tool.operationId)!;
      expect(md).toContain(`| \`${tool.name}\``);
      // What it answers is the summary; the full description stays on the reference page.
      expect(md).toContain(` | ${op.summary} | [\`GET ${op.path}\`](${ORIGIN}/docs/api/${op.id}) |`);
    }
    expect(md).not.toContain("Replays signatures, body hashes and hash-chain continuity");
    expect(md).toContain("https://www.vestiarion.xyz/api/mcp");
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
    expect(mdxToMarkdown("<Callout tone='held'>\nNo title.\n</Callout>", ORIGIN)).toBe("> No title.\n");
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
    expect(() => mdxToMarkdown("<Widget title=\"x\" />", ORIGIN)).toThrow(/<Widget>/);
    expect(() => mdxToMarkdown("<Callout>unclosed", ORIGIN)).toThrow(/<Callout>/);
  });

  it("drops an import or export only where a block starts: a line that continues a paragraph is prose", () => {
    const source = ["Keys are read-only, and you can", "import them into any HTTP client.", "", "import { A } from \"a\";", "", "Done."].join("\n");
    expect(mdxToMarkdown(source, ORIGIN)).toBe("Keys are read-only, and you can\nimport them into any HTTP client.\n\nDone.\n");
    expect(mdxToMarkdown("export const x = 1;\n\nText.\n", ORIGIN)).toBe("Text.\n");
    expect(mdxToMarkdown("Text,\nexport it.\n", ORIGIN)).toBe("Text,\nexport it.\n");
  });

  it("refuses a bare {expression} in prose, which MDX would evaluate and Markdown would show as braces", () => {
    expect(() => mdxToMarkdown("The limit is {max}.", ORIGIN)).toThrow(/\{…\} expression/);
    expect(() => mdxToMarkdown('<Callout title="T">\nA {value} inside.\n</Callout>', ORIGIN)).toThrow(/\{…\} expression/);
    // Comments, escaped braces, code and attribute values are fine.
    expect(mdxToMarkdown("A {/* note */}comment, an escaped \\{brace\\}, `{code}` and:\n\n```json\n{\"a\": 1}\n```\n", ORIGIN)).toBe(
      "A comment, an escaped \\{brace\\}, `{code}` and:\n\n```json\n{\"a\": 1}\n```\n"
    );
    expect(mdxToMarkdown('<Callout title={"Braces"}>\nText.\n</Callout>', ORIGIN)).toBe("> **Braces** Text.\n");
  });

  it("refuses a Callout where MDX would read it inline, a div inside a p", () => {
    expect(() => mdxToMarkdown("Text <Callout>\ninline\n</Callout>", ORIGIN)).toThrow(/<Callout> is a block/);
    expect(() => mdxToMarkdown("<Callout>\nx\n</Callout> and more.", ORIGIN)).toThrow(/<Callout> is a block/);
    expect(() => mdxToMarkdown("<Callout>\nx</Callout>", ORIGIN)).toThrow(/<Callout> is a block/);
    expect(() => mdxToMarkdown("<Callout> x\n</Callout>", ORIGIN)).toThrow(/<Callout> is a block/);
    expect(() => mdxToMarkdown("Text <EndpointTable /> here.", ORIGIN)).toThrow(/<EndpointTable> is a block/);
  });

  it.each([
    ["a heading", "## Keys"],
    ["a closing code fence", "```bash\nexport X=1\n```"],
    ["a table row", "| a |\n| --- |\n| b |"],
    ["a quote line", "> quoted"],
    ["a list item", "- item"],
    ["a paragraph line", "A paragraph line"],
  ])("takes a Callout with its tags on lines of their own, right after %s, as a block, as MDX does", (_name, before) => {
    expect(mdxToMarkdown(`${before}\n<Callout>\nx\n</Callout>\nAfter.\n`, ORIGIN)).toBe(`${before}\n\n> x\n\nAfter.\n`);
    expect(mdxToMarkdown(`${before}\n<EndpointTable />\n`, ORIGIN)).toContain(`${before}\n\n**`);
  });

  it.each([
    ["the start", ""],
    ["a blank line", "Before.\n\n"],
    ["a heading", "## Keys\n"],
    ["a closing code fence", "```bash\nexport X=1\n```\n"],
  ])("takes a one-line Callout right after %s as a block: MDX unwraps a paragraph that holds only JSX", (_name, before) => {
    expect(mdxToMarkdown(`${before}<Callout>x</Callout>\n\nAfter.\n`, ORIGIN)).toBe(`${before}${before && !before.endsWith("\n\n") ? "\n" : ""}> x\n\nAfter.\n`);
  });

  it.each([
    ["a table row, whose cell it becomes", "| a |\n| --- |\n| b |\n<Callout>x</Callout>\n"],
    ["a quote line, which it continues", "> quoted\n<Callout>x</Callout>\n"],
    ["a list item, which it continues", "- item\n<Callout>x</Callout>\n"],
    ["a paragraph line, which it continues", "Text\n<Callout>x</Callout>\n"],
    ["text on the next line, which joins its paragraph", "<Callout>x</Callout>\nmore text\n"],
  ])("refuses a one-line Callout after %s", (_name, source) => {
    expect(() => mdxToMarkdown(source, ORIGIN)).toThrow(/<Callout> is a block/);
  });

  it("writes a card grid as a list of links, each with its description", () => {
    const source = [
      "<Cards>",
      '  <Card title="Quickstart" href="/docs/get-started/quickstart">',
      "    Your first request.",
      "  </Card>",
      '  <Card title="Spec" href="/api/v1/openapi.json">',
      "    The OpenAPI document.",
      "  </Card>",
      "</Cards>",
    ].join("\n");
    expect(mdxToMarkdown(source, ORIGIN)).toBe(
      "- [Quickstart](https://x.test/docs/get-started/quickstart): Your first request.\n- [Spec](https://x.test/api/v1/openapi.json): The OpenAPI document.\n"
    );
    expect(() => mdxToMarkdown('<Cards>\n<Card title="No link">\nx\n</Card>\n</Cards>', ORIGIN)).toThrow(/<Card> needs a title and an href/);
  });

  it("takes one-line Cards in a grid, whose lines hold only JSX, and refuses a Card outside Cards", () => {
    expect(mdxToMarkdown('<Cards>\n  <Card title="a" href="/docs">One.</Card>\n  <Card title="b" href="/docs/api">Two.</Card>\n</Cards>', ORIGIN)).toBe(
      "- [a](https://x.test/docs): One.\n- [b](https://x.test/docs/api): Two.\n"
    );
    expect(() => mdxToMarkdown('<Card title="a" href="/docs">\nx\n</Card>', ORIGIN)).toThrow(/<Card> belongs inside <Cards>/);
    expect(() => mdxToMarkdown('<Callout>\n<Card title="a" href="/docs">\nx\n</Card>\n</Callout>', ORIGIN)).toThrow(/<Card> belongs inside <Cards>/);
    expect(() => mdxToMarkdown('Text <Card title="a" href="/docs">x</Card>', ORIGIN)).toThrow(/<Card> is a block/);
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

  it("asks search engines not to index any response, a page or a 404: the pages themselves are what gets indexed", async () => {
    const answer = (slug: string[] | undefined) => GET(new Request("https://x.test/docs-md"), { params: Promise.resolve({ slug }) });
    for (const slug of [undefined, ["api", "list-invoices"], ["get-started", "authentication"]]) {
      const response = await answer(slug);
      expect(response.status, String(slug)).toBe(200);
      expect(response.headers.get("x-robots-tag"), String(slug)).toBe("noindex");
    }
    const missing = await answer(["nope"]);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-robots-tag")).toBe("noindex");

    // Next answers a path that is no page before the route runs; the config covers that 404.
    expect(await nextConfig.headers!()).toContainEqual({ source: "/docs-md/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] });
  });

  it("serves the tools directory (the standalone verifier) as a download, not sniffed by the browser", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/tools/:path*",
      headers: [
        { key: "Content-Disposition", value: "attachment" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    });
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
