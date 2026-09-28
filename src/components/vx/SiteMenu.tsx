"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { CloseGlyph, MenuGlyph } from "./Glyphs";

/** Matches Tailwind's `md`, where the header shows its links inline. */
const WIDE = "(min-width: 48rem)";

/**
 * The landing page's links below `md`: a panel that opens under the header.
 * It closes on a link, on Escape, on a click outside, and when the window
 * grows wide enough to show the links inline.
 */
export function SiteMenu({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    const wide = window.matchMedia(WIDE);
    function onWide() {
      if (wide.matches) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={root} className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="grid size-10 place-items-center rounded-xl border border-line bg-surface/80 text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        {open ? <CloseGlyph /> : <MenuGlyph />}
        <span className="sr-only">{open ? "Close menu" : "Menu"}</span>
      </button>
      <div id={panelId} hidden={!open} className="absolute inset-x-0 top-full border-b border-line bg-surface shadow-[0_18px_40px_rgb(43_54_47/0.12)] motion-safe:animate-arrive">
        <nav aria-label="Site" className="mx-auto max-w-6xl px-4 pb-4 pt-2 sm:px-6">
          <ul>
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={close} className="flex h-12 items-center rounded-lg px-3 text-base font-medium text-ink hover:bg-raised/70">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line pt-4">
            <Link href="/login" onClick={close} className="grid h-11 place-items-center rounded-xl border border-line-strong text-sm font-semibold text-ink hover:border-agent-line hover:text-agent">
              Sign in
            </Link>
            <Link href="/onboarding" onClick={close} className="brand-shadow grid h-11 place-items-center rounded-xl bg-agent text-sm font-semibold text-on-agent">
              Open console
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
