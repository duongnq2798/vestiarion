import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "./Brand";
import { Label } from "./Primitives";
import { SiteMenu } from "./SiteMenu";

/**
 * The header and footer of the pages outside a workspace: the landing page,
 * sign-in, the workspace chooser and the not-found pages. Inside a workspace
 * the navigation is `AppFrame`'s.
 */

/** The landing page's own sections, which its header and footer link to. */
export const LANDING_SECTIONS = [
  { href: "#measurements", label: "Measurements" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
] as const;

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex shrink-0 items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink">
      <BrandMark className="logo-shadow size-9 shrink-0 text-agent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
      <span>Vestiarion</span>
    </Link>
  );
}

/** `landing` adds the section links, sign-in and the console call to action; `children` fill the right side otherwise. */
export function SiteHeader({ landing = false, children }: { landing?: boolean; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-surface/88 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Wordmark />
        {landing && (
          <nav aria-label="Site" className="mx-auto hidden md:block">
            <ul className="flex items-center gap-1">
              {LANDING_SECTIONS.map((section) => (
                <li key={section.href}>
                  <a href={section.href} className="rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-raised/70 hover:text-ink">
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={`flex items-center gap-2 ${landing ? "ml-auto md:ml-0" : "ml-auto"}`}>
          {landing ? (
            <>
              <Link href="/login" className="hidden rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-raised/70 hover:text-ink md:inline-flex">
                Sign in
              </Link>
              <Link href="/onboarding" className="brand-shadow hidden h-10 items-center rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 min-[375px]:inline-flex">
                Open console
              </Link>
              <SiteMenu links={LANDING_SECTIONS} />
            </>
          ) : (
            children
          )}
        </div>
      </div>
    </header>
  );
}

/** `compact` is a single line, for pages that are one form or one list. */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  const legal = "© 2026 Vestiarion contributors · MIT License";
  if (compact) {
    return (
      <footer className="border-t border-line/80 px-4 py-6 text-center font-mono text-xs text-ink-3">
        {legal} · Signed decisions on Arc testnet
      </footer>
    );
  }

  const columns = [
    { title: "Product", links: LANDING_SECTIONS },
    {
      title: "Account",
      links: [
        { href: "/login", label: "Sign in" },
        { href: "/onboarding", label: "Open console" },
      ],
    },
  ];

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="col-span-2 lg:col-span-1">
            <Wordmark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-2">
              An autonomous treasury agent. A model proposes, code enforces the boundary, and every decision is signed
              into a chain anyone can verify.
            </p>
          </div>
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <Label>{column.title}</Label>
              <ul className="mt-3 space-y-1">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith("#") ? (
                      <a href={link.href} className="inline-flex py-1.5 text-sm text-ink-2 hover:text-agent">{link.label}</a>
                    ) : (
                      <Link href={link.href} className="inline-flex py-1.5 text-sm text-ink-2 hover:text-agent">{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-line pt-6 font-mono text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>{legal}</p>
          <p>Hash-chained decisions · Ed25519 signed · Arc testnet</p>
        </div>
      </div>
    </footer>
  );
}
