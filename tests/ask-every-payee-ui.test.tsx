import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Ask every payee for an address, above the Counterparty book (docs/superpowers/specs/2026-10-18-ask-every-payee-design.md
 * A1, A2): how many payees have no address of their own, how many have a link out already, how many remain for the next
 * press, and the one button that opens the list.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/payee-links", () => ({ askEveryPayeeAction: vi.fn() }));

const { AskEveryPayee } = await import("@/components/intake/AskEveryPayee");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

const payees = [
  { id: "a", name: "Northwind Hosting", email: "billing@northwind.example", mirror: false },
  { id: "b", name: "Lumen Print Co.", email: null, mirror: true },
];

describe("AskEveryPayee", () => {
  it("says how many payees have no address, with those already asked and those left for later", () => {
    const words = text(renderToStaticMarkup(<AskEveryPayee orgSlug="pinecrest" payees={payees} more={3} linksOut={1} />));
    expect(words).toContain("Ask every payee for an address");
    expect(words).toContain("2 payees have no address of their own. Each gets its own one-time link, by email where it has one.");
    expect(words).toContain("1 more already has a link out.");
    expect(words).toContain("3 more after these, for the next time.");
    expect(words).toContain("Ask 2 for an address");
  });

  it("speaks of one payee in the singular", () => {
    const words = text(renderToStaticMarkup(<AskEveryPayee orgSlug="pinecrest" payees={payees.slice(0, 1)} more={0} linksOut={0} />));
    expect(words).toContain("1 payee has no address of its own.");
    expect(words).not.toContain("link out");
  });

  it("in a workspace that simulates its payments, says every link is to send yourself", () => {
    const words = text(renderToStaticMarkup(<AskEveryPayee orgSlug="pinecrest" payees={payees} more={0} linksOut={0} emails={false} />));
    expect(words).toContain("Each gets its own one-time link to send yourself: a workspace that simulates its payments emails no one.");
  });

  it("shows nothing once no payee is left to ask, while staying in place for the links it just made", () => {
    expect(renderToStaticMarkup(<AskEveryPayee orgSlug="pinecrest" payees={[]} more={0} linksOut={2} />)).toBe("");
  });
});
