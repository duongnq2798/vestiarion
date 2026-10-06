import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * A link page's own preview card (docs/superpowers/specs/2026-10-06-mainnet-polish-design.md E1): `/pay`, `/payee` and
 * `/receipt` each have an Open Graph and a Twitter image, so a link pasted into a chat no longer shows the platform's
 * card, whose footer says "Arc testnet". The card names no network and reads nothing of the link: no amount, no name.
 * `ImageResponse` is stubbed to keep the element it is given, which is rendered here as markup.
 */

vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(
      public element: ReactElement,
      public options: unknown
    ) {}
  },
}));

const payOg = await import("@/app/pay/[token]/opengraph-image");
const payTw = await import("@/app/pay/[token]/twitter-image");
const payeeOg = await import("@/app/payee/[token]/opengraph-image");
const payeeTw = await import("@/app/payee/[token]/twitter-image");
const receiptOg = await import("@/app/receipt/[token]/opengraph-image");
const receiptTw = await import("@/app/receipt/[token]/twitter-image");

type Route = { default: () => unknown; alt: string; contentType: string };
const ROUTES = [
  ["pay", "Pay an invoice", [payOg, payTw]],
  ["payee", "Your payment", [payeeOg, payeeTw]],
  ["receipt", "Payment receipt", [receiptOg, receiptTw]],
] as const satisfies ReadonlyArray<readonly [string, string, readonly Route[]]>;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("a link page's preview card (mainnet polish E1)", () => {
  it.each(ROUTES)("/%s has its own Open Graph and Twitter image, with its badge and no network named", (_page, badge, routes) => {
    for (const route of routes) {
      const card = text(renderToStaticMarkup((route.default() as unknown as { element: ReactElement }).element));
      expect(card).toContain(badge);
      expect(card).toContain("Arc");
      expect(card).not.toContain("Arc testnet");
      expect(card).not.toContain("Arc mainnet");
      expect(route.contentType).toBe("image/png");
      expect(route.alt).toMatch(/^Vestiarion/);
    }
  });

  it.each(ROUTES)("/%s's card reads nothing of the link", (page) => {
    for (const kind of ["opengraph-image", "twitter-image"]) {
      const source = readFileSync(path.join(process.cwd(), "src/app", page, "[token]", `${kind}.tsx`), "utf8");
      expect(source).not.toMatch(/params|pay-links|payee-links|receipts|token\b/);
    }
  });

  it("keeps the platform's own card as it was, with its Arc testnet line (2c C5)", async () => {
    const root = (await import("@/app/opengraph-image")) as unknown as { default: () => { element: ReactElement } };
    expect(text(renderToStaticMarkup(root.default().element))).toContain("Arc testnet");
  });
});
