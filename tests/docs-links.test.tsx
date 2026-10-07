import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsLink } from "@/components/DocsLink";
import { slugifyHeadings } from "@/lib/docs/headings";
import { findPage } from "@/lib/docs/nav";

/**
 * Each section of the app that a docs page explains links it beside its heading, as API keys and Webhooks always did:
 * the book and "Docs". Every such link names a page the docs have, and a heading that page has.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Every file under a folder, recursively. */
function files(folder: string): string[] {
  return readdirSync(path.join(root, folder)).flatMap((name) => {
    const relative = path.join(folder, name);
    return statSync(path.join(root, relative)).isDirectory() ? files(relative) : [relative];
  });
}

/** Where each section links its docs: the file that draws its heading, and the page (and heading) it opens. */
const SECTIONS: Array<[string, string]> = [
  ["src/components/ApiKeysPanel.tsx", "/docs/get-started/authentication"],
  ["src/components/WebhooksPanel.tsx", "/docs/webhooks"],
  ["src/components/ShadowModePanel.tsx", "/docs/guides/shadow-mode"],
  ["src/components/GoLivePanel.tsx", "/docs/guides/go-live"],
  ["src/components/UsycReservePanel.tsx", "/docs/guides/go-live#earn-on-idle-cash-with-usyc"],
  ["src/components/SlackPanel.tsx", "/docs/guides/slack"],
  ["src/components/GitHubPanel.tsx", "/docs/guides/github"],
  ["src/components/EmailInboxPanel.tsx", "/docs/guides/email-invoices"],
  ["src/components/TwoApprovalsPanel.tsx", "/docs/guides/first-payment#two-approvals-above-a-figure"],
  ["src/components/LedgerKeyPanel.tsx", "/docs/guides/audit-export#5-after-a-key-rotation"],
  ["src/components/NotificationsPanel.tsx", "/docs/guides/telegram"],
  ["src/app/o/[slug]/contractors/page.tsx", "/docs/guides/pay-a-contractor"],
  ["src/app/o/[slug]/audit/page.tsx", "/docs/guides/audit-export"],
];

describe("DocsLink", () => {
  it("is the book and Docs, linking the page, named for screen readers by what it explains", () => {
    const markup = renderToStaticMarkup(<DocsLink href="/docs/guides/shadow-mode" topic="shadow mode" />);
    expect(markup).toContain('href="/docs/guides/shadow-mode"');
    expect(markup).toContain('aria-label="Docs: shadow mode"');
    expect(markup).toContain(">Docs</a>");
    expect(markup).toContain("<svg");
  });
});

describe("the sections a docs page explains", () => {
  it.each(SECTIONS)("%s links %s beside its heading", (file, href) => {
    expect(read(file)).toContain(`<DocsLink href="${href}"`);
  });

  it("link only pages the docs have, and headings those pages have", () => {
    const links = [...files("src/components"), ...files("src/app")]
      .filter((file) => /\.tsx$/.test(file))
      .flatMap((file) => [...read(file).matchAll(/<DocsLink href="([^"]+)"/g)].map((match) => match[1]));
    expect(links.length).toBeGreaterThanOrEqual(SECTIONS.length);
    for (const href of links) {
      const [pathname, anchor] = href.split("#");
      const slug = pathname.replace(/^\/docs\//, "");
      expect(findPage(slug), `${href}: no such docs page`).toBeDefined();
      if (anchor) {
        const ids = slugifyHeadings(read(`content/docs/${slug}.mdx`)).map((heading) => heading.id);
        expect(ids, `${href}: no such heading`).toContain(anchor);
      }
    }
  });
});
