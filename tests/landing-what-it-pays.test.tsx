import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAYS_FOR, WhatItPays } from "@/components/landing/WhatItPays";
import { hasSource, readSource } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";

/**
 * The landing's grid of what the agent pays (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L3): six
 * kinds of payment, each said as its guide says it, and each linked to a guide and a heading that exist.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const DISCLAIMERS = [/no real money/i, /no real funds/i, /not real money/i, /fictional/i, /simulated money/i];

/** A docs link's page and heading, if it names one. */
function target(href: string): { slug: string; anchor: string | null } {
  const [path, anchor] = href.replace(/^\/docs\//, "").split("#");
  return { slug: path, anchor: anchor ?? null };
}

describe("WhatItPays", () => {
  const markup = renderToStaticMarkup(<WhatItPays />);
  const words = text(markup);

  it("names the six kinds of payment the agent takes", () => {
    expect(PAYS_FOR.map((card) => card.title)).toEqual([
      "Supplier bills",
      "Freelancers and contractors",
      "Bounties on pull requests",
      "Retainers and subscriptions",
      "Payees on other chains",
      "Bills in euros",
    ]);
    for (const card of PAYS_FOR) {
      expect(words).toContain(card.title);
      expect(words).toContain(card.body);
    }
    expect(markup).toMatch(/<h2 id="what-it-pays-title"/);
  });

  it("links every card, and the line on getting paid, to a guide and a heading that exist", () => {
    const hrefs = [...PAYS_FOR.map((card) => card.href), "/docs/guides/first-payment#9-get-paid-by-a-client"];
    for (const href of hrefs) {
      expect(markup).toContain(`href="${href}"`);
      const { slug, anchor } = target(href);
      expect(hasSource(slug), `${slug} is a docs page`).toBe(true);
      if (anchor) expect(slugifyHeadings(readSource(slug)).map((heading) => heading.id), `${href} names a heading`).toContain(anchor);
    }
  });

  it("gives each guide link its card's name, for a reader who hears the links alone", () => {
    for (const card of PAYS_FOR) expect(markup).toContain(`aria-label="How it decides: ${card.title}"`);
  });

  it("says which of it Arc mainnet does not have yet, as Go live says", () => {
    expect(words).toContain("Not on Arc mainnet yet: on Arc testnet.");
    expect(words).toContain("The swap is not on Arc mainnet yet.");
    expect(PAYS_FOR.filter((card) => card.notOnMainnet).map((card) => card.key)).toEqual(["chains", "eurc"]);
  });

  it("says the illustrations are examples, and never talks the product down", () => {
    expect(words).toContain("Illustrations with example payees and amounts. The steps, checks and rules are the agent's own.");
    for (const phrase of DISCLAIMERS) expect(words).not.toMatch(phrase);
  });
});
