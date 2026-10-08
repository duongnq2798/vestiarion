import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreasuryArch } from "@/components/landing/TreasuryArch";

/**
 * The treasury's arch around the hero's receipt (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L5):
 * decoration that no assistive technology reads, shown only where the hero has room for it, around what it frames.
 */
describe("TreasuryArch", () => {
  const markup = renderToStaticMarkup(
    <TreasuryArch>
      <p>The receipt</p>
    </TreasuryArch>
  );

  it("keeps what it frames, outside the drawing", () => {
    expect(markup).toContain("<p>The receipt</p>");
    const drawing = markup.slice(markup.indexOf('aria-hidden="true"'), markup.indexOf("<p>The receipt</p>"));
    expect(drawing).toContain("VESTIARION · THE TREASURY");
  });

  it("is hidden from assistive technology, and drawn only from the xl breakpoint up", () => {
    expect(markup).toMatch(/<div aria-hidden="true" class="[^"]*\bhidden\b[^"]*\bxl:block\b/);
    expect(markup).not.toMatch(/\blg:block\b/);
  });
});
