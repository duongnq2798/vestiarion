import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PayFreelancerForm, { PaymentLinkReady } from "@/components/intake/PayFreelancerForm";
import { TooltipProvider } from "@/components/ui/Tooltip";

vi.mock("@/app/actions/pay-freelancer", () => ({ payFreelancerAction: vi.fn() }));

/**
 * The Pay a freelancer form on Contractors
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md §2): its
 * fields, what it says will happen in a live workspace and in a sandbox, and
 * the link once a payment is set up, shown once with a copy button.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const URL = `https://www.vestiarion.xyz/payee/vxp_${"A".repeat(43)}`;

describe("PayFreelancerForm", () => {
  it("asks who, for what and how much, with email and a link to the work optional", () => {
    const markup = render(<PayFreelancerForm orgSlug="mai" live />);
    for (const name of ["name", "email", "work", "amount", "evidence"]) expect(markup).toContain(`name="${name}"`);
    expect(markup).toContain('name="orgSlug" value="mai"');
    const page = text(markup);
    for (const label of ["Freelancer's name", "Freelancer's email", "What they delivered", "Amount (USDC)", "Link to the work", "Set up payment"]) expect(page).toContain(label);
  });

  it("says a live workspace pays only once the address is added and confirmed", () => {
    expect(text(render(<PayFreelancerForm orgSlug="mai" live />))).toContain("Nothing is paid until they add an address and someone here confirms it.");
  });

  it("says a sandbox pays simulated", () => {
    expect(text(render(<PayFreelancerForm orgSlug="mai" live={false} />))).toContain("the agent pays them simulated, within a minute");
  });
});

describe("PaymentLinkReady", () => {
  const PAGE = "/o/mai/counterparties/5f1e2d3c-0000-4000-8000-0000000000c1#payee-link";

  it("shows what happened, the link to copy, and when it expires", () => {
    const markup = render(<PaymentLinkReady message="Emailed Linh a link to add the address to be paid at." url={URL} expiresAt="2026-10-08T15:00:00+00:00" pageHref={PAGE} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain(`value="${URL}"`);
    const page = text(markup);
    expect(page).toContain("Emailed Linh a link");
    expect(page).toContain("Copy link");
    expect(page).toContain("expires Oct 8, 2026");
  });

  it("CL15: says a lost link is made again on their page, and links its payee link part", () => {
    const markup = render(<PaymentLinkReady message="Emailed Linh a link." url={URL} expiresAt="2026-10-08T15:00:00+00:00" pageHref={PAGE} />);
    expect(text(markup)).toContain("It is shown only now; make a new one on their page if it is lost.");
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${PAGE}"[^>]*>their page</a>`));
    expect(text(markup)).not.toContain("on Counterparties");
  });
});
