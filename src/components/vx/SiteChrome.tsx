import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { GITHUB_URL, ISSUES_URL, LICENSE_URL, PRODUCT_HUNT_URL, X_URL } from "@/lib/site-links";
import { BrandMark } from "./Brand";
import { SiteMenu } from "./SiteMenu";

/**
 * The header and footer of the pages outside a workspace: the landing page,
 * sign-in, the workspace chooser, the docs, the terms and privacy pages and
 * the not-found pages. Inside a workspace the navigation is `AppFrame`'s.
 */

/** The landing page's own sections, which its header and footer link to. */
export const LANDING_SECTIONS = [
  { href: "#measurements", label: "Measurements" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
] as const;

/** The landing header's links, in its bar and its menu: its own sections, then the developer docs. */
export const LANDING_LINKS = [...LANDING_SECTIONS, { href: "/docs", label: "Docs" }] as const;

const HEADER_LINK = "whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors duration-150 ease-standard hover:bg-raised/70 hover:text-ink";

/** A plain text link in a header's right side, as the landing page's section links. */
export function SiteHeaderLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={HEADER_LINK}>
      {children}
    </Link>
  );
}

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex shrink-0 items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink">
      <BrandMark className="size-9 shrink-0 text-agent drop-shadow-logo transition-transform duration-150 ease-standard group-hover:-rotate-6 group-hover:scale-105" />
      <span>Vestiarion</span>
    </Link>
  );
}

/** The one column of a page outside a workspace that is a single column, the workspace chooser: its header lines up with it. */
export const SITE_COLUMN = "max-w-md";

/**
 * `landing` adds the section links, sign-in and the console call to action; `children` fill the right side otherwise.
 * `section` names the part of the site beside the wordmark ("Docs"). `width` matches what the header sits over: the
 * landing column by default, a wider page (`wide`), or a page that is one `SITE_COLUMN` (`column`). For a column the
 * gutter sits outside it, as on the page's `<main className="px-4">`, so the wordmark starts where the column starts and
 * the right side ends where it ends.
 */
