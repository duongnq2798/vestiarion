"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Where an element counts as seen: anywhere above the bottom 8% of the viewport, the page above it included. An element
 * the reader jumped past (an anchor, the End key, a fast scroll) was never inside the viewport itself, so a margin that
 * stopped at the viewport's top left it hidden until it was scrolled back to.
 */
export const SEEN_MARGIN = "100000px 0px -8% 0px";

/**
 * Fades and lifts an element into view the first time it scrolls in. Nothing
 * is hidden in the server’s HTML and nothing already on screen when the page
 * hydrates is touched, so a page whose script never runs still shows
 * everything. Under reduced motion it fades in where it stands, without the
 * lift (landing motion M0). The transition is CSS (`[data-reveal]` in
 * globals.css); `delay` staggers siblings, in ms.
 *
 * `sequence` leaves the element itself where it is and brings in its children
 * marked `seq`, one after another in the order they are written, `stagger` ms
 * apart (`[data-seq]`, landing motion M4). Under reduced motion they fade in
 * where they stand, in the same order.
 *
 * Content the reader has already scrolled past when it is first seen is shown
 * at once, as the server drew it: nothing is left to fade in out of sight.
 */
export function Reveal({
  children,
  delay = 0,
  sequence = false,
  stagger,
  className,
}: {
  children: ReactNode;
  delay?: number;
  sequence?: boolean;
  stagger?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;
    const state = sequence ? "seq" : "reveal";
    if (sequence) {
      // Each child's place in the sequence, unless it names its own.
      element.querySelectorAll<HTMLElement>(".seq").forEach((child, index) => {
        if (!child.style.getPropertyValue("--i")) child.style.setProperty("--i", String(index));
      });
    }
    element.dataset[state] = "hidden";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        if (entry.boundingClientRect.bottom <= 0) delete element.dataset[state];
        else element.dataset[state] = "shown";
      },
      { rootMargin: SEEN_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [sequence]);

  const style: Record<string, string> = {};
  if (delay) style["--reveal-delay"] = `${delay}ms`;
  if (stagger !== undefined) style["--stagger"] = `${stagger}ms`;
  return (
    <div ref={ref} className={className} style={Object.keys(style).length > 0 ? (style as CSSProperties) : undefined}>
      {children}
    </div>
  );
}
