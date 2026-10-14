import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
import { crmPlanState } from "@/components/deals/crm-plan";
import { PlanFromCrmForm, PlannedFromCrm } from "@/components/deals/PlannedFromCrm";
import type { CrmRowView } from "@/lib/connectors/crm-review";

/**
 * Plan collections from a HubSpot won deal, once it succeeded (found in a live test): the page came back on
 * `?hubspot=<row>#plan-from-hubspot`, read the same deal again, and said "Website redesign cannot be planned: planned
 * already." in the held tone. A deal planned already now shows the deal it became, with Open the deal; right after its
 * own Plan collections the page goes on to that deal.
 */

const won = (over: Partial<CrmRowView> = {}): CrmRowView =>
  ({ id: "row-1", name: "Website redesign", company: "Granite Labs", amount: "12,000.00 USD", closeOn: "2026-10-01", stage: "Closed won", changes: [], plan: { ok: true }, linkedDeal: null, ...over }) as CrmRowView;

describe("crmPlanState", () => {
  it("shows the filled-in form for a won deal not planned yet", () => {
    expect(crmPlanState("row-1", [won()])).toEqual({ kind: "form", rowId: "row-1" });
  });

  it("shows the deal a won deal was planned as, never an error", () => {
    expect(crmPlanState("row-1", [won({ linkedDeal: { id: "deal-9", title: "Website redesign", status: "active" } })])).toEqual({
      kind: "planned",
      rowId: "row-1",
      title: "Website redesign",
      dealId: "deal-9",
      cancelled: false,
    });
    expect(crmPlanState("row-1", [won({ linkedDeal: { id: "deal-9", title: "Website redesign", status: "cancelled" } })])).toMatchObject({ kind: "planned", cancelled: true });
  });

  it("asks nothing without ?hubspot=, and leaves a row it does not list to the form's own read", () => {
    expect(crmPlanState(null, [won()])).toBeNull();
    expect(crmPlanState("row-2", [won()])).toEqual({ kind: "form", rowId: "row-2" });
  });
});

describe("PlannedFromCrm", () => {
  it("says the deal is planned already and opens it", () => {
    const markup = renderToStaticMarkup(<PlannedFromCrm rowId="row-1" title="Website redesign" dealHref="/o/acme/invoices/deals/deal-9" />);
    expect(markup).toContain("Already planned: Website redesign");
    expect(markup).toMatch(/<a[^>]*href="\/o\/acme\/invoices\/deals\/deal-9"[^>]*>Open the deal<\/a>/);
    expect(markup).toContain('role="status"');
    expect(markup).not.toMatch(/cannot be planned/);
  });

  it("keeps the form it wraps as it is", () => {
    expect(renderToStaticMarkup(<PlanFromCrmForm rowId="row-1">form</PlanFromCrmForm>)).toBe("<div>form</div>");
  });

  it("is what Receivables shows for ?hubspot= or ?pipedrive= naming a deal planned already, and the form remembers being sent", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/invoices/page.tsx"), "utf8");
    // Each CRM's own address (HubSpot connector H11, Pipedrive connector P9).
    expect(page).toContain('["hubspot", fromHubSpot, view.hubspot]');
    expect(page).toContain('["pipedrive", fromPipedrive, view.pipedrive ?? null]');
    expect(page).toContain('const plan = from.state === "list" ? crmPlanState(asked, from.won) : null;');
    expect(page).toContain('plan?.kind === "form" && canWrite && Array.isArray(deals)');
    expect(page).toContain("<PlannedFromCrm rowId={plan.rowId}");
    expect(page).toContain("<PlanFromCrmForm rowId={prefill.rowId}>");
  });
});
