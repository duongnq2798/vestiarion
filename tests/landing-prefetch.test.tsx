import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The landing prefetches only the pages a visitor is likely to open from it (landing motion M4): its links into the
 * docs and guides, 570 KB of the 626 KB a full scroll prefetched, are not prefetched; the call to action, sign-in and
 * /how-it-decides still are. `next/link` is stood in for by an anchor that says which links turned prefetching off.
 */
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...props }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => (
    <a href={href} data-prefetch={prefetch === false ? "off" : undefined} {...props}>
      {children}
    </a>
  ),
}));

import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { TRY_HREF } from "@/components/landing/cta";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { Integrations } from "@/components/landing/Integrations";
import { landingPrefetch } from "@/components/landing/prefetch";
import { Proof } from "@/components/landing/Proof";
import { Safety } from "@/components/landing/Safety";
import { Steps } from "@/components/landing/Steps";
import { UseCases } from "@/components/landing/UseCases";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

const markup = renderToStaticMarkup(
  <TooltipProvider>
    <SiteHeader landing />
    <Hero />
    <Steps />
    <UseCases />
    <Safety />
    <Proof numbers={new Promise(() => {})} facts={new Promise(() => {})} />
    <Integrations />
    <BuildOnIt />
    <Faq mainnetForEveryone />
    <FinalCta />
    <SiteFooter />
  </TooltipProvider>
);

/** Every link on the page that stays on the site, with whether it turned prefetching off. */
const links = [...markup.matchAll(/<a\b[^>]*>/g)]
  .map(([tag]) => ({ href: /href="([^"]*)"/.exec(tag)?.[1] ?? "", off: tag.includes('data-prefetch="off"') }))
  .filter((link) => link.href.startsWith("/"));

describe("the landing's links", () => {
  it("prefetch none of the docs and guides", () => {
    const docs = links.filter((link) => link.href.startsWith("/docs"));
    expect(docs.length).toBeGreaterThan(20);
    expect(docs.filter((link) => !link.off).map((link) => link.href)).toEqual([]);
    // The safety section's payee lock case links its guide (landing payee lock PLL6).
    expect(docs.map((link) => link.href)).toContain("/docs/guides/first-payment#payee-lock");
  });

  it("still prefetch the call to action, sign-in and how the agent decides", () => {
    for (const href of [TRY_HREF, "/login", "/how-it-decides"]) {
      const to = links.filter((link) => link.href === href);
      expect(to.length, href).toBeGreaterThan(0);
      expect(to.every((link) => !link.off), href).toBe(true);
    }
  });

  it("say so in one place", () => {
    expect(landingPrefetch("/docs/guides/xero")).toBe(false);
    expect(landingPrefetch("/docs")).toBe(false);
    expect(landingPrefetch("/how-it-decides")).toBeUndefined();
    expect(landingPrefetch("/studios")).toBeUndefined();
  });
});
