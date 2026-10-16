import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DocsCallout } from "@/components/docs/DocsCallout";
import { DocsPage, editHref } from "@/components/docs/DocsShell";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { Flow, FlowStep } from "@/components/docs/Flow";
import { INDEXED_SECTIONS, TopicIndex } from "@/components/docs/TopicIndex";
import { readSource } from "@/lib/docs/content";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { DOCS_NAV, docsHref } from "@/lib/docs/nav";
import { useMDXComponents } from "../mdx-components";

/** The page being read, as the router would say it. */
const route = vi.hoisted(() => ({ pathname: "/docs/guides/bank-payouts" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ push: vi.fn() }) }));

const ORIGIN = "https://www.vestiarion.xyz";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * The docs redesign (docs/superpowers/specs/2026-10-16-docs-redesign-design.md): a sidebar that shows one section at a
 * time, a frame with where a page sits and where it is edited, callouts that say their kind, a workflow figure and the
 * home's topic index, each the same in its Markdown view.
 */
describe("the docs sidebar", () => {
  it("opens the section holding the page being read, and keeps the others to their heading and page count (D3)", () => {
    route.pathname = "/docs/guides/bank-payouts";
    const markup = renderToStaticMarkup(<DocsSidebar sections={DOCS_NAV} />);
    const open = [...markup.matchAll(/<details open=""[^>]*><summary[^>]*>([\s\S]*?)<\/summary>/g)].map((match) => text(match[1]));
    expect(open).toEqual(["Pay bills 9 pages"]);
    // Every other section with more than one page is a closed disclosure with its count.
    const closed = [...markup.matchAll(/<details class="[^"]*"><summary[^>]*>([\s\S]*?)<\/summary>/g)].map((match) => text(match[1]));
    expect(closed).toContain("Get started 5 pages");
    expect(closed).toContain("API reference 14 pages");
    // The current page is marked in words for a screen reader, and its group heads its run.
    expect(markup).toMatch(/<a [^>]*aria-current="page"[^>]*href="\/docs\/guides\/bank-payouts"|<a [^>]*href="\/docs\/guides\/bank-payouts"[^>]*aria-current="page"/);
    for (const group of ["Pay", "Add bills", "Follow a payment", "For the people you pay"]) expect(markup).toContain(`>${group}</p>`);
    // A one-page section is a link of its own.
    expect(markup).toMatch(/<a [^>]*href="\/docs\/changelog"[^>]*>Changelog<\/a>/);
  });

  it("opens the first section on the docs' home", () => {
    route.pathname = "/docs";
    const markup = renderToStaticMarkup(<DocsSidebar sections={DOCS_NAV} />);
    const open = [...markup.matchAll(/<details open=""[^>]*><summary[^>]*>([\s\S]*?)<\/summary>/g)].map((match) => text(match[1]));
    expect(open).toEqual(["Get started 5 pages"]);
  });
});

describe("a docs page's frame", () => {
  it("says where the page sits, and where it is edited when it is written in MDX (D4)", () => {
    const markup = renderToStaticMarkup(
      <DocsPage slug="guides/bank-payouts" section="Pay bills" title="Pay a vendor's bank account in Mexico" headings={[]}>
        <p>Body</p>
      </DocsPage>
    );
    expect(markup).toMatch(/<nav aria-label="Breadcrumb">[\s\S]*?href="\/docs"[\s\S]*?Pay bills/);
    expect(markup).toContain(`href="${editHref("guides/bank-payouts")}"`);
    expect(editHref("guides/bank-payouts")).toBe("https://github.com/duongnq2798/vestiarion/edit/main/content/docs/guides/bank-payouts.mdx");
    expect(editHref("")).toBe("https://github.com/duongnq2798/vestiarion/edit/main/content/docs/index.mdx");
    // A page with fewer than two sections has no "On this page".
    expect(markup).not.toContain('aria-label="On this page"');
  });

  it("offers no edit link for a page generated from the API's operations", () => {
    const markup = renderToStaticMarkup(
      <DocsPage slug="api/list-invoices" section="API reference" title="List invoices" headings={[]}>
        <p>Body</p>
      </DocsPage>
    );
    expect(markup).not.toContain("Edit this page on GitHub");
  });
});

describe("a callout", () => {
  it("is a note that says its kind in words beside its title (D6)", () => {
    const markup = renderToStaticMarkup(
      <DocsCallout kind="important" title="BlindPay's development instance">
        No pesos reach a bank.
      </DocsCallout>
    );
    expect(markup).toMatch(/^<div role="note"/);
    expect(text(markup)).toBe("Important BlindPay's development instance No pesos reach a bank.");
  });
});

describe("a workflow figure", () => {
  it("is an ordered list of its steps, with its caption (D7)", () => {
    const markup = renderToStaticMarkup(
      <Flow caption="In the sandbox.">
        <FlowStep title="A bill">In USDC.</FlowStep>
        <FlowStep title="A person approves">In Approvals.</FlowStep>
      </Flow>
    );
    expect(markup).toMatch(/<figure[^>]*><ol>/);
    expect(markup.match(/<li /g)).toHaveLength(2);
    expect(text(markup)).toBe("A bill In USDC. A person approves In Approvals. In the sandbox.");
  });

  it("is a numbered list in the Markdown view, its caption in italics", () => {
    const mdx = '<Flow caption="In the sandbox.">\n  <FlowStep title="A bill">\n    In USDC.\n  </FlowStep>\n  <FlowStep title="A person approves">\n    In Approvals.\n  </FlowStep>\n</Flow>\n';
    expect(mdxToMarkdown(mdx, ORIGIN)).toBe("1. **A bill**: In USDC.\n2. **A person approves**: In Approvals.\n\n*In the sandbox.*\n");
  });

  it("keeps the bank payout guide's limits beside it: a person approves every payout, and in this version none reaches a bank", () => {
    const guide = readSource("guides/bank-payouts");
    expect(guide).toContain('<FlowStep title="A person approves">');
    expect(guide).toMatch(/<Flow caption="[^"]*no pesos reach a bank\.">/);
    expect(guide).toContain('<Callout kind="important" title="BlindPay\'s development instance">');
    expect(guide).toContain("It never pays a bank payout by itself: a person approves every one.");
  });
});

describe("the docs' home", () => {
  it("indexes every section a business or a developer reads, from the nav itself (D5)", () => {
    expect(INDEXED_SECTIONS.map((section) => section.title)).toEqual([
      "Get started",
      "Pay bills",
      "Plan and report",
      "Get paid",
      "Trust and controls",
      "Connect your tools",
      "Developers",
    ]);
    const markup = renderToStaticMarkup(<TopicIndex />);
    for (const section of INDEXED_SECTIONS) {
      expect(markup).toContain(`aria-label="${section.title}"`);
      // Each card links its first pages, and every link is a page in the nav.
      const first = section.pages.filter((page) => page.slug !== "")[0];
      expect(markup).toContain(`href="${docsHref(first.slug)}"`);
    }
    const markdown = mdxToMarkdown("<TopicIndex />\n", ORIGIN);
    for (const section of INDEXED_SECTIONS) expect(markdown).toContain(`- **${section.title}**: `);
    expect(markdown).toContain(`[Pay a vendor's bank account in Mexico](${ORIGIN}/docs/guides/bank-payouts)`);
  });

  it("draws each card's icon from one set, and refuses a name outside it", () => {
    const Card = useMDXComponents().Card as (props: { title: string; href: string; icon?: string; children?: string }) => React.ReactElement;
    expect(renderToStaticMarkup(<Card title="Go live" href="/docs/guides/go-live" icon="payment" />)).toContain("lucide-send");
    expect(() => renderToStaticMarkup(<Card title="Go live" href="/docs/guides/go-live" icon="rocket-ship" />)).toThrow(/is not one of/);
    // The home's popular workflows each carry one.
    const home = readSource("");
    const popular = home.slice(home.indexOf("## Popular workflows"), home.indexOf("## Explore by topic"));
    expect(popular.match(/<Card icon="/g)).toHaveLength(6);
  });
});
