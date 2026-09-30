import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PayeeLinkControl, { CreatedPayeeLink } from "@/components/intake/PayeeLinkControl";
import { TooltipProvider } from "@/components/ui/Tooltip";

vi.mock("@/app/actions/payee-links", () => ({ createPayeeLinkAction: vi.fn(), revokePayeeLinkAction: vi.fn() }));

/**
 * The counterparty card's payee-link control (spec 2026-09-30-payee-links-design.md
 * §2): ask a payee for their address, see that a link is out and when it
 * expires, revoke it; and the made link, shown once with a copy button.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const PAYEE = { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind" };
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe("PayeeLinkControl", () => {
  it("offers to ask the payee for their address when no link is out", () => {
    const page = text(render(<PayeeLinkControl orgSlug="acme" counterparty={PAYEE} activeLink={null} />));
    expect(page).toContain("Ask for address");
    expect(page).not.toContain("Address link sent");
  });

  it("says a link is out, until when, and offers to revoke it", () => {
    const markup = render(
      <PayeeLinkControl orgSlug="acme" counterparty={PAYEE} activeLink={{ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1", expiresAt: "2026-10-07T12:00:00+00:00" }} />
    );
    const page = text(markup);
    expect(page).toContain("Address link sent · expires Oct 7, 2026");
    expect(page).toContain("Revoke");
    expect(markup).toContain('value="0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1"');
  });
});

describe("CreatedPayeeLink", () => {
  it("shows the link once, read-only, with a copy button and what the payee's answer leads to", () => {
    const url = `https://www.vestiarion.xyz/payee/vxp_${"A".repeat(43)}`;
    const markup = render(<CreatedPayeeLink url={url} expiresAt="2026-10-07T12:00:00+00:00" payeeName="Northwind" />);
    expect(markup).toMatch(new RegExp(`<input[^>]*readOnly=""[^>]*value="${url}"|<input[^>]*value="${url}"[^>]*readOnly=""`));
    const page = text(markup);
    expect(page).toContain("Copy link");
    expect(page).toContain("It works once and expires Oct 7, 2026.");
    expect(page).toContain("the agent holds payments to Northwind until someone here confirms it");
  });
});
