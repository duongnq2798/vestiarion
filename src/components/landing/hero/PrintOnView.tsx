"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { SEEN_MARGIN } from "@/components/ui/Reveal";

/**
 * Holds the sample bill's print (`.bill-print` in landing-hero.css) for a reader who cannot see it yet. The print
 * starts with the page's first paint, in CSS, so it runs before the script and without it, and where the card sits
 * beside the headline that is all it needs. A card still out of sight when the page hydrates (below the viewport, as
 * on a phone, where it sits under the text, or in a tab not shown yet) is armed: every part that prints waits unseen,
 * and it plays once a quarter of the card is in view. One already on screen is left alone, so nothing the reader saw
 * vanishes, and one the reader jumped past is shown at once.
 */
export function PrintOnView({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const first = card.querySelector(".bp-line") ?? card;
    if (first.getBoundingClientRect().top < window.innerHeight && !document.hidden) return;
    card.dataset.print = "armed";
    let ratio = 0;
    const play = () => {
      if (ratio < 0.25 || document.hidden) return;
      card.dataset.print = "go";
      stop();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        ratio = entry.intersectionRatio;
        if (entry.boundingClientRect.bottom > 0) return play();
        card.dataset.print = "done";
        stop();
      },
      { rootMargin: SEEN_MARGIN, threshold: 0.25 }
    );
    const stop = () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", play);
    };
    observer.observe(card);
    document.addEventListener("visibilitychange", play);
    return stop;
  }, []);

  return (
    <div ref={ref} data-calm-motion="" className={className}>
      {children}
    </div>
  );
}
