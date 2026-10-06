import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SITE_COLUMN, SiteHeader } from "@/components/vx/SiteChrome";

/**
 * The header of a page outside a workspace, at the width of what it sits over. On the workspace chooser the page is one
 * narrow column, so its header lines up with that column: the wordmark starts where the column starts and the avatar
 * menu ends where it ends, at every width, rather than at the edges of a wider box the page never fills.
 */

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
/** The classes of the header element and of the box inside it that holds the wordmark and the right side. */
function boxes(markup: string): { header: string; inner: string } {
  const match = /^<header class="([^"]*)"><div class="([^"]*)">/.exec(markup);
  if (!match) throw new Error(`unexpected header markup: ${markup.slice(0, 120)}`);
  return { header: match[1], inner: match[2] };
}
const classes = (value: string) => value.split(/\s+/);

describe("SiteHeader's width", () => {
  it("keeps the page width by default, with its own gutter", () => {
    const { header, inner } = boxes(renderToStaticMarkup(<SiteHeader />));
    expect(classes(inner)).toEqual(expect.arrayContaining(["mx-auto", "max-w-6xl", "px-4", "sm:px-6"]));
    expect(classes(header)).not.toContain("px-4");
  });

  it("is wider for the docs", () => {
    expect(classes(boxes(renderToStaticMarkup(<SiteHeader width="wide" />)).inner)).toContain("max-w-[88rem]");
    expect(source("src/components/docs/DocsShell.tsx")).toContain('<SiteHeader section={{ href: "/docs", label: "Docs" }} width="wide">');
  });

  it("lines up with a one-column page: the column's width inside the page's own gutter", () => {
    const { header, inner } = boxes(renderToStaticMarkup(<SiteHeader width="column" />));
    // The gutter sits outside the column, as the page's <main className="px-4"> does, so both edges meet the column's.
    expect(classes(header)).toContain("px-4");
    expect(classes(inner)).toEqual(expect.arrayContaining(["mx-auto", "w-full", SITE_COLUMN]));
    expect(classes(inner).filter((name) => /^(sm:)?px-/.test(name))).toEqual([]);
  });

  it("is what the workspace chooser uses, over a column of the same width", () => {
    const page = source("src/app/onboarding/page.tsx");
    expect(page).toContain('<SiteHeader width="column">');
    expect(page).toContain('<main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">');
    expect(page).toContain('<div className={cn("w-full", SITE_COLUMN)}>');
  });
});
