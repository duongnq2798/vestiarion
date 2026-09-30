import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PayeeLinkControl, { CreatedPayeeLink } from "@/components/intake/PayeeLinkControl";
import { counterpartiesRefreshMs } from "@/lib/counterparties-refresh";
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

describe("the create form's state", () => {
  // No DOM here (see tests/docs-try-it.test.tsx), so the structure is pinned instead:
  // the state that holds a just-made link lives in a component rendered inside the
  // dialog's content, which unmounts when the dialog closes. Reopening shows the
  // form again, never a link that has since been used or revoked.
  const source = readFileSync(path.join(process.cwd(), "src/components/intake/PayeeLinkControl.tsx"), "utf8");
  const body = (name: string) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));

  it("lives inside the dialog's content, not in the component that owns the dialog", () => {
    expect(body("AskForAddress")).not.toContain("useActionForm(");
    expect(body("CreateLinkForm")).toContain("useActionForm(createPayeeLinkAction");
    expect(body("AskForAddress")).toMatch(/<DialogContent[\s\S]*<CreateLinkForm/);
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

describe("counterpartiesRefreshMs", () => {
  // A payee answers from another browser: the Counterparties page re-reads its data
  // often while a link is out or an address waits for confirmation, so "not yet
  // confirmed" appears without a reload, and rarely otherwise.
  it("is 15 s while a link is out or an address waits, and 60 s otherwise", () => {
    expect(counterpartiesRefreshMs({ linksOut: 1, unconfirmed: 0 })).toBe(15_000);
    expect(counterpartiesRefreshMs({ linksOut: 0, unconfirmed: 2 })).toBe(15_000);
    expect(counterpartiesRefreshMs({ linksOut: 0, unconfirmed: 0 })).toBe(60_000);
  });
});
