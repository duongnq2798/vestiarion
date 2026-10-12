import { describe, expect, it } from "vitest";
import { crmChanges, crmChangeWords, factsOf, planCrmDeal, plannable, type CrmFacts, type StagedCrmDeal } from "@/lib/connectors/crm";
import type { ExternalDeal } from "@/lib/connectors/crm";

/**
 * One HubSpot deal, one row (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H9, H10), what may be
 * planned (H11), and what changed in HubSpot after a person planned a deal (H12): an amount changed, a stage lost, a
 * deal deleted, nothing changed.
 */

const WINDOW = "2026-07-14";
const deal = (fields: Partial<ExternalDeal> = {}): ExternalDeal => ({
  externalId: "30117482911",
  version: "2026-10-01T02:04:11.733Z",
  updatedAt: "2026-10-01T02:04:11.733Z",
  name: "Website rebuild",
  amount: "12500",
  currency: "USD",
  closeOn: "2026-10-01",
  pipelineId: "default",
  pipelineLabel: "Sales Pipeline",
  stageId: "closedwon",
  stageLabel: "Closed Won",
  stage: "won",
  company: { externalId: "9100000001", name: "Northwind Labs", email: "jane.ito@northwind.example" },
  ...fields,
});
const row = (fields: Partial<StagedCrmDeal> = {}): StagedCrmDeal => ({ id: "row-1", externalVersion: "2026-10-01T02:04:11.733Z", sourceStatus: "present", dealId: null, ...fields });

describe("planCrmDeal", () => {
  it("keeps a new open deal, and a won one closed in the window or with no close day", () => {
    expect(planCrmDeal(null, deal({ stage: "open", closeOn: "2025-01-01" }), WINDOW)).toEqual({ kind: "insert" });
    expect(planCrmDeal(null, deal(), WINDOW)).toEqual({ kind: "insert" });
    expect(planCrmDeal(null, deal({ closeOn: null }), WINDOW)).toEqual({ kind: "insert" });
    expect(planCrmDeal(null, deal({ closeOn: WINDOW }), WINDOW)).toEqual({ kind: "insert" });
  });

  it("leaves out a won deal closed before the window, and a lost deal it never had", () => {
    expect(planCrmDeal(null, deal({ closeOn: "2026-07-13" }), WINDOW)).toEqual({ kind: "ignore", reason: "outside" });
    expect(planCrmDeal(null, deal({ stage: "lost" }), WINDOW)).toEqual({ kind: "ignore", reason: "lost" });
  });

  it("follows a row it has whatever happens to the deal, and ignores an older or equal version", () => {
    expect(planCrmDeal(row(), deal({ version: "2026-10-02T00:00:00.000Z", stage: "lost", closeOn: "2020-01-01" }), WINDOW)).toEqual({ kind: "update" });
    expect(planCrmDeal(row(), deal(), WINDOW)).toEqual({ kind: "ignore", reason: "older" });
    expect(planCrmDeal(row(), deal({ version: "2026-09-30T00:00:00.000Z" }), WINDOW)).toEqual({ kind: "ignore", reason: "older" });
  });

  it("brings a deal HubSpot gives back after a deletion in again, by its newer version", () => {
    expect(planCrmDeal(row({ sourceStatus: "deleted" }), deal({ version: "2026-10-03T00:00:00.000Z" }), WINDOW)).toEqual({ kind: "update" });
  });
});

describe("plannable", () => {
  const facts = { stage: "won" as const, sourceStatus: "present" as const, dealId: null, amount: "12500", companyExternalId: "9100000001" };

  it("offers a won deal with an amount and a company, not linked yet", () => {
    expect(plannable(facts, "HubSpot")).toEqual({ ok: true });
  });

  it("says why any other cannot be planned", () => {
    expect(plannable({ ...facts, stage: "open" }, "HubSpot")).toEqual({ ok: false, reason: "Not won yet" });
    expect(plannable({ ...facts, sourceStatus: "deleted" }, "HubSpot")).toEqual({ ok: false, reason: "Deleted in HubSpot" });
    expect(plannable({ ...facts, dealId: "deal-1" }, "HubSpot")).toEqual({ ok: false, reason: "Planned already" });
    expect(plannable({ ...facts, amount: null }, "HubSpot")).toEqual({ ok: false, reason: "No amount in HubSpot" });
    expect(plannable({ ...facts, amount: "0" }, "HubSpot")).toEqual({ ok: false, reason: "No amount in HubSpot" });
    expect(plannable({ ...facts, companyExternalId: null }, "HubSpot")).toEqual({ ok: false, reason: "No company in HubSpot" });
  });
});

