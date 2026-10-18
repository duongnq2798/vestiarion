// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BillPreview } from "@/components/landing/hero/BillPreview";
import { PrintOnView } from "@/components/landing/hero/PrintOnView";
import { BILL_PRINT_AT, BILL_PRINT_MS, BILL_TICK_AFTER } from "@/components/landing/hero/scenarios";
import { SEEN_MARGIN } from "@/components/ui/Reveal";

/**
 * The hero's sample bill prints itself once, the way the agent works through it (docs/superpowers/specs/
 * 2026-10-08-landing-motion-design.md M4): every line is in the server's HTML and nothing there is hidden, the parts
 * print in the order of the work and are done by 2.5 s, reduced motion keeps the order by fade and colour, and a card
 * the reader cannot see yet waits until it is in view.
 */

const markup = renderToStaticMarkup(<BillPreview />);
const css = readFileSync(path.join(process.cwd(), "src/app/landing-hero.css"), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Each opening tag of the card's HTML, with its classes and its `--d`, if it has one. */
const tags = [...markup.matchAll(/<[a-z]+\b[^>]*>/g)].map(([tag]) => ({
  tag,
  classes: tag.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [],
  delay: Number(tag.match(/style="[^"]*--d:(\d+)ms/)?.[1] ?? Number.NaN),
}));

/** What each part of the print runs, as the stylesheet says: its length and how many times it plays. */
const parts = new Map(
  [...css.matchAll(/\.bill-print \.(bp-[\w-]+)\s*\{\s*animation:\s*([\w-]+)\s+(\d+)ms\s+var\([^)]*\)\s+var\(--d, 0ms\)\s+(both|\d+);/g)].map(
    ([, part, name, ms, times]) => [part, { name, ms: Number(ms), times: times === "both" ? 1 : Number(times) }]
  )
);

describe("the sample bill in the server's HTML", () => {
  it("has every line of both bills, the caption and the link to a real decision", () => {
    const words = text(markup);
    for (const line of [
      "Bills & receivables",
      "Sample bills",
      "Northwind Dev Invoice 0412 · milestone 2 of 3",
      "2,400.00 USDC",
      "Agent proposes: pay it",
      "Waiting for your verdict",
      "Agent's reasoning The checkout flow was delivered and its pull request merged.",
      "Work delivered: pull request merged",
      "Amount matches the milestone",
      "Within the contractor's limit",
      "Not paid before",
      "Do you agree with the agent?",
      "Agree and pay",
      "Disagree",
      "Kestrel Design Invoice 0931 · 6,500.00 USDC",
      "Held for you",
      "Blocked by code, not by the model. It is above the payee's payment limit.",
      "Two sample bills in shadow mode.",
      "See a real decision and its transaction",
    ]) {
      expect(words).toContain(line);
    }
  });

  it("hides nothing: no inline opacity, no hidden attribute or class, no print state", () => {
    for (const { tag, classes } of tags) {
      expect(tag).not.toMatch(/style="[^"]*opacity/);
      expect(tag).not.toMatch(/\shidden(=|\s|>)/);
      for (const name of ["hidden", "invisible", "opacity-0"]) expect(classes).not.toContain(name);
    }
    expect(markup).not.toContain("data-print");
  });

  it("asks for calm motion on the card, and keeps its frame and title out of the print", () => {
    expect(markup).toMatch(/<div data-calm-motion="" class="bill-print [^"]*rounded-2xl[^"]*">/);
    const title = markup.slice(markup.indexOf("bill-print"), markup.indexOf("Sample bills"));
    expect(title).not.toMatch(/bp-|--d:/);
  });

  it("links to the proof under the caption, outside the figure, as a plain link", () => {
    const link = markup.match(/<a [^>]*>See a real decision and its transaction/)?.[0] ?? "";
    expect(link).toContain('href="#proof"');
    expect(link).toContain('data-cta="hero-proof"');
    expect(link).toContain("text-agent");
    expect(markup.indexOf("</figcaption></figure>")).toBeGreaterThan(-1);
    expect(markup.indexOf("</figure>")).toBeLessThan(markup.indexOf("hero-proof"));
  });
});

