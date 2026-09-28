import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION, THEME_COLOR } from "@/components/ui/tokens";

/**
 * The few token values TypeScript needs are copies of CSS custom properties.
 * These tests read the stylesheet itself, so a change made to one side and not
 * the other fails here instead of drifting on screen.
 */

const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");

function token(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
}

describe("design tokens shared with TypeScript", () => {
  it("THEME_COLOR is the surface colour", () => {
    expect(token("color-surface")).toBe(THEME_COLOR);
  });

  it.each(Object.entries(MOTION.ease))("the %s easing matches its CSS token", (name, curve) => {
    expect(token(`ease-${name}`)).toBe(`cubic-bezier(${curve.join(", ")})`);
  });

  it.each(["control", "surface", "raised", "overlay", "brand"])("defines the %s elevation", (name) => {
    expect(token(`shadow-${name}`)).toBeDefined();
  });

  it("loads the overlay animation utilities", () => {
    expect(css).toMatch(/@import\s+"tw-animate-css";/);
  });
});