describe("crmChanges", () => {
  const baseline: CrmFacts = factsOf(deal());

  it("finds nothing when HubSpot still says what the deal was planned from", () => {
    expect(crmChanges(baseline, { ...factsOf(deal({ name: "Website rebuild v2" })), deleted: false }, "active")).toEqual([]);
    // An amount written another way is the same amount.
    expect(crmChanges(baseline, { ...baseline, amount: "12500.0", deleted: false }, "active")).toEqual([]);
  });

  it("names an amount changed, and its currency", () => {
    expect(crmChanges(baseline, { ...baseline, amount: "15000", deleted: false }, "active")).toEqual([
      { what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } },
    ]);
    expect(crmChanges(baseline, { ...baseline, currency: "EUR", deleted: false }, "active")).toEqual([
      { what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "12500", currency: "EUR" } },
    ]);
  });

  it("names a close day moved, and a won deal moved to lost or back to open", () => {
    expect(crmChanges(baseline, { ...baseline, closeOn: "2026-10-20", deleted: false }, "active")).toEqual([{ what: "close", from: "2026-10-01", to: "2026-10-20" }]);
    expect(crmChanges(baseline, { ...baseline, stage: "lost", stageLabel: "Closed Lost", deleted: false }, "active")).toEqual([
      { what: "stage", from: "won", to: "lost", label: "Closed Lost" },
    ]);
    expect(crmChanges(baseline, { ...baseline, stage: "open", stageLabel: "Contract Sent", deleted: false }, "active")).toEqual([
      { what: "stage", from: "won", to: "open", label: "Contract Sent" },
    ]);
  });

  it("says deleted alone when HubSpot no longer has the deal", () => {
    expect(crmChanges(baseline, { ...baseline, amount: "1", deleted: true }, "active")).toEqual([{ what: "deleted" }]);
  });

  it("says nothing for a cancelled deal, or a deal with no baseline", () => {
    expect(crmChanges(baseline, { ...baseline, stage: "lost", deleted: false }, "cancelled")).toEqual([]);
    expect(crmChanges(null, { ...baseline, stage: "lost", deleted: false }, "active")).toEqual([]);
  });
});

describe("crmChangeWords", () => {
  it("says each change in plain words, and that nothing is cancelled", () => {
    expect(crmChangeWords({ what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000.5", currency: "USD" } }, "HubSpot")).toBe(
      "Amount: 12,500 USD to 15,000.5 USD."
    );
    expect(crmChangeWords({ what: "close", from: "2026-10-01", to: "2026-10-20" }, "HubSpot")).toBe("Close date: Oct 1, 2026 to Oct 20, 2026.");
    expect(crmChangeWords({ what: "close", from: "2026-10-01", to: null }, "HubSpot")).toBe("Close date: Oct 1, 2026 to none.");
    expect(crmChangeWords({ what: "stage", from: "won", to: "lost", label: "Closed Lost" }, "HubSpot")).toBe(
      "Marked lost in HubSpot (Closed Lost). Nothing is cancelled: cancel the deal if it is off."
    );
    expect(crmChangeWords({ what: "stage", from: "won", to: "open", label: null }, "HubSpot")).toBe("Moved back to an open stage in HubSpot.");
    expect(crmChangeWords({ what: "deleted" }, "HubSpot")).toBe("Deleted in HubSpot. Nothing is cancelled: cancel the deal if it is off.");
  });

  it("never names a currency Vestiarion does not take", () => {
    expect(crmChangeWords({ what: "amount", from: { amount: "1", currency: "VND" }, to: { amount: "2", currency: "VND" } }, "HubSpot")).toBe("The amount changed in HubSpot.");
  });
});
