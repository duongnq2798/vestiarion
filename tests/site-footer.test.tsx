import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMPACT_FOOTER_LINKS, FOOTER_COLUMNS, LANDING_SECTIONS, SiteFooter } from "@/components/vx/SiteChrome";
import { GITHUB_URL, ISSUES_URL, LICENSE_URL, PRODUCT_HUNT_BADGE, PRODUCT_HUNT_URL, X_HANDLE, X_URL } from "@/lib/site-links";

/**
 * The site footer (spec §2, F1, F3): its columns, where each link goes, and
 * how it opens. The full footer is the landing page's; the compact one is
 * every other public page's.
 */

interface Anchor {
  href: string;
  text: string;
  target: string | null;
  rel: string | null;
  ariaLabel: string | null;
}

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function anchors(markup: string): Anchor[] {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: attr(match[1], "href") ?? "",
    text: text(match[2]),
    target: attr(match[1], "target"),
    rel: attr(match[1], "rel"),
    ariaLabel: attr(match[1], "aria-label"),
  }));
}

const isExternal = (href: string) => /^https?:\/\//.test(href);

describe("the full footer's columns", () => {
  it("are Product, Developers, Resources and Legal, in that order", () => {
    expect(FOOTER_COLUMNS.map((column) => column.title)).toEqual(["Product", "Developers", "Resources", "Legal"]);
  });

  it("put the landing sections, sign-in and the console under Product", () => {
    expect(FOOTER_COLUMNS[0].links).toEqual([
      ...LANDING_SECTIONS,
      { href: "/login", label: "Sign in" },
      { href: "/onboarding", label: "Open console" },
    ]);
  });

  it("put the docs, the API reference, the MCP server, the changelog and GitHub under Developers", () => {
    expect(FOOTER_COLUMNS[1].links).toEqual([
      { href: "/docs", label: "Documentation" },
      { href: "/docs/api", label: "API reference" },
      { href: "/docs/ai-integration/mcp", label: "MCP server" },
      { href: "/docs/changelog", label: "Changelog" },
      { href: GITHUB_URL, label: "GitHub" },
    ]);
  });

  it("put the open numbers, the two guides, Support (GitHub Issues), X and Product Hunt under Resources", () => {
    expect(FOOTER_COLUMNS[2].links).toEqual([
      { href: "/open", label: "Open numbers" },
      { href: "/docs/guides/go-live", label: "Go live guide" },
      { href: "/docs/guides/first-payment", label: "First payment guide" },
      { href: ISSUES_URL, label: "Support" },
      { href: X_URL, label: "Updates on X" },
      { href: PRODUCT_HUNT_URL, label: "Product Hunt" },
    ]);
  });

  it("put Terms, Privacy and Contact (GitHub Issues) under Legal", () => {
    expect(FOOTER_COLUMNS[3].links).toEqual([
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
      { href: ISSUES_URL, label: "Contact" },
    ]);
  });
});

