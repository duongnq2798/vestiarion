"use client";

import { useEffect, useRef, useState } from "react";

/** A figure as written, split so it can be counted: "144.26" is 144.26 with two decimals, "95%" keeps its "%". */
export interface CountableFigure {
  value: number;
  decimals: number;
  prefix: string;
  suffix: string;
  grouped: boolean;
}

/** The figure in `text`, or null when it is not one number (such as "Not yet" or "—"), which is shown as it is. */
export function countable(text: string): CountableFigure | null {
  const match = /^([^\d-]*)(-?\d[\d,]*)(?:\.(\d+))?([^\d]*)$/.exec(text);
  if (!match) return null;
  const [, prefix, whole, fraction = "", suffix] = match;
  const value = Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`);
  if (!Number.isFinite(value)) return null;
  return { value, decimals: fraction.length, prefix, suffix, grouped: whole.includes(",") };
}

/** The figure `progress` of the way from zero (0 to 1), written as the figure itself is. */
export function figureAt(figure: CountableFigure, progress: number): string {
  const amount = figure.value * Math.min(1, Math.max(0, progress));
  const written = amount.toLocaleString("en-US", {
    minimumFractionDigits: figure.decimals,
    maximumFractionDigits: figure.decimals,
    useGrouping: figure.grouped,
  });
  return `${figure.prefix}${written}${figure.suffix}`;
}

const DURATION_MS = 1100;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Below this a figure fades in instead: counting to 4 is four jumps, which reads as a flicker, not a count. */
export const COUNTS_FROM = 10;

/** Where a figure counts as seen: above the bottom 10% of the viewport, the page above it included, as `Reveal`'s. */
const SEEN_MARGIN = "100000px 0px -10% 0px";

/**
 * A figure that counts up from zero the first time it comes into view (docs/superpowers/specs/2026-10-08-landing-motion-
 * design.md M3, M4). A figure under 10, and every figure under reduced motion, fades in where it stands instead. The
 * server's HTML, a figure already on screen when the page hydrates and a figure that is not a number show the figure as
 * it is, and one the reader jumped past is set at once. A screen reader is only ever given the figure itself.
 *
 * The figure, unseen, holds the width the count runs in, so nothing beside it moves while it counts, and the count
 * starts where the figure starts, in even-width digits, so its own text is never pushed along either.
 */
export function CountUp({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const element = ref.current;
    const figure = countable(value);
    if (!element || !figure) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;
    const fade = Math.abs(figure.value) < COUNTS_FROM || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        cancelAnimationFrame(frame);
        if (entry.boundingClientRect.bottom <= 0) {
          delete element.dataset.fade;
          setShown(value);
          return;
        }
        if (fade) {
          element.dataset.fade = "shown";
          return;
        }
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / DURATION_MS);
          setShown(figureAt(figure, easeOut(progress)));
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { rootMargin: SEEN_MARGIN }
    );
    // Below the fold: unseen, or at zero, until it is seen.
    if (fade) element.dataset.fade = "hidden";
    else frame = requestAnimationFrame(() => setShown(figureAt(figure, 0)));
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);

  return (
    <span ref={ref} className="inline-grid tabular-nums">
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {value}
      </span>
      <span aria-hidden className="col-start-1 row-start-1 text-left">
        {shown}
      </span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
