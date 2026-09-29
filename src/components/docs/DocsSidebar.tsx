"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { DOCS_NAV, docsHref } from "@/lib/docs/nav";

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

/** The docs slug of a pathname: `/docs` is `""`, `/docs/webhooks/verify/` is `webhooks/verify`. */
export function slugOfPathname(pathname: string): string | null {
  const match = /^\/docs(?:\/(.*?))?\/?$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}

/** Every section of the docs and its pages, the current one marked. */
export function DocsSidebar({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const active = slugOfPathname(usePathname());
  const id = useId();

  return (
    <nav aria-label="Documentation" className={cn("px-3 py-6", className)}>
      {DOCS_NAV.map((section, index) => (
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
export function DocsMobileNav() {
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
        <DocsSidebar onNavigate={() => setOpen(false)} className="py-4" />
      </SheetContent>
    </Sheet>
  );
}
