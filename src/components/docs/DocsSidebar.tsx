"use client";

import { Menu } from "lucide-react";
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

/**
 * Every section of the docs and its pages, the current one marked. The
 * sections come from the server (`DOCS_NAV`), which keeps the API operations
 * they are partly built from out of the browser bundle.
 */
export function DocsSidebar({ sections, onNavigate, className }: { sections: NavSection[]; onNavigate?: () => void; className?: string }) {
  const active = slugOfPathname(usePathname());
  const id = useId();

  return (
    <nav aria-label="Documentation" className={cn("px-3 py-6", className)}>
      {sections.map((section, index) => (
        <div key={section.title} className={index === 0 ? undefined : "mt-6"}>
          <p id={`${id}-${index}`} className="px-3 pb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
            {section.title}
          </p>
          <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
            {section.pages.map((page) => {
              const current = page.slug === active;
              return (
                <li key={page.slug}>
                  <Link
                    href={docsHref(page.slug)}
                    aria-current={current ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "relative flex min-h-10 items-center rounded-lg px-3 py-2 text-sm leading-snug transition-colors duration-150 ease-standard lg:min-h-9 lg:py-1.5",
                      current ? "bg-agent-soft font-semibold text-agent" : "text-ink-2 hover:bg-raised/70 hover:text-ink"
                    )}
                  >
                    {current && <span aria-hidden className="absolute inset-y-2 -left-3 w-1 rounded-r-full bg-agent" />}
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
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
