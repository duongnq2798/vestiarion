import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { evaluate } from "@mdx-js/mdx";
import type { MDXContent } from "mdx/types";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { useMDXComponents } from "../mdx-components";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { CopyPage } from "@/components/docs/CopyPage";
import { headingComponents } from "@/components/docs/DocsHeading";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { CONTENT_DIR } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/** Compiles MDX the way the build does: the same components provider and the same remark plugins as next.config.ts. */
async function compile(source: string): Promise<MDXContent> {
  const { default: Content } = await evaluate(source, { ...runtime, useMDXComponents, remarkPlugins: [remarkGfm] });
  return Content;
}

/** Renders MDX with the page's heading components; code blocks are left out, since static markup cannot await them. */
async function renderPage(source: string, headings = slugifyHeadings(source)): Promise<string> {
  const Content = await compile(source);
  return html(<Content components={{ ...headingComponents(headings), pre: () => null }} />);
}

const renderedIds = (markup: string) => [...markup.matchAll(/<h[23] id="([^"]+)"/g)].map((match) => match[1]);

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? mdxFiles(full) : full.endsWith(".mdx") ? [full] : [];
  });
}

describe("CodeBlock", () => {
  it("highlights on the server and scrolls a long line inside its own box", async () => {
    const markup = html(await CodeBlock({ code: `const url = "https://www.vestiarion.xyz/api/v1/${"ledger/".repeat(40)}";`, lang: "js" }));
    expect(markup).toMatch(/<div class="overflow-x-auto[^"]*"><pre class="shiki github-dark/);
    expect(markup).toContain("style=\"color:");
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain(">js</span>");
  });

  it("shows a block without a known language as plain text", async () => {
    const none = html(await CodeBlock({ code: "plain words" }));
    expect(none).toContain(">text</span>");
    expect(none).toContain("plain words");
    const unknown = html(await CodeBlock({ code: "x", lang: "not-a-language" }));
    expect(unknown).toContain(">not-a-language</span>");
  });
});

