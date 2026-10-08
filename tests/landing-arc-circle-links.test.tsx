import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { SiteFooter } from "@/components/vx/SiteChrome";
import { ARC_URL, CIRCLE_URL } from "@/lib/site-links";

/**
 * Arc and Circle are named with a link to their own sites, in the footer and in "Built on, and works with", each in a
 * new tab with no opener; the evidence links stay where they were.
 */
describe("links to Arc and Circle", () => {
  for (const [name, markup] of [
    ["the footer", renderToStaticMarkup(<SiteFooter />)],
    ["Built on, and works with", renderToStaticMarkup(<BuiltWith />)],
  ] as const) {
    it(`are in ${name}, opening in a new tab`, () => {
      for (const url of [ARC_URL, CIRCLE_URL]) {
        expect(markup).toMatch(new RegExp(`<a [^>]*href="${url}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
      }
    });
  }

  it("leave the evidence links in Built on, and works with", () => {
    const markup = renderToStaticMarkup(<BuiltWith />);
    expect(markup).toContain('href="/open"');
    expect(markup).toContain("See the payments");
  });
});
