import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { Integrations } from "@/components/landing/Integrations";
import { Proof } from "@/components/landing/Proof";
import { Safety } from "@/components/landing/Safety";
import { Steps } from "@/components/landing/Steps";
import { UseCases } from "@/components/landing/UseCases";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/**
 * Reduced motion removes movement, not every change (docs/superpowers/specs/2026-10-08-landing-motion-design.md M0):
 * under `prefers-reduced-motion: reduce`, transitions keep their duration for opacity and colours only, and keyframe
 * animations stay cut except on an element marked `data-calm-motion`. And the landing's budget (M4): nothing on / moves
 * forever at rest, and an animation driven by scrolling runs only where the reader has not asked for less motion.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const css = read("src/app/globals.css");

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

  it("cuts keyframe animations, except in an element that asks for calm motion and everything inside it", () => {
    expect(block).toMatch(/:not\(\[data-calm-motion\], \[data-calm-motion\] \*\)[^{]*\{[^}]*animation-duration:\s*0\.01ms/);
  });

  it("still stops smooth scrolling", () => {
    expect(block).toMatch(/scroll-behavior:\s*auto !important/);
  });

  it("lets a revealed block and each item of a revealed sequence fade in where they stand", () => {
    expect(block).toMatch(/\[data-reveal="hidden"\][^{]*\{[^}]*translate:\s*none/);
    expect(block).toMatch(/\[data-seq="hidden"\] \.seq\s*\{[^}]*translate:\s*none/);
  });
});

/** A block of a stylesheet: the preludes it sits in, outermost first and its own last, and its own declarations. */
interface Block {
  path: string[];
  body: string;
}

/** Every block of `source`, comments dropped. */
function blocks(source: string): Block[] {
  const found: Block[] = [];
  const open: { prelude: string; body: string }[] = [{ prelude: "", body: "" }];
  let text = "";
  for (const char of source.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      open.push({ prelude: text.trim(), body: "" });
      text = "";
    } else if (char === "}") {
      const block = open.pop()!;
      found.push({ path: [...open.slice(1).map((outer) => outer.prelude), block.prelude], body: block.body + text });
      text = "";
    } else if (char === ";") {
      open.at(-1)!.body += `${text};`;
      text = "";
    } else {
      text += char;
    }
  }
  return found;
}

describe("what Reveal and CountUp hide when the page hydrates", () => {
  it("is hidden at once, and only its arrival is animated, so a sequence reached early still arrives in order", () => {
    const moving = blocks(css).filter((block) => /data-(reveal|seq|fade)/.test(block.path.at(-1)!) && /\btransition\s*:/.test(block.body));
    expect(moving.map((block) => block.path.at(-1))).toEqual(['[data-reveal="shown"]', '[data-seq="shown"] .seq', '[data-fade="shown"]']);
  });
});

/** The classes whose animation repeats forever: theme `--animate-*` and repeat values, utilities and plain rules. */
function infiniteClasses(source: string): string[] {
  const all = blocks(source);
  const forever = new Set<string>();
  for (const block of all) {
    for (const [, name] of block.body.matchAll(/--animate-([\w-]+):[^;]*\binfinite\b/g)) forever.add(`animate-${name}`);
    for (const [, name] of block.body.matchAll(/--animation-repeat-([\w-]+):\s*infinite\b/g)) forever.add(`repeat-${name}`);
  }
  const repeats = (body: string) =>
    /\banimation(-iteration-count)?\s*:[^;]*\binfinite\b/.test(body) ||
    [...body.matchAll(/var\(--animate-([\w-]+)\)/g)].some(([, name]) => forever.has(`animate-${name}`));
  for (const block of all) {
    if (!repeats(block.body)) continue;
    const prelude = block.path.at(-1)!;
    const utility = /^@utility\s+([\w-]+)/.exec(prelude);
    if (utility) forever.add(utility[1]);
    else if (!prelude.startsWith("@")) {
      for (const selector of prelude.split(",")) {
        const animated = selector.trim().split(/[\s>+~]+/).at(-1) ?? "";
        for (const [, name] of animated.matchAll(/\.([\w-]+)/g)) forever.add(name);
      }
    }
  }
  return [...forever].sort();
}

/** The landing's sections, each as / renders it before any read arrives. */
const SECTIONS: Record<string, () => ReactElement> = {
  SiteHeader: () => createElement(SiteHeader, { landing: true }),
  Hero: () => createElement(Hero),
  Steps: () => createElement(Steps),
  UseCases: () => createElement(UseCases),
  Safety: () => createElement(Safety),
  Proof: () => createElement(Proof, { numbers: new Promise<never>(() => {}), facts: new Promise<never>(() => {}) }),
  Integrations: () => createElement(Integrations),
  BuildOnIt: () => createElement(TooltipProvider, null, createElement(BuildOnIt)),
  Faq: () => createElement(Faq, { mainnetForEveryone: true }),
  FinalCta: () => createElement(FinalCta),
  SiteFooter: () => createElement(SiteFooter),
};