describe("the MDX components", () => {
  const components = useMDXComponents();
  const Pre = components.pre as (props: { children?: ReactNode }) => ReactElement<{ code: string; lang?: string }>;

  it("hands a fenced block's language and source to CodeBlock", () => {
    const block = Pre({ children: <code className="language-bash">{"curl https://x.test\n"}</code> });
    expect(block.type).toBe(CodeBlock);
    expect(block.props).toMatchObject({ code: "curl https://x.test", lang: "bash" });
  });

  it("treats a fence with no language as plain text", () => {
    const block = Pre({ children: <code>{"plain\n"}</code> });
    expect(block.props).toMatchObject({ code: "plain", lang: undefined });
  });

  it("links inside the site with next/link, and elsewhere with a plain anchor", () => {
    const A = components.a as (props: { href: string; children: ReactNode }) => ReactElement<{ href: string }>;
    const internal = A({ href: "/docs/webhooks", children: "Webhooks" });
    expect(internal.type).toBe(Link);
    expect(internal.props.href).toBe("/docs/webhooks");
    expect(A({ href: "https://example.com", children: "x" }).type).toBe("a");
    expect(A({ href: "#top", children: "x" }).type).toBe("a");
  });

  it("links a document (a .md view, llms.txt, the OpenAPI JSON) with a plain anchor, from prose and from a card alike", () => {
    const A = components.a as (props: { href: string; children: ReactNode }) => ReactElement<{ href: string }>;
    const Card = components.Card as (props: { title: string; href: string; children: ReactNode }) => ReactElement<{ children: ReactElement }>;
    for (const href of ["/docs/get-started/quickstart.md", "/docs.md", "/llms.txt", "/llms-full.txt", "/api/v1/openapi.json"]) {
      expect(A({ href, children: "x" }).type, href).toBe("a");
      expect(Card({ title: "x", href, children: "y" }).props.children.type, href).toBe("a");
    }
    for (const href of ["/docs", "/docs/webhooks", "/docs/api/list-invoices#errors"]) {
      expect(A({ href, children: "x" }).type, href).toBe(Link);
      expect(Card({ title: "x", href, children: "y" }).props.children.type, href).toBe(Link);
    }
  });

  it("puts a table in a scrolling frame", () => {
    const Table = components.table as (props: { children: ReactNode }) => ReactElement;
    expect(html(<Table>{null}</Table>)).toMatch(/^<div class="relative w-full overflow-x-auto/);
  });

  it("lets a long unbroken URL wrap in paragraphs, list items and links", () => {
    for (const tag of ["p", "li", "a"] as const) {
      const Component = components[tag] as (props: { href?: string; children: ReactNode }) => ReactElement;
      expect(html(<Component href="https://example.com">x</Component>), tag).toContain("[overflow-wrap:anywhere]");
    }
  });
});

describe("GitHub-flavoured Markdown", () => {
  it("is on for the build, named by string, the form Turbopack accepts", () => {
    expect(readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8")).toMatch(/remarkPlugins:\s*\["remark-gfm"\]/);
  });

  it("compiles a table and renders it through the Table primitive in its scrolling frame", async () => {
    const markup = await renderPage("| Code | Status |\n| --- | --- |\n| `unauthorized` | 401 |\n");
    expect(markup).toMatch(/<div class="relative w-full overflow-x-auto[^"]*"><table class="w-full border-collapse/);
    expect(markup).toContain('<th scope="col"');
    expect(markup).toContain("401</td>");
  });
});

describe("headingComponents", () => {
  it("gives the rendered headings the ids slugifyHeadings computed from the source, repeats included", () => {
    const source = "## Example\n\n### Query `limit`\n\n## Example\n";
    const { h2: H2, h3: H3 } = headingComponents(slugifyHeadings(source));
    const markup = html(
      <>
        <H2>Example</H2>
        <H3>
          Query <code>limit</code>
        </H3>
        <H2>Example</H2>
      </>
    );
    expect(renderedIds(markup)).toEqual(["example", "query-limit", "example-2"]);
  });

  it("keeps the # link out of the heading's accessible name and the tab order", () => {
    const { h2: H2 } = headingComponents(slugifyHeadings("## Example"));
    const markup = html(<H2>Example</H2>);
    expect(markup).toMatch(/<a href="#example" aria-hidden="true" tabindex="-1"/);
    expect(markup).not.toContain("aria-label");
  });

  it("refuses to render a heading the source has no id for, rather than ship a dead anchor", () => {
    const { h2: H2 } = headingComponents(slugifyHeadings("## Example"));
    expect(() => html(<H2>Something else</H2>)).toThrow(/no heading id for ## "Something else"/);
  });
});

describe("compiled MDX renders the ids slugifyHeadings gives", () => {
  const fixture = [
    "## The `<Callout>` component",
    "## Send `Authorization: Bearer <key>`",
    "## Q&amp;A",
    "## Use [the ref][r]",
    "### Caf&eacute; &#35;1 &#x41;",
    '## The <span title="x">GET</span> call',
    "## ***Very*** ~~old~~ new_field_name",
    "## Not \\*emphasis\\*",
    "## Example",
    "```md\n## Not a heading\n```",
    "## Example",
    "[r]: /docs/api",
  ].join("\n\n");

  it("for the tricky headings", async () => {
    const headings = slugifyHeadings(fixture);
    expect(headings.map((heading) => heading.id)).toEqual([
      "the-callout-component",
      "send-authorization-bearer-key",
      "q-a",
      "use-the-ref",
      "caf-1-a",
      "the-get-call",
      "very-old-new-field-name",
      "not-emphasis",
      "example",
      "example-2",
    ]);
    expect(renderedIds(await renderPage(fixture))).toEqual(headings.map((heading) => heading.id));
  });

  it.each(mdxFiles(CONTENT_DIR).map((file) => [path.relative(CONTENT_DIR, file).split(path.sep).join("/"), file] as const))(
    "for content/docs/%s",
    async (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(renderedIds(await renderPage(source))).toEqual(slugifyHeadings(source).map((heading) => heading.id));
    }
  );
});

describe("the overview's card grid", () => {
  it("renders each card as its own grid cell, a link, never a paragraph of inline links", async () => {
    const source = readFileSync(path.join(CONTENT_DIR, "index.mdx"), "utf8");
    const markup = await renderPage(source);
    const open = markup.indexOf('<div class="my-6 grid');
    const grid = markup.slice(markup.indexOf(">", open) + 1, markup.indexOf("<h2", open));
    expect(open).toBeGreaterThan(-1);
    expect(grid.startsWith("<a ")).toBe(true);
    expect(grid).not.toMatch(/<p[^>]*><a /);
    expect(grid.match(/<a [^>]*href="\/docs[^"]*"/g)).toHaveLength(8);
  });
});

describe("CopyPage", () => {
  it("names its button by its visible text, and says what it copies in a title", () => {
    const markup = html(<CopyPage slug="webhooks/verify" markdown="# Verifying signatures" />);
    expect(markup).toMatch(/<button[^>]* title="Copy this page as Markdown"[^>]*>[\s\S]*?Copy page<\/button>/);
    expect(markup).not.toMatch(/<button[^>]* aria-label="Copy/);
    expect(markup).toContain('href="/docs/webhooks/verify.md"');
  });
});
