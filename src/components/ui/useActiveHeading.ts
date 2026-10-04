"use client";

import { useEffect, useState } from "react";

/**
 * Which of the headings named by `ids` is being read: the last one above the reading line, `readingLine` pixels below
 * the top of the window. Before any heading has passed the line, the first one counts. Once the page is scrolled to its
 * end, where a short last section can never reach the line, it is the heading the URL names if the window shows it,
 * and otherwise the last heading.
 *
 * It is looked for again on every scroll, a jump included. An `IntersectionObserver` on a band below the line misses a
 * jump that lands a heading above the line (a link to it, or a fragment in the URL), since nothing crosses the band.
 */
export function useActiveHeading(ids: readonly string[], readingLine: number): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  // A string, so a caller handing a fresh array with the same ids does not look everything up again.
  const key = ids.join(" ");

  useEffect(() => {
    const elements = key
      .split(" ")
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const pick = () => {
      const root = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) {
        // At the end, a heading the URL names and the window shows is the one someone went to: a link to a section
        // near the end lands here too, short of the line. Otherwise the last heading.
        const named = elements.find((element) => element.id === decodeURIComponent(window.location.hash.slice(1)));
        const top = named?.getBoundingClientRect().top;
        setActive(named && top !== undefined && top >= 0 && top < window.innerHeight ? named.id : elements[elements.length - 1].id);
        return;
      }
      let current = elements[0].id;
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= readingLine) current = element.id;
        else break;
      }
      setActive(current);
    };

    pick();
    // A link followed at the end of the page may change the fragment without scrolling.
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);
    window.addEventListener("hashchange", pick);
    return () => {
      window.removeEventListener("scroll", pick);
      window.removeEventListener("resize", pick);
      window.removeEventListener("hashchange", pick);
    };
  }, [key, readingLine]);

  return active;
}
