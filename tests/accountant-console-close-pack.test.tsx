import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountantConsole } from "@/components/accountant/AccountantConsole";
import { ACCOUNTANT_NOW, ACCOUNTANT_PORTFOLIO } from "@/app/docs-shots/accountant-fixture";
import { triageFilter } from "@/lib/accountant/triage";

vi.mock("server-only", () => ({}));

/**
 * Where the monthly close pack opens from in the accountant console (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md
 * CP16): under each workspace card's Hand-off line, a Close pack line with last month and this month so far, each
 * linking that card's own workspace's page with its month.
 */

describe("the accountant console's Close pack line (close pack CP16)", () => {
  const markup = renderToStaticMarkup(<AccountantConsole portfolio={ACCOUNTANT_PORTFOLIO} now={ACCOUNTANT_NOW} filter={triageFilter({})} />);
  // Each card's markup, the last one ending where the queue begins.
  const cards = markup.slice(0, markup.indexOf('id="queue-title"')).split("data-workspace=").slice(1);

  it("is on every workspace card, below its hand-off", () => {
    expect(cards).toHaveLength(ACCOUNTANT_PORTFOLIO.workspaces.length);
    for (const card of cards) {
      expect(card.indexOf("Close pack:")).toBeGreaterThan(card.indexOf("Hand-off:"));
      expect(card.match(/Close pack:/g)).toHaveLength(1);
    }
  });

  it("links last month and this month so far for the card's own workspace", () => {
    // ACCOUNTANT_NOW is 2026-10-13: last month is September.
    ACCOUNTANT_PORTFOLIO.workspaces.forEach((workspace, index) => {
      const card = cards[index];
      expect(card.startsWith(`"${workspace.slug}"`)).toBe(true);
      const pack = card.slice(card.indexOf("Close pack:"));
      expect(pack).toMatch(new RegExp(`<a [^>]*href="/o/${workspace.slug}/evidence/close-pack\\?month=2026-09"[^>]*>Sep 2026</a>`));
      expect(pack).toMatch(new RegExp(`<a [^>]*href="/o/${workspace.slug}/evidence/close-pack\\?month=2026-10"[^>]*>This month so far</a>`));
      for (const other of ACCOUNTANT_PORTFOLIO.workspaces.filter((one) => one.slug !== workspace.slug)) expect(card).not.toContain(`/o/${other.slug}/`);
    });
  });

  it("opens the page rather than downloading a file", () => {
    for (const card of cards) {
      const pack = card.slice(card.indexOf("Close pack:"), card.indexOf("</p>", card.indexOf("Close pack:")));
      expect(pack).not.toContain("download");
    }
  });
});
