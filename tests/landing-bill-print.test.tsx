// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillPreview } from "@/components/landing/hero/BillPreview";
import { PrintOnView } from "@/components/landing/hero/PrintOnView";
import { at, BILL_PRINT_AT, BILL_PRINT_MS, BILL_TICK_AFTER } from "@/components/landing/hero/scenarios";

/**
 * The hero's sample bill prints itself once, the way the agent works through it (docs/superpowers/specs/
 * 2026-10-08-landing-motion-design.md M4): every line is in the server's HTML and nothing there is hidden, the parts
 * print in the order of the work and are done by 2.5 s, reduced motion keeps the order by fade and colour, and a line
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

/** What each part of the print runs, as the stylesheet says: its length and how many times it plays (the dot's, by a ring). */
const parts = new Map(
  [
    ...css.matchAll(
      /\.bill-print \.(bp-[\w-]+)(?:::after)?\s*\{[^}]*?\banimation:\s*([\w-]+)\s+(\d+)ms\s+var\([^)]*\)\s+var\(--d, 0ms\)\s+(backwards|\d+);/g
    ),
  ].map(([, part, name, ms, times]) => [part, { name, ms: Number(ms), times: times === "backwards" ? 1 : Number(times) }])
);

/** A keyframes block's body, by name. */
const keyframes = (name: string) => css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";

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
    const stamp = keyframes("bill-stamp");
    expect(stamp).toContain("scale: 1.12");
    expect(stamp).not.toMatch(/rotate|transform/);
    expect(css).not.toMatch(/\.bill-print[^{]*\{[^}]*infinite/);
  });

  it("breathes and turns colour by what the compositor runs: a ring's scale and opacity, and a filter", () => {
    const breath = keyframes("dot-breathe");
    expect([...breath.matchAll(/([\w-]+):/g)].map(([, property]) => property).every((property) => ["opacity", "scale"].includes(property))).toBe(true);
    expect(breath).toContain("scale: 1;");
    expect(keyframes("bill-turn").trim()).toBe("from { filter: grayscale(1); }");
    expect(keyframes("check-draw")).not.toMatch(/\bcolor:/);
  });

  it("lets go of every part once played: each fills backwards only, and its last frame is the part's own style", () => {
    const rules = [...css.matchAll(/\.bill-print[^{]*\{([^}]*)\}/g)].map(([, body]) => body);
    expect(rules.some((body) => /\banimation:/.test(body))).toBe(true);
    for (const body of rules) expect(body).not.toMatch(/\banimation(-fill-mode)?:[^;]*\b(both|forwards)\b/);
    // The tick ends drawn whole (a 24-unit dash covers its 22.6-unit path) and in its own colour, as it rests.
    expect(keyframes("check-draw")).toMatch(/100% \{ stroke-dasharray: 24; stroke-dashoffset: 0; \}/);
    expect(keyframes("bill-stamp")).toMatch(/to \{ opacity: 1; scale: 1; \}/);
  });

  it("prints from the first paint only where the card sits beside the headline, and holds a line not seen yet", () => {
    // Below 1024 px a part moves only once it has been seen; above, the base rules run from the first paint.
    expect(css).toMatch(
      /@media \(width < 64rem\) \{\s*\.bill-print :is\(\.bp-line, \.bp-stamp, \.bp-check, \.bp-turn\):not\(\[data-print="go"\]\),\s*\.bill-print \.bp-dot:not\(\[data-print="go"\]\)::after \{\s*animation: none;/
    );
    expect(css).not.toMatch(/@media \((min-)?width[^)]*\) \{\s*\.bill-print \.bp-/);
    // A line that waits is still and unseen; one the reader jumped past is still and whole.
    expect(css).toMatch(
      /\.bill-print :is\(\.bp-line, \.bp-stamp, \.bp-check, \.bp-turn\):is\(\[data-print="wait"\], \[data-print="done"\]\),\s*\.bill-print \.bp-dot:is\(\[data-print="wait"\], \[data-print="done"\]\)::after \{\s*animation: none;/
    );
    expect(css).toMatch(/\.bill-print :is\(\.bp-line, \.bp-stamp\)\[data-print="wait"\] \{\s*opacity: 0;/);
  });

  it("under reduced motion fades each part in where it stands, turns the ticks by colour and keeps the dot still", () => {
    const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(([, body]) => body).join("\n");
    expect(reduce).toMatch(/\.bill-print \.bp-line,\s*\.bill-print \.bp-stamp\s*\{\s*animation-name: replay-fade;/);
    expect(reduce).toMatch(/\.bill-print \.bp-check\s*\{\s*animation-name: bill-turn;/);
    expect(reduce).toMatch(/\.bill-print \.bp-dot::after\s*\{\s*animation: none;/);
    // What reduced motion plays changes opacity and colour only: a fade, and a turn from grey.
    expect(keyframes("replay-fade")).not.toMatch(/translate|scale|clip|rotate/);
    expect(keyframes("bill-turn").trim()).toBe("from { filter: grayscale(1); }");
  });
});

/**
 * In a DOM: lines the reader can see when the page hydrates are left as they are, marked as printing or whole; each line
 * below the viewport waits, then prints once it is in view, in the order of the work and counted from the first to
 * print; a line jumped past is shown whole. The browser's observer, clock and running animations are stood in for, and
 * each line's place on the page is its `data-top`.
 */
describe("PrintOnView", () => {
  type Entry = { target: Element; isIntersecting: boolean; boundingClientRect: { top: number; bottom: number } };
  let observed: { callback: (entries: Entry[]) => void; options?: IntersectionObserverInit; targets: Set<Element> } | null = null;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let hidden = false;
  let now = 0;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  const animations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
  const Observer = globalThis.IntersectionObserver;

  class StandInObserver {
    targets = new Set<Element>();
    constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
      observed = { callback, options, targets: this.targets };
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      observed = null;
    }
  }

  /** Where the viewport ends, and a place well below it. */
  const fold = () => window.innerHeight;
  const below = () => window.innerHeight + 400;

  /** Mounts a card shaped like the sample bill: its title, then lines at their moments, a tick in each check. */
  function mount(tops: { payee: number; proposal: number; checks: number }): HTMLElement {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.IntersectionObserver = StandInObserver as unknown as typeof IntersectionObserver;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const top = Number(this.dataset.top ?? 0);
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) };
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <PrintOnView className="bill-print">
          <p>Bills &amp; receivables</p>
          <p className="bp-line" style={at(120)} data-top={tops.payee} data-name="payee" />
          <span className="bp-stamp" style={at(380)} data-top={tops.proposal} data-name="proposal" />
          {/* As on the card, the wait sits in the proposal's row, though the agent reaches it after the checks. */}
          <span className="bp-line" style={at(1400)} data-top={tops.proposal} data-name="waiting">
            <span className="bp-dot" style={at(1460)} data-name="dot" />
          </span>
          <ul>
            <li className="bp-line" style={at(820)} data-top={tops.checks} data-name="check 1">
              <span className="bp-check" style={at(960)} data-name="tick 1" />
            </li>
            <li className="bp-line" style={at(960)} data-top={tops.checks + 20} data-name="check 2">
              <span className="bp-check" style={at(1100)} data-name="tick 2" />
            </li>
          </ul>
        </PrintOnView>
      )
    );
    return container.firstElementChild as HTMLElement;
  }

  const part = (card: HTMLElement, name: string) => card.querySelector<HTMLElement>(`[data-name="${name}"]`)!;

  /** Each part's state, with its `--d` once it prints. */
  const states = (card: HTMLElement) =>
    Object.fromEntries(
      [...card.querySelectorAll<HTMLElement>("[data-name]")].map((element) => [
        element.dataset.name,
        element.dataset.print === "go" ? `go ${element.style.getPropertyValue("--d")}` : (element.dataset.print ?? "-"),
      ])
    );

  /** The observer reports these lines seen at `time`: in view, or (`passed`) already above it. */
  const see = (card: HTMLElement, names: string[], time: number, passed = false) =>
    act(() => {
      now = time;
      const top = passed ? -3000 : 300;
      observed?.callback(names.map((name) => ({ target: part(card, name), isIntersecting: true, boundingClientRect: { top, bottom: top + 20 } })));
    });

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
    now = 0;
    vi.restoreAllMocks();
    HTMLElement.prototype.getBoundingClientRect = measure;
    if (animations) Object.defineProperty(HTMLElement.prototype, "getAnimations", animations);
    else delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
    globalThis.IntersectionObserver = Observer;
  });

  it("asks for calm motion, and leaves a card wholly on screen whole, so a window crossing 1024 px prints nothing", () => {
    const card = mount({ payee: 200, proposal: 260, checks: 420 });
    expect(card.dataset.calmMotion).toBe("");
    expect(Object.values(states(card)).every((state) => state === "done")).toBe(true);
    expect(observed).toBeNull();
  });

  it("lets a line on screen that prints from the first paint go on, at its own moment", () => {
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value(this: HTMLElement) {
        return this.dataset.name === "payee" ? [{}] : [];
      },
    });
    const card = mount({ payee: 200, proposal: 260, checks: 420 });
    expect(states(card)).toMatchObject({ payee: "go 120ms", proposal: "done", "check 1": "done" });
  });

  it("holds only the lines below the viewport, and leaves the ones on screen as they are", () => {
    const card = mount({ payee: fold() - 120, proposal: fold() - 60, checks: fold() });
    expect(states(card)).toEqual({
      payee: "done",
      proposal: "done",
      waiting: "done",
      dot: "done",
      "check 1": "wait",
      "tick 1": "wait",
      "check 2": "wait",
      "tick 2": "wait",
    });
    // Seen from its first pixel in the viewport, or above it: a line jumped past counts as seen there, and is shown whole.
    expect(observed!.options).toEqual({ rootMargin: "100000px 0px 0px 0px" });
    expect([...observed!.targets].map((target) => (target as HTMLElement).dataset.name)).toEqual(["check 1", "check 2"]);
  });

  it("prints each held line once it is in view, counted from the first of them to print", () => {
    const card = mount({ payee: fold() - 120, proposal: fold() - 60, checks: below() });
    see(card, ["check 1"], 5000);
    expect(states(card)).toMatchObject({ "check 1": "go 0ms", "tick 1": "go 140ms", "check 2": "wait", "tick 2": "wait" });
    see(card, ["check 2"], 5100);
    expect(states(card)).toMatchObject({ "check 2": "go 40ms", "tick 2": "go 180ms" });
    expect(observed).toBeNull();
  });

  it("never prints a line before one the agent reaches first, even one in view sooner", () => {
    const card = mount({ payee: below(), proposal: below() + 60, checks: below() + 300 });
    expect(Object.values(states(card)).every((state) => state === "wait")).toBe(true);
    see(card, ["payee", "proposal", "waiting"], 1000);
    expect(states(card)).toMatchObject({ payee: "go 0ms", proposal: "go 260ms", waiting: "wait", dot: "wait", "check 1": "wait" });
    see(card, ["check 1", "check 2"], 1100);
    expect(states(card)).toMatchObject({ "check 1": "go 600ms", "check 2": "go 740ms", waiting: "go 1180ms", dot: "go 1240ms" });
  });

  it("prints a line reached after its moment at once, and keeps the spacing of the ones after it", () => {
    const card = mount({ payee: below(), proposal: below() + 60, checks: below() + 300 });
    see(card, ["payee"], 0);
    see(card, ["proposal", "waiting"], 2000);
    expect(states(card)).toMatchObject({ payee: "go 0ms", proposal: "go 0ms", waiting: "wait" });
    see(card, ["check 1", "check 2"], 2000);
    expect(states(card)).toMatchObject({ "check 1": "go 440ms", "tick 1": "go 580ms", "check 2": "go 580ms" });
  });

  it("shows the lines the reader jumped past whole, without printing them out of sight", () => {
    const card = mount({ payee: below(), proposal: below() + 60, checks: below() + 300 });
    see(card, ["payee", "proposal", "waiting", "check 1", "check 2"], 1000, true);
    expect(Object.values(states(card)).every((state) => state === "done")).toBe(true);
    expect(observed).toBeNull();
  });

  it("holds every line in a tab not shown yet, and prints them once it is shown with the card in view", () => {
    hidden = true;
    const card = mount({ payee: 200, proposal: 260, checks: 420 });
    expect(Object.values(states(card)).every((state) => state === "wait")).toBe(true);
    see(card, ["payee", "proposal", "waiting", "check 1", "check 2"], 1000);
    expect(states(card).payee).toBe("wait");
    now = 1500;
    show(true);
    expect(states(card)).toMatchObject({ payee: "go 0ms", proposal: "go 260ms", "check 1": "go 700ms", waiting: "go 1280ms" });
  });
});
