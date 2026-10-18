// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTS_FROM, CountUp, countable, figureAt } from "@/components/landing/CountUp";

/**
 * The open numbers count up the first time they are seen (docs/superpowers/specs/2026-10-08-landing-motion-design.md
 * M3, M4): each figure is counted as it is written, a figure under 10 fades in instead, and the server's HTML, and a
 * screen reader, have the figure itself.
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
  it("renders the figure itself on the server, holds its width with it, and gives it to a screen reader alone", () => {
    const markup = renderToStaticMarkup(<CountUp value="144.26" />);
    expect(markup).toBe(
      '<span class="inline-grid tabular-nums">' +
        '<span aria-hidden="true" class="invisible col-start-1 row-start-1">144.26</span>' +
        '<span aria-hidden="true" class="col-start-1 row-start-1 text-left">144.26</span>' +
        '<span class="sr-only">144.26</span>' +
        "</span>"
    );
  });

  it("hides nothing in the server's HTML", () => {
    const markup = renderToStaticMarkup(<CountUp value="4" />);
    expect(markup).not.toMatch(/data-fade|opacity/);
    expect(markup).toContain(">4</span>");
  });
});

/**
 * In a DOM, below the fold: a figure from 10 up counts from zero, one under it fades in, and under reduced motion every
 * figure fades in. A figure the reader jumped past is set at once. The observer is stood in for.
 */
describe("CountUp in the browser", () => {
  type Entry = { isIntersecting: boolean; boundingClientRect: { top: number; bottom: number } };
  let observed: ((entries: Entry[]) => void) | null = null;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  const Observer = globalThis.IntersectionObserver;
  const matchMedia = window.matchMedia;

  class StandInObserver {
    constructor(callback: (entries: Entry[]) => void) {
      observed = callback;
    }
    observe() {}
    disconnect() {}
  }

  function mount(value: string, { reduce = false } = {}): HTMLElement {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.IntersectionObserver = StandInObserver as unknown as typeof IntersectionObserver;
    const top = window.innerHeight + 600;
    HTMLElement.prototype.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) });
    window.matchMedia = ((query: string) => ({ matches: reduce && query.includes("reduce"), media: query })) as unknown as typeof window.matchMedia;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<CountUp value={value} />));
    return container.firstElementChild as HTMLElement;
  }

  const seen = (top: number) => act(() => observed!([{ isIntersecting: true, boundingClientRect: { top, bottom: top + 40 } }]));
  const shown = (element: HTMLElement) => element.children[1].textContent;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    observed = null;
    HTMLElement.prototype.getBoundingClientRect = measure;
    globalThis.IntersectionObserver = Observer;
    window.matchMedia = matchMedia;
  });

  it(`fades a figure under ${COUNTS_FROM} in where it stands, never showing another number`, () => {
    const element = mount("4");
    expect(element.dataset.fade).toBe("hidden");
    expect(shown(element)).toBe("4");
    seen(300);
    expect(element.dataset.fade).toBe("shown");
    expect(shown(element)).toBe("4");
  });

  it("fades every figure in under reduced motion, rather than counting", () => {
    const element = mount("1,164", { reduce: true });
    expect(element.dataset.fade).toBe("hidden");
    seen(300);
    expect(element.dataset.fade).toBe("shown");
    expect(shown(element)).toBe("1,164");
  });

  it("does not fade a figure it counts", () => {
    expect(mount("38").dataset.fade).toBeUndefined();
  });

  it("sets a figure the reader jumped past at once, without a fade", () => {
    const element = mount("4");
    seen(-3000);
    expect(element.dataset.fade).toBeUndefined();
    expect(shown(element)).toBe("4");
  });
});