describe("the full footer, rendered", () => {
  const markup = renderToStaticMarkup(<SiteFooter />);
  const links = anchors(markup);

  it("renders each column as a navigation region named by its title", () => {
    for (const column of FOOTER_COLUMNS) expect(markup).toContain(`<nav aria-label="${column.title}"`);
  });

  it("renders every column link with its label", () => {
    for (const link of FOOTER_COLUMNS.flatMap((column) => column.links)) {
      expect(links.some((anchor) => anchor.href === link.href && anchor.text === link.label), `${link.label} → ${link.href}`).toBe(true);
    }
  });

  it("opens every external link in a new tab, without an opener or a referrer", () => {
    const external = links.filter((anchor) => isExternal(anchor.href));
    expect(external.length).toBeGreaterThanOrEqual(5);
    for (const anchor of external) {
      expect(anchor.target, anchor.href).toBe("_blank");
      expect(anchor.rel, anchor.href).toBe("noopener noreferrer");
    }
  });

  it("keeps every internal link in the same tab", () => {
    const internal = links.filter((anchor) => !isExternal(anchor.href));
    expect(internal.length).toBeGreaterThanOrEqual(12);
    for (const anchor of internal) {
      expect(anchor.href, anchor.text).toMatch(/^[/#]/);
      expect(anchor.target, anchor.href).toBeNull();
      expect(anchor.rel, anchor.href).toBeNull();
    }
  });

  it("closes with a labelled X icon beside the GitHub one", () => {
    const icon = links.find((anchor) => anchor.ariaLabel === "Vestiarion on X");
    expect(icon).toMatchObject({ href: X_URL, text: "", target: "_blank", rel: "noopener noreferrer" });
    expect(markup).toMatch(/<a [^>]*aria-label="Vestiarion on X"[^>]*><svg [^>]*aria-hidden="true"/);
  });

  it("closes with the copyright, the MIT License and a labelled GitHub icon", () => {
    expect(text(markup)).toContain("© 2026 Vestiarion contributors");
    expect(links).toContainEqual({ href: LICENSE_URL, text: "MIT License", target: "_blank", rel: "noopener noreferrer", ariaLabel: null });
    const icon = links.find((anchor) => anchor.ariaLabel === "Vestiarion on GitHub");
    expect(icon).toMatchObject({ href: GITHUB_URL, text: "", target: "_blank", rel: "noopener noreferrer" });
    expect(markup).toMatch(/<a [^>]*aria-label="Vestiarion on GitHub"[^>]*><svg [^>]*aria-hidden="true"/);
  });

  it("lays its columns out two across on a phone, four from sm, and all four beside the wordmark from lg", () => {
    expect(markup).toMatch(/class="grid grid-cols-2 [^"]*sm:grid-cols-4 lg:grid-cols-6"/);
    expect(markup).toMatch(/<div class="col-span-2 sm:col-span-4 lg:col-span-2">/);
  });
});

describe("the compact footer", () => {
  const markup = renderToStaticMarkup(<SiteFooter compact />);
  const links = anchors(markup);

  it("links the docs, the terms, the privacy page, GitHub and X", () => {
    expect(COMPACT_FOOTER_LINKS).toEqual([
      { href: "/docs", label: "Docs" },
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
      { href: GITHUB_URL, label: "GitHub" },
      { href: X_URL, label: "X" },
    ]);
    expect(links.map(({ href, text: label }) => ({ href, label }))).toEqual(COMPACT_FOOTER_LINKS);
  });

  it("opens GitHub and X in a new tab, and the rest in this one", () => {
    for (const anchor of links) {
      if (isExternal(anchor.href)) {
        expect(anchor.target).toBe("_blank");
        expect(anchor.rel).toBe("noopener noreferrer");
      } else {
        expect(anchor.target).toBeNull();
      }
    }
  });

  it("keeps the copyright and the Arc testnet line", () => {
    expect(text(markup)).toContain("© 2026 Vestiarion contributors · MIT License");
    expect(text(markup)).toContain("Signed decisions on Arc testnet");
  });

  it("names a link's network on its page: Arc mainnet for a link there (mainnet copy C6)", () => {
    const mainnet = text(renderToStaticMarkup(<SiteFooter compact networkLabel="Arc mainnet" />));
    expect(mainnet).toContain("Signed decisions on Arc mainnet");
    expect(mainnet).not.toContain("Arc testnet");
  });
});

describe("the X account", () => {
  it("is @vestiarionhq", () => {
    expect(X_HANDLE).toBe("@vestiarionhq");
    expect(X_URL).toBe("https://x.com/vestiarionhq");
  });

  it("is written only in src/lib/site-links.ts", () => {
    for (const file of ["src/components/vx/SiteChrome.tsx", "src/app/layout.tsx", "src/app/page.tsx", "src/lib/docs/social.ts"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toContain("vestiarionhq");
    }
  });
});

describe("the GitHub addresses", () => {
  it("are the repository and its Issues", () => {
    expect(GITHUB_URL).toBe("https://github.com/duongnq2798/vestiarion");
    expect(ISSUES_URL).toBe(`${GITHUB_URL}/issues`);
    expect(LICENSE_URL.startsWith(`${GITHUB_URL}/`)).toBe(true);
  });

  it("are written only in src/lib/site-links.ts, so they change in one place", () => {
    for (const file of ["src/components/vx/SiteChrome.tsx", "src/app/terms/page.tsx", "src/app/privacy/page.tsx", "src/components/vx/LegalPage.tsx"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toContain("github.com/duongnq2798");
    }
  });
});

describe("the Product Hunt page", () => {
  it("is Vestiarion's product page, and the badge links to it with Product Hunt's tags", () => {
    expect(PRODUCT_HUNT_URL).toBe("https://www.producthunt.com/products/vestiarion");
    expect(PRODUCT_HUNT_BADGE.href.startsWith(`${PRODUCT_HUNT_URL}?embed=true&`)).toBe(true);
    expect(PRODUCT_HUNT_BADGE.src).toBe("https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1269583&theme=light");
  });

  it("is written only in src/lib/site-links.ts", () => {
    for (const file of ["src/components/vx/SiteChrome.tsx", "src/components/landing/Hero.tsx"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toContain("producthunt.com");
    }
  });
});
