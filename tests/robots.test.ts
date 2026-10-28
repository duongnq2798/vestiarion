import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { requiresSession } from "@/lib/auth/routes";
import { FREE_TOOLS } from "@/lib/free-tools";
import { publicOrigin } from "@/lib/public-origin";

/**
 * /robots.txt (docs/superpowers/specs/2026-10-28-robots-sitemap-design.md): it names the sitemap, so search engines
 * find the public pages without a link to each, and bars no crawler from any page, so a page that asks not to be
 * indexed is still read and its `noindex` seen.
 */
describe("robots.txt", () => {
  const file = robots();
  const rules = Array.isArray(file.rules) ? file.rules : [file.rules];

  it("names the sitemap on the public origin, the origin its pages are listed on", () => {
    expect(file.sitemap).toBe(`${publicOrigin()}/sitemap.xml`);
    expect(sitemap().every((entry) => entry.url.startsWith(`${publicOrigin()}/`))).toBe(true);
  });

  it("lets every crawler read every page, and disallows nothing", () => {
    expect(rules).toEqual([{ userAgent: "*", allow: "/" }]);
    expect(rules.some((rule) => rule.disallow !== undefined)).toBe(false);
  });

  it("is served without a session, like the sitemap it names", () => {
    expect(requiresSession("/robots.txt")).toBe(false);
    expect(requiresSession("/sitemap.xml")).toBe(false);
  });

  it("points at a sitemap that lists every free tool, so a new tool reaches search engines with no link to it", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const tool of FREE_TOOLS) expect(urls).toContain(`${publicOrigin()}${tool.path}`);
  });
});
