import { describe, expect, it } from "vitest";
import { deliverableKeys, purchaseOrderKey, sameWorkMatches, type WorkItem } from "@/lib/projects/same-work";

/**
 * The same purchase order or delivered work as a bill and a milestone (docs/superpowers/specs/2026-10-13-project-budgets-
 * design.md P9): the second of the two is found, the first goes as usual, and an ended one is no obligation.
 */

const milestone = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  kind: "milestone",
  id: "m1",
  counterpartyId: "lan",
  label: "Design phase",
  poReference: "PO-1042",
  evidence: "https://github.com/acme/site/pull/12",
  status: "verified",
  createdAt: "2026-10-10T09:00:00Z",
  ...overrides,
});

const bill = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  kind: "bill",
  id: "b1",
  counterpartyId: "lan",
  label: "Design phase invoice",
  poReference: "po 1042",
  evidence: "Design phase invoice",
  status: "pending",
  createdAt: "2026-10-12T09:00:00Z",
  ...overrides,
});

describe("purchaseOrderKey", () => {
  it("reads a purchase order however it is written", () => {
    expect(purchaseOrderKey("PO-1042")).toBe("1042");
    expect(purchaseOrderKey("po 1042")).toBe("1042");
    expect(purchaseOrderKey(" 1042 ")).toBe("1042");
    expect(purchaseOrderKey("PO")).toBeNull();
    expect(purchaseOrderKey(null)).toBeNull();
  });
});

describe("deliverableKeys", () => {
  it("reads the web addresses in text as the work they name", () => {
    expect(deliverableKeys("Done: https://www.GitHub.com/Acme/Site/pull/12/files?diff=split#top, and http://example.com/report/.")).toEqual([
      "github.com/acme/site/pull/12",
      "example.com/report",
    ]);
    expect(deliverableKeys("timesheet")).toEqual([]);
    expect(deliverableKeys("https://example.com/")).toEqual([]);
    expect(deliverableKeys(null)).toEqual([]);
  });
});

describe("sameWorkMatches", () => {
  it("finds the earlier milestone a bill repeats by purchase order, for the same payee", () => {
    const [match] = sameWorkMatches(bill(), [milestone()]);
    expect(match).toMatchObject({ otherKind: "milestone", otherId: "m1", signal: "purchase_order", reference: "po 1042" });
    expect(match.explanation).toBe('This bill names purchase order po 1042, as the milestone "Design phase" for the same payee does (verified): paying both would pay that order twice.');
  });

  it("does not match a purchase order of another payee", () => {
    expect(sameWorkMatches(bill(), [milestone({ counterpartyId: "other", evidence: null })])).toEqual([]);
  });

  it("finds the same delivered work, whoever bills it", () => {
    const [match] = sameWorkMatches(bill({ poReference: null, counterpartyId: "agency", evidence: "Work in https://github.com/acme/site/pull/12/commits" }), [milestone()]);
    expect(match).toMatchObject({ signal: "deliverable", reference: "github.com/acme/site/pull/12" });
    expect(match.explanation).toContain("points at the same delivered work, github.com/acme/site/pull/12");
  });

  it("finds only the earlier one: of the two, the first goes as usual", () => {
    expect(sameWorkMatches(milestone(), [bill()])).toEqual([]);
    expect(sameWorkMatches(milestone({ createdAt: "2026-10-13T09:00:00Z" }), [bill()])).toHaveLength(1);
    // The same moment: the lower id is the first.
    expect(sameWorkMatches(bill({ id: "b0", createdAt: "2026-10-10T09:00:00Z" }), [milestone()])).toEqual([]);
    expect(sameWorkMatches(bill({ id: "z9", createdAt: "2026-10-10T09:00:00Z" }), [milestone()])).toHaveLength(1);
    expect(sameWorkMatches(milestone(), [bill({ id: "z9", createdAt: "2026-10-10T09:00:00Z" })])).toEqual([]);
  });

  it("leaves a rejected bill or a closed milestone out, and never compares two of one kind", () => {
    expect(sameWorkMatches(bill(), [milestone({ status: "closed" })])).toEqual([]);
    expect(sameWorkMatches(milestone({ createdAt: "2026-10-13T09:00:00Z" }), [bill({ status: "rejected" })])).toEqual([]);
    expect(sameWorkMatches(bill(), [bill({ id: "b0", createdAt: "2026-10-01T09:00:00Z" })])).toEqual([]);
  });

  it("counts a paid one: paying the second would pay the work twice", () => {
    expect(sameWorkMatches(bill(), [milestone({ status: "paid" })])).toHaveLength(1);
  });
});
