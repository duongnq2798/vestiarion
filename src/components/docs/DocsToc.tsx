"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { Heading } from "@/lib/docs/headings";

/** How far below the top of the window a heading counts as the one being read: under the sticky header. */
const READING_LINE = 112;

/**
 * "On this page": the page's `##` and `###` headings. The one being read is
 * highlighted — the last heading above the reading line, looked for again
 * whenever an `IntersectionObserver` sees a heading cross into or out of the
 * band below that line. There is no scroll listener.
 * The links are plain anchors; the page scrolls itself.
 */
export function DocsToc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    const elements = headings.map((heading) => document.getElementById(heading.id)).filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const pick = () => {
      let current = elements[0].id;
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= READING_LINE) current = element.id;
        else break;
      }
      setActive(current);
    };

    // The band starts at the reading line, so a heading crossing it is an intersection change.
    const observer = new IntersectionObserver(pick, { rootMargin: `-${READING_LINE}px 0px -50% 0px` });
    for (const element of elements) observer.observe(element);
    pick();
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">On this page</p>
      <ul className="mt-3 space-y-1 border-l border-line">
        {headings.map((heading) => {
          const current = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l py-1 text-[0.8125rem] leading-snug transition-colors duration-150 ease-standard",
                  heading.depth === 3 ? "pl-6" : "pl-3",
                  current ? "border-agent font-medium text-agent" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink"
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
