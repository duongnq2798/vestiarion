import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reduced motion removes movement, not every change (docs/superpowers/specs/2026-10-08-landing-motion-design.md M0):
 * under `prefers-reduced-motion: reduce`, transitions keep their duration for opacity and colours only, and keyframe
 * animations stay cut except on an element marked `data-calm-motion`.
 */

const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

/** Every top-level `@media (prefers-reduced-motion: reduce)` block's body. */
function reduceBlocks(source: string): string[] {
  const blocks: string[] = [];
  const marker = "@media (prefers-reduced-motion: reduce)";
  let from = source.indexOf(marker);
  while (from !== -1) {
    const open = source.indexOf("{", from);
    let depth = 0;
    let index = open;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) break;
    }
    blocks.push(source.slice(open + 1, index));
    from = source.indexOf(marker, index);
  }
  return blocks;
}

describe("the reduced motion rule", () => {
  const block = reduceBlocks(css).join("\n");

  it("keeps transitions for opacity and colours, and only those", () => {
    const property = block.match(/transition-property:\s*([^;!]+)/)?.[1];
    expect(property?.split(",").map((name) => name.trim())).toEqual([
      "opacity",
      "color",
      "background-color",
      "border-color",
      "outline-color",
      "fill",
      "stroke",
      "box-shadow",
    ]);
    expect(block).not.toMatch(/transition-duration/);
  });

  it("cuts keyframe animations, except where an element asks for calm motion", () => {
    expect(block).toMatch(/:not\(\[data-calm-motion\]\)[^{]*\{[^}]*animation-duration:\s*0\.01ms/);
  });

  it("still stops smooth scrolling", () => {
    expect(block).toMatch(/scroll-behavior:\s*auto !important/);
  });
});
