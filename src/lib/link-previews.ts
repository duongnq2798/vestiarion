import type { Metadata } from "next";
import { X_HANDLE } from "./site-links";

/**
 * What a link page's preview card says (docs/superpowers/specs/2026-10-06-mainnet-polish-design.md E1): which kind of
 * page it is, and nothing of the link itself, since a card is shown to whoever the link is pasted to. No currency
 * either: an invoice may be in USDC or EURC (final review I1). Words only, so a page can read them without the fonts the
 * card's renderer loads.
 */
export const LINK_PREVIEWS = {
  pay: { badge: "Pay an invoice", title: "An invoice to pay", line: "Open the link to see who asks, how much, and where to send it.", alt: "Vestiarion — an invoice to pay" },
  payee: { badge: "Your payment", title: "A payment for your work", line: "Open the link to add your address and follow your payment.", alt: "Vestiarion — a payment for your work" },
  receipt: { badge: "Payment receipt", title: "A signed payment receipt", line: "Open the link to see the payment and check its signatures.", alt: "Vestiarion — a signed payment receipt" },
} as const;

export type LinkPage = keyof typeof LINK_PREVIEWS;

/** Where a link page's card is served, by `app/og/link/[page]/route.ts`: one per kind of link, never per link. */
export function linkImagePath(page: LinkPage): string {
  return `/og/link/${page}`;
}

/**
 * The Open Graph and X metadata of a link page, pointing at its card (final review I2). A page's `openGraph` replaces
 * the root layout's rather than merging with it, so the site-wide fields are repeated here, as the docs pages do. No
 * `url`: the page's address carries the link's token.
 */
export function linkSocialMetadata(page: LinkPage): Pick<Metadata, "openGraph" | "twitter"> {
  const { badge, line, alt } = LINK_PREVIEWS[page];
  const title = `${badge} · Vestiarion`;
  const image = { url: linkImagePath(page), width: 1200, height: 630, type: "image/png", alt };
  return {
    openGraph: { title, description: line, siteName: "Vestiarion", type: "website", locale: "en_US", images: [image] },
    twitter: { card: "summary_large_image", site: X_HANDLE, title, description: line, images: [image] },
  };
}
