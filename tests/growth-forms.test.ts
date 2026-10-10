import { describe, expect, it } from "vitest";
import { campaignSchema, decisionSchema, firstIssue, formFields, linkSchema, revenueSchema, spendSchema, stageSchema } from "@/lib/growth/forms";
import { growthHref, parseGrowthView } from "@/lib/growth/view";

/** What the founder dashboard's forms may send (src/lib/growth/forms.ts), and what its address may ask for (view.ts). */

const LEAD = "3f1c2a4e-1111-4222-8333-444455556666";
const issue = (result: { success: boolean; error?: Parameters<typeof firstIssue>[0] }) => (result.success || !result.error ? null : firstIssue(result.error));

describe("the campaign form", () => {
  it("reads every field", () => {
    expect(
      campaignSchema.parse({
        id: "Agency-Oct",
        name: " Agencies ",
        strategies: "12, 3 3",
        segment: "",
        offer: "Free pilot",
        starts_on: "2026-10-01",
        ends_on: "2026-10-31",
        cash_budget_usd: "1,200.50",
        hour_budget: "20.5",
        status: "running",
      })
    ).toEqual({
      id: "agency-oct",
      name: "Agencies",
      strategies: [3, 12],
      segment: null,
      offer: "Free pilot",
      starts_on: "2026-10-01",
      ends_on: "2026-10-31",
      cash_budget_usd: 1200.5,
      hour_budget: 20.5,
      status: "running",
    });
  });

  it("refuses a bad id, a strategy off 1 to 50, an end before the start, a negative budget and an unknown status", () => {
    const base = { id: "ok-id", name: "x", status: "planned" };
    expect(issue(campaignSchema.safeParse({ ...base, id: "x" }))).toMatch(/2 to 40/);
    expect(issue(campaignSchema.safeParse({ ...base, strategies: "51" }))).toMatch(/1 to 50/);
    expect(issue(campaignSchema.safeParse({ ...base, starts_on: "2026-10-05", ends_on: "2026-10-01" }))).toMatch(/before the start/);
    expect(issue(campaignSchema.safeParse({ ...base, cash_budget_usd: "-5" }))).toMatch(/from 0/);
    expect(issue(campaignSchema.safeParse({ ...base, status: "won" }))).toMatch(/status/);
  });
});

describe("the spend and revenue forms", () => {
  it("takes spend in cash, hours or both, never neither", () => {
    expect(spendSchema.parse({ campaign_id: "none", spent_on: "2026-10-01", usd: "", founder_hours: "2" })).toEqual({
      campaign_id: null,
      spent_on: "2026-10-01",
      usd: 0,
      founder_hours: 2,
      note: null,
    });
    expect(issue(spendSchema.safeParse({ spent_on: "2026-10-01" }))).toMatch(/amount, hours, or both/);
    expect(issue(spendSchema.safeParse({ spent_on: "2026-13-01", usd: "1" }))).toMatch(/YYYY-MM-DD/);
  });

  it("needs an amount with its currency, and both for a payment received", () => {
    expect(revenueSchema.parse({ kind: "pricing_discussed", occurred_on: "2026-10-01", lead_id: "none" })).toMatchObject({ amount: null, currency: null, lead_id: null });
    expect(revenueSchema.parse({ kind: "payment_received", amount: "99.90", currency: "usd", occurred_on: "2026-10-01", lead_id: LEAD })).toMatchObject({
      amount: 99.9,
      currency: "USD",
      lead_id: LEAD,
    });
    expect(issue(revenueSchema.safeParse({ kind: "payment_received", occurred_on: "2026-10-01" }))).toMatch(/needs its amount/);
    expect(issue(revenueSchema.safeParse({ kind: "invoice_issued", amount: "5", occurred_on: "2026-10-01" }))).toMatch(/with its currency/);
  });
});

describe("the lead forms", () => {
  it("take a stage, a workspace and a decision for one lead", () => {
    expect(stageSchema.parse({ lead_id: LEAD, stage: "lost", note: " no budget " })).toEqual({ lead_id: LEAD, stage: "lost", note: "no budget" });
    expect(issue(stageSchema.safeParse({ lead_id: LEAD, stage: "won" }))).toMatch(/stage/);
    expect(linkSchema.parse({ lead_id: LEAD, workspace: "" })).toEqual({ lead_id: LEAD, workspace: null, note: null });
    expect(decisionSchema.parse({ lead_id: LEAD, decision: "approve" })).toEqual({ lead_id: LEAD, decision: "approve", note: null });
    expect(issue(decisionSchema.safeParse({ lead_id: LEAD, decision: "reject", note: "  " }))).toBe("Say why it is rejected.");
  });

  it("reads a form's string fields once each, and leaves a file out", () => {
    const data = new FormData();
    data.append("a", "1");
    data.append("a", "2");
    data.append("file", new Blob(["x"]), "x.csv");
    expect(formFields(data)).toEqual({ a: "1" });
  });
});

describe("the dashboard's address", () => {
  const NOW = new Date("2026-10-10T12:00:00Z");

  it("reads since, side and the filters, and falls back where it cannot", () => {
    expect(parseGrowthView({}, NOW)).toMatchObject({ since: "2026-09-27", sinceFallback: false, side: "customers", campaign: null, stage: null, review: null });
    expect(parseGrowthView({ since: "2026-10-01", side: "ours", campaign: "agency-oct", stage: "contacted", review: "rejected" }, NOW)).toMatchObject({
      since: "2026-10-01",
      side: "ours",
      campaign: "agency-oct",
      stage: "contacted",
      review: "rejected",
    });
    expect(parseGrowthView({ since: "2026-10-01" }, NOW).sinceAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    for (const since of ["2026-10-11", "2025-12-31", "2026-02-30", "yesterday"]) {
      expect(parseGrowthView({ since }, NOW), since).toMatchObject({ since: "2026-09-27", sinceFallback: true });
    }
    expect(parseGrowthView({ campaign: "Bad Id", stage: "won", review: "maybe", side: "theirs" }, NOW)).toMatchObject({ campaign: null, stage: null, review: null, side: "customers" });
  });

  it("writes an address that keeps the view and leaves defaults out", () => {
    const view = parseGrowthView({ since: "2026-10-01", stage: "replied" }, NOW);
    expect(growthHref(view)).toBe("/admin/growth?since=2026-10-01&stage=replied");
    expect(growthHref(view, { stage: null, side: "ours" }, "#workspaces")).toBe("/admin/growth?since=2026-10-01&side=ours#workspaces");
    expect(growthHref(parseGrowthView({}, NOW))).toBe("/admin/growth");
  });
});
