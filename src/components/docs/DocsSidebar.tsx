"use client";

import { ChevronRight, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import type { NavPage, NavSection } from "@/lib/docs/nav";
import { docsHref, slugOfPathname } from "@/lib/docs/paths";

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

/**
 * One page's link, on the section's guide line: the current one marked by an agent-blue bar over the line, its weight
 * and its colour, not by colour alone.
 */
function PageLink({ page, current, onNavigate }: { page: NavPage; current: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={docsHref(page.slug)}
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "-ml-px flex min-h-10 items-center border-l-2 py-1.5 pl-4 pr-2 text-[0.9375rem] leading-snug transition-colors duration-150 ease-standard lg:min-h-8 lg:text-[0.875rem]",
        current ? "border-agent font-semibold text-agent" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink"
      )}
    >
      {page.title}
    </Link>
  );
}

/** A section's pages on its guide line, a small heading above each run of a `group`. */
function SectionPages({ pages, active, onNavigate }: { pages: NavPage[]; active: string | null; onNavigate?: () => void }) {
  return (
    <ul className="ml-3 mt-1 border-l border-line pb-1">
      {pages.map((page, index) => {
        const opensGroup = page.group !== undefined && page.group !== pages[index - 1]?.group;
        return (
          <li key={page.slug}>
            {opensGroup && (
              <p aria-hidden className={cn("pb-1 pl-4 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ink-3", index === 0 ? "pt-1.5" : "pt-3.5")}>
                {page.group}
              </p>
            )}
            <PageLink page={page} current={page.slug === active} onNavigate={onNavigate} />
          </li>
        );
      })}
    </ul>
  );
}

/** The sections open when a page is read: the one that holds it, or the first when none does. */
function opening(sections: NavSection[], active: string | null): Set<string> {
  const holding = sections.find((section) => section.pages.some((page) => page.slug === active));
  return new Set([(holding ?? sections[0]).title]);
}

/**
 * Every section of the docs, each a disclosure (docs redesign D3): the one holding the page being read is open, so the
 * sidebar shows one section's pages at a time and the others as headings with their page count. A section opened by
 * hand stays open while pages change, since the sidebar lives in the docs layout; moving to a page in a closed section
 * opens it. The sections come from the server (`DOCS_NAV`), which keeps the API operations they are partly built from
 * out of the browser bundle. A one-page section (the changelog) is a link of its own. Each section is a `<details>`, so
 * it opens and closes before any script runs.
 */
export function DocsSidebar({ sections, onNavigate, className }: { sections: NavSection[]; onNavigate?: () => void; className?: string }) {
  const active = slugOfPathname(usePathname());
  const [open, setOpen] = useState(() => opening(sections, active));
  const nav = useRef<HTMLElement>(null);

  // A page in a closed section opens it; the sections opened by hand stay as they are.
  const [shownFor, setShownFor] = useState(active);
  if (shownFor !== active) {
    setShownFor(active);
    const holding = sections.find((section) => section.pages.some((page) => page.slug === active));
    if (holding && !open.has(holding.title)) setOpen(new Set([...open, holding.title]));
  }

  // The current page in view inside the sidebar's own scroll (the aside, or the drawer's body): a deep page is not left
  // below the fold.
  useEffect(() => {
    const current = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    let scroller = nav.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!current || !scroller) return;
    const box = current.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    if (box.top < frame.top || box.bottom > frame.bottom) current.scrollIntoView({ block: "center" });
  }, [active]);

  function toggle(title: string, isOpen: boolean) {
    setOpen((current) => {
      if (current.has(title) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(title);
      else next.delete(title);
      return next;
    });
  }

  return (
    <nav ref={nav} aria-label="Documentation" className={cn("px-3 py-5", className)}>
      <ul className="space-y-1">
        {sections.map((section) => {
          if (section.pages.length === 1) {
            const page = section.pages[0];
            const current = page.slug === active;
            return (
              <li key={section.title}>
                <Link
                  href={docsHref(page.slug)}
                  aria-current={current ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex min-h-10 items-center rounded-lg px-3 text-[0.9375rem] font-semibold transition-colors duration-150 ease-standard lg:min-h-9 lg:text-[0.875rem]",
                    current ? "bg-agent-soft text-agent" : "text-ink-2 hover:bg-raised/60 hover:text-ink"
                  )}
                >
                  {section.title}
                </Link>
              </li>
            );
          }
          const holdsActive = section.pages.some((page) => page.slug === active);
          return (
            <li key={section.title}>
              <details open={open.has(section.title)} onToggle={(event) => toggle(section.title, event.currentTarget.open)} className="group/section">
                <summary
                  className={cn(
                    "flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-[0.9375rem] font-semibold transition-colors duration-150 ease-standard hover:bg-raised/60 lg:min-h-9 lg:text-[0.875rem] [&::-webkit-details-marker]:hidden",
                    holdsActive ? "text-ink" : "text-ink-2 hover:text-ink"
                  )}
                >
                  <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-standard group-open/section:rotate-90 motion-reduce:transition-none"
                  />
                  <span className="min-w-0 flex-1">{section.title}</span>
                  <span className="font-mono text-[0.6875rem] font-normal text-ink-3 tabular-nums">
                    {section.pages.length}
                    <span className="sr-only"> pages</span>
                  </span>
                </summary>
                <SectionPages pages={section.pages} active={active} onNavigate={onNavigate} />
              </details>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same sidebar below `lg`: a sheet from the left, opened from the header.
 * It closes on a link, on Escape, on a click outside, and when the window
 * grows wide enough to show the sidebar.
 */
export function DocsMobileNav({ sections }: { sections: NavSection[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const closeWhenWide = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", closeWhenWide);
    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Documentation menu" className="lg:hidden">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" title="Documentation">
        <DocsSidebar sections={sections} onNavigate={() => setOpen(false)} className="py-3" />
      </SheetContent>
    </Sheet>
  );
}
