"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Each part of the sample bill that prints, and the lines that carry them: a tick, the shield and the dot move inside one. */
const PARTS = ".bp-line, .bp-stamp, .bp-check, .bp-turn, .bp-dot";
const LINES = ".bp-line, .bp-stamp";

/**
 * Where a line that waited counts as seen: anywhere above the bottom of the viewport, the page above it included. It is
 * `Reveal`'s margin without the 8 % at the bottom: a line waits only while it is out of sight, since one held in the
 * bottom of the screen would leave a gap in the card the reader can see.
 */
const IN_VIEW = "100000px 0px 0px 0px";

/** Where the card sits under the text and nothing prints from the first paint: landing-hero.css's own breakpoint. */
const UNDER_THE_TEXT = "(width < 64rem)";

/**
 * Prints the sample bill (`.bill-print` in landing-hero.css) where the reader can see it. Where the card sits beside the
 * headline, from 1024 px, the print starts with the page's first paint, in CSS, so it runs before the script and without
 * it; below that the card sits under the text, often below the fold, and nothing prints until this runs. When the page
 * hydrates, every line still below the viewport (every line, in a tab not shown yet) waits unseen, and each prints once
 * it is in view, in the order of the work: a line never prints before one the agent reaches first, and the moments of
 * the lines that waited count from the first of them to print, so the card goes on where the reader is looking rather
 * than below the fold. A line the reader jumped past is shown whole. Lines already on screen are left as they are, so
 * nothing the reader saw vanishes, except the proposal's row: it sits above the checks but comes after them, and under
 * the text it is not there yet at first (`data-late`), so it waits with the lines after the checks.
 */
export function PrintOnView({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const waiting: { part: HTMLElement; line: HTMLElement; at: number }[] = [];
    const underTheText = window.matchMedia?.(UNDER_THE_TEXT).matches ?? false;
    for (const part of card.querySelectorAll<HTMLElement>(PARTS)) {
      const line = part.closest<HTMLElement>(LINES) ?? part;
      // The proposal's row, under the text and not shown yet, waits even on screen: the reader has not seen it, and it
      // must not come before the checks.
      const notYet = underTheText && line.hasAttribute("data-late") && getComputedStyle(line).opacity === "0";
      // A part out of sight waits, with its moment from the server's HTML. One on screen is left as it is, printing
      // beside the headline or whole below it, and says which, so its print does not start again if the window later
      // crosses 1024 px.
      if (notYet || document.hidden || line.getBoundingClientRect().top >= window.innerHeight) {
        waiting.push({ part, line, at: parseFloat(part.style.getPropertyValue("--d")) || 0 });
        part.dataset.print = "wait";
      } else {
        part.dataset.print = part.getAnimations?.({ subtree: true }).length ? "go" : "done";
      }
    }
    if (waiting.length === 0) return;
    // In the order they print.
    waiting.sort((a, b) => a.at - b.at);

    const first = waiting[0].at;
    const seen = new Map<Element, "seen" | "passed">();
    let start: number | null = null;
    const release = () => {
      if (document.hidden) return;
      const now = performance.now();
      while (waiting.length > 0 && seen.has(waiting[0].line)) {
        const { part, line, at } = waiting.shift()!;
        if (seen.get(line) === "passed") {
          part.dataset.print = "done";
          continue;
        }
        // A part reached after its moment prints at once, and the ones after it keep their spacing from it.
        const moment = at - first;
        if (start === null || start + moment < now) start = now - moment;
        part.style.setProperty("--d", `${Math.round(start + moment - now)}ms`);
        part.dataset.print = "go";
      }
      if (waiting.length === 0) stop();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          seen.set(entry.target, entry.boundingClientRect.bottom > 0 ? "seen" : "passed");
          observer.unobserve(entry.target);
        }
        release();
      },
      { rootMargin: IN_VIEW }
    );
    const stop = () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", release);
    };
    for (const line of new Set(waiting.map(({ line }) => line))) observer.observe(line);
    document.addEventListener("visibilitychange", release);
    return stop;
  }, []);

  return (
    <div ref={ref} data-calm-motion="" className={className}>
      {children}
    </div>
  );
}
