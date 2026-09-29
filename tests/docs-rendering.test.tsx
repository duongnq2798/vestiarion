import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useMDXComponents } from "../mdx-components";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { headingComponents } from "@/components/docs/DocsHeading";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { slugifyHeadings } from "@/lib/docs/headings";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

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

  it("links inside the site with next/link and puts a table in a scrolling frame", () => {
    const A = components.a as (props: { href: string; children: ReactNode }) => ReactElement;
    expect(html(<A href="/docs/webhooks">Webhooks</A>)).toContain('href="/docs/webhooks"');
    const Table = components.table as (props: { children: ReactNode }) => ReactElement;
    expect(html(<Table>{null}</Table>)).toMatch(/^<div class="relative w-full overflow-x-auto/);
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
    expect([...markup.matchAll(/<h[23] id="([^"]+)"/g)].map((match) => match[1])).toEqual(["example", "query-limit", "example-2"]);
    expect(markup).toContain('href="#example-2"');
  });
});
