"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/Sheet";

/** Matches Tailwind's `lg`, where the header shows its links inline. */
const WIDE = "(min-width: 64rem)";

const MENU_LINK = "flex h-12 items-center rounded-lg px-3 text-base font-medium text-ink transition-colors duration-150 ease-standard hover:bg-raised/70";

/**
 * The landing page's links below `lg`: a sheet from the top. It closes on a
 * link, on Escape, on a click outside, and when the window grows wide enough
 * to show the links inline.
 */
export function SiteMenu({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
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
        <Button variant="secondary" size="icon" aria-label="Menu" className="lg:hidden">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="top" title="Menu" hideHeader>
        <nav aria-label="Site" className="mx-auto w-full max-w-6xl px-4 pb-5 pt-14 sm:px-6">
          <ul>
            {links.map((link) => (
              <li key={link.href}>
                <SheetClose asChild>
                  {link.href.startsWith("#") ? (
                    <a href={link.href} className={MENU_LINK}>
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} className={MENU_LINK}>
                      {link.label}
                    </Link>
                  )}
                </SheetClose>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-4">
            <SheetClose asChild>
              <Button asChild variant="secondary">
                <Link href="/login">Sign in</Link>
              </Button>
            </SheetClose>
            <SheetClose asChild>
              <Button asChild>
                <Link href="/onboarding">Open console</Link>
              </Button>
            </SheetClose>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
