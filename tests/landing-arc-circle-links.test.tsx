import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Integrations } from "@/components/landing/Integrations";
import { SiteFooter } from "@/components/vx/SiteChrome";
import { ARC_URL, CIRCLE_URL } from "@/lib/site-links";

/**
 * Arc and Circle are named with a link to their own sites, in the footer and under the landing page's integrations, each
 * in a new tab with no opener; the evidence links stay where they were.
 */
describe("links to Arc and Circle", () => {
  for (const [name, markup] of [
    ["the footer", renderToStaticMarkup(<SiteFooter />)],
    ["the landing page's integrations", renderToStaticMarkup(<Integrations />)],
  ] as const) {
    it(`are in ${name}, opening in a new tab`, () => {
      for (const url of [ARC_URL, CIRCLE_URL]) {
        expect(markup).toMatch(new RegExp(`<a [^>]*href="${url}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
      }
    });
  }

  it("leave the evidence links in the landing page's integrations", () => {
    const markup = renderToStaticMarkup(<Integrations />);
    expect(markup).toContain('href="/open"');
    expect(markup).toContain("See the payments");
  });
});
