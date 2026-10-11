"use client";

import { ChevronRight, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import type { NavSection } from "@/lib/docs/nav";
import { docsHref, slugOfPathname } from "@/lib/docs/paths";

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

/** One page's link, the current one marked by a bar, weight and tint, not by colour alone. */
function PageLink({ href, title, current, onNavigate }: { href: string; title: string; current: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "relative flex min-h-10 items-center rounded-lg px-3 py-2 text-[0.9375rem] leading-snug transition-colors duration-150 ease-standard lg:min-h-9 lg:py-1.5 lg:text-[0.875rem]",
        current ? "bg-agent-soft font-semibold text-agent" : "text-ink-2 hover:bg-raised/70 hover:text-ink"
      )}
    >
      {current && <span aria-hidden className="absolute inset-y-2 -left-3 w-1 rounded-r-full bg-agent" />}
      {title}
    </Link>
  );
}

const SECTION_LABEL = "font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-ink-2";

/**
 * Every section of the docs and its pages, the current one marked. The
 * sections come from the server (`DOCS_NAV`), which keeps the API operations
 * they are partly built from out of the browser bundle. A long section
 * (`folded`, the API reference and webhooks) is a disclosure, open when it
 * holds the page being read (docs clarity N2).
 */
export function DocsSidebar({ sections, onNavigate, className }: { sections: NavSection[]; onNavigate?: () => void; className?: string }) {
  const active = slugOfPathname(usePathname());
  const id = useId();

  return (
    <nav aria-label="Documentation" className={cn("px-3 py-6", className)}>
      {sections.map((section, index) => {
        const holdsActive = section.pages.some((page) => page.slug === active);
        const list = (
          <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
            {section.pages.map((page) => (
              <li key={page.slug}>
                <PageLink href={docsHref(page.slug)} title={page.title} current={page.slug === active} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        );
        return (
          <div key={section.title} className={index === 0 ? undefined : "mt-7"}>
            {section.folded ? (
              <details open={holdsActive || undefined} className="group/section">
                <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-1.5 hover:bg-raised/70 [&::-webkit-details-marker]:hidden">
                  <span id={`${id}-${index}`} className={SECTION_LABEL}>
                    {section.title}
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-ink-3">
                    {section.pages.length}
                    <ChevronRight aria-hidden className="size-3.5 transition-transform duration-150 ease-standard group-open/section:rotate-90" />
                  </span>
                </summary>
                <div className="mt-1">{list}</div>
              </details>
            ) : (
              <>
                <p id={`${id}-${index}`} className={cn(SECTION_LABEL, "px-3 pb-2")}>
                  {section.title}
                </p>
                {list}
              </>
            )}
          </div>
        );
      })}
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
        <DocsSidebar sections={sections} onNavigate={() => setOpen(false)} className="py-4" />
      </SheetContent>
    </Sheet>
  );
}