describe("the sample bill's print", () => {
  it("runs in the order of the work", () => {
    const moments = Object.values(BILL_PRINT_AT).flat();
    expect(moments.every((at, index) => index === 0 || at > moments[index - 1])).toBe(true);
    expect(moments[0]).toBeGreaterThan(0);
  });

  it("knows every part it prints with, from the stylesheet", () => {
    expect([...parts.keys()].sort()).toEqual(["bp-check", "bp-dot", "bp-line", "bp-stamp", "bp-turn"]);
    expect(parts.get("bp-line")?.name).toBe("replay-print");
    expect(parts.get("bp-dot")?.times).toBe(2);
  });

  it("gives every moving part its moment from the table, and has finished them all by 2.5 s", () => {
    const allowed = new Set<number>([...Object.values(BILL_PRINT_AT).flat(), ...BILL_PRINT_AT.checks.map((at) => at + BILL_TICK_AFTER)]);
    const moving = tags.filter(({ classes }) => classes.some((name) => parts.has(name)));
    expect(moving.length).toBeGreaterThanOrEqual(18);
    expect(moving.length).toBeLessThanOrEqual(22);
    let last = 0;
    for (const { tag, classes, delay } of moving) {
      expect(allowed.has(delay), tag).toBe(true);
      const part = parts.get(classes.find((name) => parts.has(name))!)!;
      last = Math.max(last, delay + part.ms * part.times);
    }
    expect(last).toBeLessThanOrEqual(BILL_PRINT_MS);
    expect(BILL_PRINT_MS).toBe(2500);
    // Nothing carries a moment without a part that uses it.
    for (const { tag, classes, delay } of tags) if (!Number.isNaN(delay)) expect(classes.some((name) => parts.has(name)), tag).toBe(true);
  });

  it("ticks each check after its row prints, and turns the shield last", () => {
    const checks = tags.filter(({ classes }) => classes.includes("bp-check")).map(({ delay }) => delay);
    expect(checks).toEqual(BILL_PRINT_AT.checks.map((at) => at + BILL_TICK_AFTER));
    const shield = tags.find(({ classes }) => classes.includes("bp-turn"));
    expect(shield?.tag).toContain("lucide-shield-x");
    expect(shield?.delay).toBe(Math.max(...tags.filter(({ delay }) => !Number.isNaN(delay)).map(({ delay }) => delay)));
  });

  it("stamps without turning, and the breathing dot stops after two breaths", () => {
    const stamp = css.match(/@keyframes bill-stamp\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(stamp).toContain("scale: 1.12");
    expect(stamp).not.toMatch(/rotate|transform/);
    expect(css).not.toMatch(/\.bill-print[^{]*\{[^}]*infinite/);
  });

  it("holds a card that is armed, every part unseen and still, and lets a card jumped past show whole", () => {
    expect(css).toMatch(/\.bill-print:is\(\[data-print="armed"\], \[data-print="done"\]\) :is\([^)]*\)\s*\{\s*animation: none;/);
    expect(css).toMatch(/\.bill-print\[data-print="armed"\] :is\(\.bp-line, \.bp-stamp\)\s*\{\s*opacity: 0;/);
  });

  it("under reduced motion fades each part in where it stands, turns the ticks by colour and keeps the dot still", () => {
    const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(([, body]) => body).join("\n");
    expect(reduce).toMatch(/\.bill-print \.bp-line,\s*\.bill-print \.bp-stamp\s*\{\s*animation-name: replay-fade;/);
    expect(reduce).toMatch(/\.bill-print \.bp-check\s*\{\s*animation-name: bill-turn;/);
    expect(reduce).toMatch(/\.bill-print \.bp-dot\s*\{\s*animation: none;/);
    // What reduced motion plays changes opacity and colour only.
    expect(css.match(/@keyframes replay-fade\s*\{([\s\S]*?)\n\}/)?.[1]).not.toMatch(/translate|scale|clip|rotate/);
    expect(css.match(/@keyframes bill-turn\s*\{([\s\S]*?)\n\}/)?.[1]?.trim()).toBe("from { color: var(--color-ink-3); }");
  });
});

/**
 * In a DOM: a card the reader can see when the page hydrates is left to the CSS; one out of sight is armed and plays
 * once a quarter of it is in view, or shows whole if the reader jumped past it. The browser's observer is stood in for.
 */
describe("PrintOnView", () => {
  type Entry = { intersectionRatio: number; boundingClientRect: { top: number; bottom: number } };
  let observed: { callback: (entries: Entry[]) => void; options?: IntersectionObserverInit } | null = null;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let hidden = false;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  const Observer = globalThis.IntersectionObserver;

  class StandInObserver {
    constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
      observed = { callback, options };
    }
    observe() {}
    disconnect() {
      observed = null;
    }
  }

  /** Mounts a card whose first printed line is `top` px below the viewport's top. */
  function mount(node: ReactElement, top: number): HTMLElement {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.IntersectionObserver = StandInObserver as unknown as typeof IntersectionObserver;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    HTMLElement.prototype.getBoundingClientRect = () => ({ top, bottom: top + 500, left: 0, right: 0, width: 0, height: 500, x: 0, y: top, toJSON: () => ({}) });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(node));
    return container.firstElementChild as HTMLElement;
  }

  const card = (
    <PrintOnView className="bill-print">
      <p>Bills &amp; receivables</p>
      <p className="bp-line">Northwind Dev</p>
    </PrintOnView>
  );

  /** The observer reports the card `ratio` in view, its top `top` px below the viewport's top. */
  const report = (ratio: number, top = 300) =>
    act(() => observed?.callback([{ intersectionRatio: ratio, boundingClientRect: { top, bottom: top + 500 } }]));

  const show = (state: boolean) =>
    act(() => {
      hidden = !state;
      document.dispatchEvent(new Event("visibilitychange"));
    });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    observed = null;
    hidden = false;
    HTMLElement.prototype.getBoundingClientRect = measure;
    globalThis.IntersectionObserver = Observer;
  });

  it("asks for calm motion, and leaves a card on screen to the CSS, which is already printing it", () => {
    const element = mount(card, 200);
    expect(element.dataset.calmMotion).toBe("");
    expect(element.dataset.print).toBeUndefined();
    expect(observed).toBeNull();
  });

  it("arms a card below the viewport, and plays it once a quarter of it is in view", () => {
    const element = mount(card, window.innerHeight + 400);
    expect(element.dataset.print).toBe("armed");
    expect(observed!.options).toEqual({ rootMargin: SEEN_MARGIN, threshold: 0.25 });
    report(0.1);
    expect(element.dataset.print).toBe("armed");
    report(0.3);
    expect(element.dataset.print).toBe("go");
    expect(observed).toBeNull();
  });

  it("shows a card the reader jumped past whole, without playing it out of sight", () => {
    const element = mount(card, window.innerHeight + 400);
    report(1, -3000);
    expect(element.dataset.print).toBe("done");
  });

  it("arms a card in a tab not shown yet, and plays it when the tab is shown with the card in view", () => {
    hidden = true;
    const element = mount(card, 200);
    expect(element.dataset.print).toBe("armed");
    report(1);
    expect(element.dataset.print).toBe("armed");
    show(true);
    expect(element.dataset.print).toBe("go");
  });
});
