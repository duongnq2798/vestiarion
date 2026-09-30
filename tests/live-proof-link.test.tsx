import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveProof } from "@/components/landing/LiveProof";

/**
 * The landing's live figures are the founding workspace's alone, by design;
 * the section says so and points to /open for every workspace's
 * (docs/superpowers/specs/2026-09-30-open-numbers-design.md §4).
 */
describe("the landing's live figures", () => {
  it("name their scope and link to the open numbers", () => {
    const markup = renderToStaticMarkup(<LiveProof metrics={new Promise(() => {})} />);
    expect(markup).toMatch(/<a[^>]*href="\/open"[^>]*>[^<]*Open numbers/);
    expect(markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")).toContain("These figures are the founding workspace's own.");
  });
});
