import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/commissions", () => ({ setCommissionPlanAction: vi.fn(), endCommissionPlanAction: vi.fn(), createCommissionPayableAction: vi.fn() }));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import CommissionsStatePage from "@/app/docs-shots/commissions/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/commissions/<state> (docs/superpowers/specs/2026-10-14-commissions-design.md C10, C11): the page an owner
 * reads, the page the member a plan names as the partner reads, and the page before migration 0118 runs, drawn by the
 * page's own components from sample data, only where DOCS_SCREENSHOTS=1 is set.
 */

const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await CommissionsStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/commissions/<state>", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("owner")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("paid")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows an owner each plan, and each partner's commissions with their formulas and Create payable", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const page = text(await render("owner"));
    expect(page).toContain("New plan");
    expect(page).toContain("Lena Ortiz Referrals");
    expect(page).toContain("10% net");
    expect(page).toContain("12.5% gross");
    expect(page).toContain("Member who is this partner adam@northstar.example");
    // A payment in full, a part payment, a fee on the gross basis, a reversal carried forward and one still held.
    expect(page).toContain("3,000.00 USDC received × 10% = 300.00 USDC");
    expect(page).toContain("2,500.00 USDC received × 10% = 250.00 USDC");
    expect(page).toContain("INV-1043 Website rebuild: balance of 7,000.00 USDC");
    expect(page).toContain("0.50 USDC recorded as a fee on the invoice × 12.5% = 0.0625 USDC");
    expect(page).toContain("−400.00 USDC: the payment it was earned on was reversed");
    expect(page).toContain("Held: 150.00 USDC, the next due Oct 28, 2026.");
    expect(page).toContain("Due now: 150.00 USDC");
    expect(page).toContain("Due now: 250.00 USDC");
    expect(page).toContain("CS-7F3A21C9");
    expect(page).toContain("Paid");
    expect(page.match(/Create payable/g)).toHaveLength(2);
    expect(page).toContain("End plan");
    // Adam is the only other approver, and Brightline's partner: held, its payout would have no one to approve it.
    expect(page.match(/If the agent holds this payable, no one can approve it/g)).toHaveLength(1);
  });

  it("shows the member who is a partner their own commissions, and lets them change none", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const page = text(await render("partner"));
    expect(page).toContain("This is your own commission, so someone else changes its plan.");
    expect(page).toContain("These are your own commissions, so someone else creates their payable and approves it.");
    // Lena's payable, which is not theirs, they may still create.
    expect(page.match(/Create payable/g)).toHaveLength(1);
  });

  it("says commissions are not set up before migration 0118 runs", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    expect(text(await render("not-set-up"))).toContain("Commissions are not set up on this deployment yet.");
  });
});
