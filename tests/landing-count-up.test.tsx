import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountUp, countable, figureAt } from "@/components/landing/CountUp";

/**
 * The open numbers count up the first time they are seen (docs/superpowers/specs/2026-10-08-landing-motion-design.md
 * M3): each figure is counted as it is written, and the server's HTML, and a screen reader, have the figure itself.
 */
describe("countable", () => {
  it("reads a count, an amount, a share and a grouped figure", () => {
    expect(countable("91")).toEqual({ value: 91, decimals: 0, prefix: "", suffix: "", grouped: false });
    expect(countable("144.26")).toEqual({ value: 144.26, decimals: 2, prefix: "", suffix: "", grouped: false });
    expect(countable("95%")).toEqual({ value: 95, decimals: 0, prefix: "", suffix: "%", grouped: false });
    expect(countable("1,204.50")).toEqual({ value: 1204.5, decimals: 2, prefix: "", suffix: "", grouped: true });
  });

  it("leaves words and dashes alone", () => {
    expect(countable("Not yet")).toBeNull();
    expect(countable("—")).toBeNull();
  });
});

describe("figureAt", () => {
  it("writes the figure part of the way up, as the figure is written", () => {
    expect(figureAt(countable("144.26")!, 0)).toBe("0.00");
    expect(figureAt(countable("95%")!, 0.5)).toBe("48%");
    expect(figureAt(countable("1,204.50")!, 1)).toBe("1,204.50");
  });
});

describe("CountUp", () => {
  it("renders the figure itself on the server, and gives it to a screen reader alone", () => {
    const markup = renderToStaticMarkup(<CountUp value="144.26" />);
    expect(markup).toBe('<span><span aria-hidden="true">144.26</span><span class="sr-only">144.26</span></span>');
  });
});
