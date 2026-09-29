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

function colour(name: string): string {
  const value = token(`color-${name}`);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--color-${name} is not a six-digit hex colour`);
  return value;
}

/** WCAG 2 relative luminance of a six-digit hex colour. */
function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function contrast(foreground: string, background: string): number {
  return ratio(colour(foreground), colour(background));
}

/** `top` at `alpha` over `under`, composited the way the browser paints a translucent background. */
function over(top: string, alpha: number, under: string): string {
  const [t, u] = [top, under].map((hex) => Number.parseInt(hex.slice(1), 16));
  const mix = (shift: number) => Math.round(((t >> shift) & 255) * alpha + ((u >> shift) & 255) * (1 - alpha));
  return `#${[16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every text colour stays readable at the small sizes the product uses — captions, eyebrows, badges — on the
 * surfaces it sits on: WCAG AA asks 4.5:1 for text under 18.66px bold or 24px. `ink-3` and the status colours are
 * not used for text on `raised` (the few labels there use `ink-2`; a failed chart track turns `refused-soft`), so
 * those pairs are not listed.
 */
describe("text colour contrast (WCAG AA)", () => {
  it.each([
    ["ink-2", "surface"],
    ["ink-2", "ground"],
    ["ink-2", "raised"],
    ["ink-3", "surface"],
    ["ink-3", "ground"],
    ["ink-3", "agent-soft"],
    ["ink-3", "proof-soft"],
    ["ink-3", "held-soft"],
    ["ink-3", "refused-soft"],
    ["agent", "surface"],
    ["agent", "ground"],
    ["agent", "agent-soft"],
    ["proof", "surface"],
    ["proof", "ground"],
    ["proof", "proof-soft"],
    ["held", "surface"],
    ["held", "ground"],
    ["held", "held-soft"],
    ["refused", "surface"],
    ["refused", "ground"],
    ["refused", "refused-soft"],
    ["on-agent", "agent"],
    ["on-agent", "refused"],
  ])("%s on %s reaches 4.5:1", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Menu, select and command rows tint `raised` over the `surface` panel when highlighted, and the secondary text in
 * them (command shortcut hints) stays `ink-3`, so the tint has to stay light enough for it.
 */
describe("highlighted rows", () => {
  it.each([
    { rows: "menu and select rows", file: "overlay.ts", pattern: /data-\[highlighted\]:bg-raised\/(\d+)/ },
    { rows: "command rows", file: "Command.tsx", pattern: /data-\[selected=true\]:bg-raised\/(\d+)/ },
  ])("ink-3 on highlighted $rows reaches 4.5:1", ({ file, pattern }) => {
    const code = readFileSync(path.join(process.cwd(), "src", "components", "ui", file), "utf8");
    const opacity = pattern.exec(code)?.[1];
    expect(opacity).toBeDefined();
    const tint = over(colour("raised"), Number(opacity) / 100, colour("surface"));
    expect(ratio(colour("ink-3"), tint)).toBeGreaterThanOrEqual(4.5);
  });
});
