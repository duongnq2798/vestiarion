import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * A link page's own preview card (docs/superpowers/specs/2026-10-06-mainnet-polish-design.md E1): `/pay`, `/payee` and
 * `/receipt` point their Open Graph and X metadata at one card per kind of link, served from `/og/link/<page>`. Like the
 * docs pages' images, each is rendered at build time and skipped by the proxy, so a crawler's fetch costs nothing and
 * never refreshes a session (final review I2). The card names no network beyond Arc, no currency (I1), and reads
 * nothing of the link: no token reaches the image's address. `ImageResponse` is stubbed to keep the element it is given.
 */

vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(
      public element: ReactElement,
      public options: unknown
    ) {}
  },
}));

const route = await import("@/app/og/link/[page]/route");
const { LINK_PREVIEWS, linkImagePath, linkSocialMetadata } = await import("@/lib/link-previews");

const PAGES = [
  ["pay", "Pay an invoice"],
  ["payee", "Your payment"],
  ["receipt", "Payment receipt"],
] as const;
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const card = async (page: string) => (await route.GET(new Request(`https://vestiarion.invalid/og/link/${page}`), { params: Promise.resolve({ page }) })) as unknown;

describe("a link page's preview card (mainnet polish E1)", () => {
  it("renders one card per kind of link at build time, and no other", () => {
    expect(route.generateStaticParams()).toEqual([{ page: "pay" }, { page: "payee" }, { page: "receipt" }]);
    expect(route.dynamicParams).toBe(false);
    expect(linkImagePath("pay")).toBe("/og/link/pay");
  });

  it.each(PAGES)("draws /%s's card with its badge and no network named beyond Arc", async (page, badge) => {
    const drawn = text(renderToStaticMarkup(((await card(page)) as { element: ReactElement }).element));
    expect(drawn).toContain(badge);
    expect(drawn).toContain("Arc");
    expect(drawn).not.toContain("Arc testnet");
    expect(drawn).not.toContain("Arc mainnet");
  });

  it("answers 404 for a page that is not a link's", async () => {
    expect(((await card("invoices")) as Response).status).toBe(404);
  });

  it("names no currency on the pay card, as an invoice may be in EURC (final review I1)", () => {
    expect(LINK_PREVIEWS.pay.title).toBe("An invoice to pay");
    for (const preview of Object.values(LINK_PREVIEWS)) expect(`${preview.title} ${preview.line} ${preview.alt}`).not.toMatch(/USDC|EURC/);
  });

  it.each(PAGES)("points /%s's Open Graph and X metadata at its card, with the site-wide fields a page's openGraph replaces", (page) => {
    const social = linkSocialMetadata(page);
    const image = { url: `/og/link/${page}`, width: 1200, height: 630, type: "image/png", alt: LINK_PREVIEWS[page].alt };
    expect(social.openGraph).toMatchObject({ siteName: "Vestiarion", type: "website", locale: "en_US", images: [image] });
    expect(social.twitter).toMatchObject({ card: "summary_large_image", site: "@vestiarionhq", images: [image] });
    const pageSource = source(`src/app/${page}/[token]/page.tsx`);
    expect(pageSource).toContain(`...linkSocialMetadata("${page}")`);
    expect(pageSource).toContain("robots: { index: false, follow: false }");
  });

  it("reads nothing of any link, and keeps tokens out of the image's address", () => {
    expect(source("src/app/og/link/[page]/route.ts")).not.toMatch(/pay-links|payee-links|receipts|token/);
    for (const page of ["pay", "payee", "receipt"]) {
      for (const kind of ["opengraph-image", "twitter-image"]) expect(existsSync(path.join(process.cwd(), "src/app", page, "[token]", `${kind}.tsx`))).toBe(false);
    }
  });

  it("keeps the platform's own card as it was, with its Arc testnet line (2c C5)", async () => {
    const root = (await import("@/app/opengraph-image")) as unknown as { default: () => { element: ReactElement } };
    expect(text(renderToStaticMarkup(root.default().element))).toContain("Arc testnet");
  });
});