/** A class as written, without its variants (`motion-safe:animate-drift` is `animate-drift`). */
const utilityOf = (token: string) => token.replace(/^!/, "").split(":").at(-1)!;

const STYLESHEETS = [
  "src/app/globals.css",
  "src/app/landing-hero.css",
  "node_modules/tailwindcss/theme.css",
  "node_modules/tw-animate-css/dist/tw-animate.css",
];

/** The one exception: a loading placeholder's shimmer, which shows only until its figures arrive. */
const LOADING = new Set(["skeleton", "animate-shimmer"]);

describe("the landing's motion budget", () => {
  const forever = new Set(STYLESHEETS.flatMap((file) => infiniteClasses(read(file))));

  it("renders every section the page does", () => {
    const page = read("src/app/page.tsx");
    const drawn = page.slice(page.indexOf("export default function LandingPage"));
    const onPage = new Set([...drawn.matchAll(/<([A-Z]\w+)[\s/>]/g)].map(([, name]) => name));
    expect([...onPage].sort()).toEqual(Object.keys(SECTIONS).sort());
  });

  it("knows the animations that repeat forever", () => {
    for (const name of ["animate-spin", "animate-pulse", "animate-drift", "animate-shimmer", "skeleton", "chain-flow", "pl-pulse"]) {
      expect(forever).toContain(name);
    }
  });

  it.each(Object.keys(SECTIONS))("%s moves nothing forever at rest, a loading placeholder's shimmer aside", (name) => {
    const markup = renderToStaticMarkup(SECTIONS[name]());
    const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/).filter(Boolean).map(utilityOf));
    expect(classes.filter((token) => forever.has(token) && !LOADING.has(token))).toEqual([]);
    expect(markup).not.toMatch(/style="[^"]*infinite/);
  });
});

/** Each class in `code` that sets a scroll-driven animation, taken whole, without the quotes or call around it. */
const timelineClasses = (code: string) => [...code.matchAll(/[^\s"'`{}()]*animation-timeline[^\s"'`{}()]*/g)].map(([token]) => token);

/** A class is gated when one of its variants is motion-safe (`motion-safe:[animation-timeline:view()]`). */
const gated = (token: string) => /^(?:[\w-]+:)*motion-safe:/.test(token);

describe("animations driven by scrolling", () => {
  const sheets = readdirSync(path.join(process.cwd(), "src/app")).filter((file) => file.endsWith(".css"));

  it("sit only inside prefers-reduced-motion: no-preference", () => {
    for (const sheet of sheets) {
      for (const block of blocks(read(`src/app/${sheet}`))) {
        if (!/\banimation-timeline\s*:/.test(block.body)) continue;
        expect(block.path.some((prelude) => /prefers-reduced-motion:\s*no-preference/.test(prelude)), `${sheet}: ${block.path.join(" > ")}`).toBe(true);
      }
    }
  });

  it("are never set from a component, except behind motion-safe", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const at = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(at);
        else if (/\.tsx?$/.test(entry.name)) files.push(at);
      }
    };
    walk("src");
    for (const file of files) {
      const code = read(file);
      expect(code, file).not.toMatch(/animationTimeline/);
      for (const token of timelineClasses(code)) expect(gated(token), `${file}: ${token}`).toBe(true);
    }
  });
});

describe("the stylesheet reader itself", () => {
  it("takes a component's scroll-driven class whole, first, last or alone in its list, and knows one left ungated", () => {
    const samples = [
      'className="motion-safe:[animation-timeline:view()] mt-2"',
      'className={cn("motion-safe:[animation-timeline:view()]")}',
      'className="mt-2 md:motion-safe:[animation-timeline:view()]"',
      "className={`motion-safe:[animation-timeline:view()] ${tone}`}",
    ];
    for (const sample of samples) expect(timelineClasses(sample).map(gated), sample).toEqual([true]);
    expect(timelineClasses('className="mt-2 [animation-timeline:view()]"').map(gated)).toEqual([false]);
    expect(timelineClasses('style="animation-timeline: view()"').map(gated)).toEqual([false]);
  });

  it("finds a scroll-driven animation outside the no-preference block, and the one inside it", () => {
    const sample = "@media (prefers-reduced-motion: no-preference) { .a { animation-timeline: view(); } } .b { animation-timeline: view() }";
    const found = blocks(sample).filter((block) => /animation-timeline/.test(block.body));
    expect(found.map((block) => block.path)).toEqual([["@media (prefers-reduced-motion: no-preference)", ".a"], [".b"]]);
  });

  it("names a utility, a theme animation and a plain rule that repeat forever, and leaves one that ends alone", () => {
    const sample = [
      "@theme { --animate-glow: glow 2s infinite; --animate-once: once 1s both; }",
      "@utility shine { animation: var(--animate-glow); }",
      ".list .row[data-on] .dot { animation: dot 1s linear infinite; }",
      ".card { animation: var(--animate-once); }",
    ].join("\n");
    expect(infiniteClasses(sample)).toEqual(["animate-glow", "dot", "shine"]);
  });
});