export function SiteHeader({
  landing = false,
  section,
  width = "page",
  children,
}: {
  landing?: boolean;
  section?: { href: string; label: string };
  width?: "page" | "wide" | "column";
  children?: ReactNode;
}) {
  return (
    <header className={cn("sticky top-0 z-50 border-b border-line/60 bg-surface/88 backdrop-blur-xl", width === "column" && "px-4")}>
      <div
        className={cn(
          "mx-auto flex h-16 items-center gap-3",
          width === "column" ? cn("w-full", SITE_COLUMN) : "px-4 sm:px-6",
          width === "wide" && "max-w-[88rem]",
          width === "page" && "max-w-6xl"
        )}
      >
        <Wordmark />
        {section && (
          <Link
            href={section.href}
            className="border-l border-line pl-3 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-agent transition-colors duration-150 ease-standard hover:text-ink"
          >
            {section.label}
          </Link>
        )}
        {landing && (
          <nav aria-label="Site" className="mx-auto hidden lg:block">
            <ul className="flex items-center gap-1">
              {LANDING_LINKS.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith("#") ? (
                    <a href={link.href} className={HEADER_LINK}>
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} className={HEADER_LINK}>
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={landing ? "ml-auto flex items-center gap-2 lg:ml-0" : "ml-auto flex items-center gap-1"}>
          {landing ? (
            <>
              <Button asChild variant="ghost" className="hidden md:inline-flex">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild className="hidden min-[375px]:inline-flex">
                <Link href="/onboarding">Open console</Link>
              </Button>
              <SiteMenu links={LANDING_LINKS} />
            </>
          ) : (
            children
          )}
        </div>
      </div>
    </header>
  );
}

export interface FooterLink {
  href: string;
  label: string;
}

/**
 * The full footer's columns (spec §2, F1). An address starting `#` is a
 * section of the landing page, the one page this footer is on; `http…` is
 * another site and opens in a new tab; anything else is a page of this app.
 */
export const FOOTER_COLUMNS: ReadonlyArray<{ title: string; links: readonly FooterLink[] }> = [
  {
    title: "Product",
    links: [...LANDING_SECTIONS, { href: "/login", label: "Sign in" }, { href: "/onboarding", label: "Open console" }],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs", label: "Documentation" },
      { href: "/docs/api", label: "API reference" },
      { href: "/docs/ai-integration/mcp", label: "MCP server" },
      { href: "/docs/changelog", label: "Changelog" },
      { href: GITHUB_URL, label: "GitHub" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/open", label: "Open numbers" },
      { href: "/docs/guides/go-live", label: "Go live guide" },
      { href: "/docs/guides/first-payment", label: "First payment guide" },
      { href: ISSUES_URL, label: "Support" },
      { href: X_URL, label: "Updates on X" },
      { href: PRODUCT_HUNT_URL, label: "Product Hunt" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
      { href: ISSUES_URL, label: "Contact" },
    ],
  },
];

/** The compact footer's links, beside its one line. */
export const COMPACT_FOOTER_LINKS: readonly FooterLink[] = [
  { href: "/docs", label: "Docs" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: GITHUB_URL, label: "GitHub" },
  { href: X_URL, label: "X" },
];

const isExternal = (href: string) => /^https?:\/\//.test(href);

/** A footer link: another site in a new tab, a landing section as a plain anchor, a page through the router. */
function FooterAnchor({ href, className, label, children }: { href: string; className: string; label?: string; children: ReactNode }) {
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={className}>
        {children}
      </a>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a href={href} aria-label={label} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} aria-label={label} className={className}>
      {children}
    </Link>
  );
}

/**
 * GitHub's mark, drawn in the current text colour. lucide-react dropped its
 * brand icons, so the installed version has no GitHub icon to use.
 */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" className={className}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const COLUMN_LINK = "inline-flex py-1.5 text-sm text-ink-2 transition-colors duration-150 ease-standard hover:text-agent";
const COMPACT_LINK = "inline-flex py-1 text-ink-2 transition-colors duration-150 ease-standard hover:text-agent";
const ICON_LINK = "-my-2 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors duration-150 ease-standard hover:bg-raised/70 hover:text-ink";
const COPYRIGHT = "© 2026 Vestiarion contributors";

/**
 * The full footer is the landing page's: the wordmark, then four columns of
 * links, two across on a phone, four from `sm` and beside the wordmark from
 * `lg`. `compact` is one line and four links, for every other public page.
 */
export function SiteFooter({ compact = false, networkLabel = "Arc testnet" }: { compact?: boolean; networkLabel?: string }) {
  if (compact) {
    return (
      <footer className="border-t border-line/80 px-4 py-6 font-mono text-xs text-ink-3">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 text-center sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-6">
          {/* Each part keeps to one line, so a narrow screen wraps between them, after a separator. */}
          <p className="[&>span]:whitespace-nowrap">
            <span>{COPYRIGHT} ·</span> <span>MIT License ·</span> <span>Signed decisions on {networkLabel}</span>
          </p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap justify-center gap-x-4">
              {COMPACT_FOOTER_LINKS.map((link) => (
                <li key={link.href}>
                  <FooterAnchor href={link.href} className={COMPACT_LINK}>
                    {link.label}
                  </FooterAnchor>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    );
  }

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:grid-cols-6">
          <div className="col-span-2 sm:col-span-4 lg:col-span-2">
            <Wordmark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-2">
              An autonomous treasury agent. A model proposes, code enforces the boundary, and every decision is signed into a chain anyone can verify.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title} className="min-w-0">
              <Eyebrow>{column.title}</Eyebrow>
              <ul className="mt-3 space-y-1">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterAnchor href={link.href} className={COLUMN_LINK}>
                      {link.label}
                    </FooterAnchor>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 font-mono text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>
            {COPYRIGHT} ·{" "}
            <FooterAnchor href={LICENSE_URL} className="underline decoration-line-strong underline-offset-4 transition-colors duration-150 ease-standard hover:text-agent">
              MIT License
            </FooterAnchor>
          </p>
          <div className="flex items-center justify-between gap-4 sm:justify-end">
            <p className="min-w-0">Hash-chained decisions · Ed25519 signed · Arc testnet</p>
            <div className="flex shrink-0 items-center gap-1">
              <FooterAnchor href={GITHUB_URL} label="Vestiarion on GitHub" className={ICON_LINK}>
                <GitHubMark className="size-5" />
              </FooterAnchor>
              <FooterAnchor href={X_URL} label="Vestiarion on X" className={ICON_LINK}>
                <XMark className="size-4" />
              </FooterAnchor>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
