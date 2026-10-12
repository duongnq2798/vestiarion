import { describe, expect, it } from "vitest";
import { readChangeForm, readDealForm, type DealFormFields } from "@/lib/deals/input";

/**
 * The New deal and Change deal forms, read the same way in the browser and on the server
 * (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D2-D6, D12).
 */

const CUSTOMER = "018f8ce0-1557-7b54-a931-4d777f6bf001";

const fields = (over: Partial<DealFormFields> = {}): DealFormFields => ({
  customerId: CUSTOMER,
  customerName: "",
  title: "Website rebuild",
  currency: "USDC",
  total: "10,000.00",
  startsOn: "2026-10-12",
  termsDays: "14",
  externalRef: "",
  template: "deposit",
  depositPct: "30",
  deliveryOn: "2026-12-01",
  milestones: "[]",
  months: "",
  dayOfMonth: "",
  lines: "[]",
  edited: "",
  autoRelease: false,
  idempotencyKey: "4f7c2b1e-1d8a-4b4e-9b0f-1c2d3e4f5a6b",
  ...over,
});

describe("readDealForm", () => {
  it("builds the template's schedule when the lines were not edited", () => {
    const result = readDealForm(fields(), { shadowOn: false });
    if (!result.ok) throw new Error(result.message);
    expect(result.draft).toMatchObject({ customer: { id: CUSTOMER }, currency: "USDC", digits: 2, totalMinor: 1_000_000, termsDays: 14, template: "deposit", externalRef: null });
    expect(result.draft.lines.map((line) => line.amountMinor)).toEqual([300_000, 700_000]);
  });

  it("takes edited lines as typed, keeping the rounding only of the line still as built", () => {
    const posted = [
      { label: "Deposit (30%)", invoiceOn: "2026-10-12", amountMinor: 30_000 },
      { label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 70_001 },
    ];
    const kept = readDealForm(fields({ total: "1000.01", edited: "1", lines: JSON.stringify(posted) }), { shadowOn: false });
    if (!kept.ok) throw new Error(kept.message);
    expect(kept.draft.lines.map((line) => line.roundingMinor)).toEqual([0, 1]);
    const moved = readDealForm(fields({ total: "1000.01", edited: "1", lines: JSON.stringify([posted[0], { ...posted[1], invoiceOn: "2026-12-05" }]) }), { shadowOn: false });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.draft.lines[1]).toMatchObject({ invoiceOn: "2026-12-05", dueOn: "2026-12-19", roundingMinor: 0 });
  });

  it("refuses edited lines that do not add up, on the total", () => {
    const result = readDealForm(fields({ edited: "1", lines: JSON.stringify([{ label: "All", invoiceOn: "2026-10-12", amountMinor: 900_000 }]) }), { shadowOn: false });
    expect(result).toMatchObject({ ok: false, field: "total" });
  });

  it("takes a new customer by name", () => {
    const result = readDealForm(fields({ customerId: "new", customerName: "  Northwind Labs " }), { shadowOn: false });
    expect(result.ok && result.draft.customer).toEqual({ name: "Northwind Labs" });
    expect(readDealForm(fields({ customerId: "new", customerName: "N" }), { shadowOn: false })).toMatchObject({ ok: false, field: "customerName" });
  });

  it("takes the business's own currency in shadow mode only, never VND, in its own minor unit", () => {
    expect(readDealForm(fields({ currency: "JPY", total: "1,000,000" }), { shadowOn: false })).toMatchObject({ ok: false, field: "currency" });
    const yen = readDealForm(fields({ currency: "JPY", total: "1,000,000" }), { shadowOn: true });
    expect(yen.ok && [yen.draft.digits, yen.draft.totalMinor]).toEqual([0, 1_000_000]);
    expect(readDealForm(fields({ currency: "VND", total: "1000000" }), { shadowOn: true })).toMatchObject({ ok: false, field: "currency" });
  });

  it("names the field in the way", () => {
    expect(readDealForm(fields({ title: " " }), { shadowOn: false })).toMatchObject({ ok: false, field: "title" });
    expect(readDealForm(fields({ total: "1.005" }), { shadowOn: false })).toMatchObject({ ok: false, field: "total" });
    expect(readDealForm(fields({ termsDays: "400" }), { shadowOn: false })).toMatchObject({ ok: false, field: "termsDays" });
    expect(readDealForm(fields({ deliveryOn: "" }), { shadowOn: false })).toMatchObject({ ok: false, field: "deliveryOn" });
    expect(readDealForm(fields({ idempotencyKey: "x" }), { shadowOn: false })).toMatchObject({ ok: false, field: "idempotencyKey" });
    expect(readDealForm(fields({ template: "monthly" }), { shadowOn: false })).toMatchObject({ ok: false, field: "template" });
  });

  it("reads a retainer and milestones from their own fields", () => {
    const retainer = readDealForm(fields({ template: "retainer", months: "12", dayOfMonth: "31", total: "60000" }), { shadowOn: false });
    expect(retainer.ok && retainer.draft.lines).toHaveLength(12);
    const milestones = readDealForm(
      fields({ template: "milestones", milestones: JSON.stringify([{ invoiceOn: "2026-10-12" }, { invoiceOn: "2026-11-12", label: "Build" }, { invoiceOn: "2026-12-12" }]) }),
      { shadowOn: false }
    );
    expect(milestones.ok && milestones.draft.lines.map((line) => line.label)).toEqual(["Milestone 1 of 3", "Build", "Milestone 3 of 3"]);
  });
});

describe("readChangeForm", () => {
  const change = (over: Record<string, string> = {}) => ({
    dealId: CUSTOMER,
    baseVersion: "1",
    kind: "revised",
    total: "12,000.00",
    reason: "Extra page",
    lines: JSON.stringify([{ id: CUSTOMER, kind: "charge", label: "Balance", invoiceOn: "2026-12-01", amountMinor: 700_000 }, { kind: "charge", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 }]),
    idempotencyKey: "4f7c2b1e-1d8a-4b4e-9b0f-1c2d3e4f5a6b",
    ...over,
  });

  it("reads the new total and the proposed lines", () => {
    const result = readChangeForm(change(), "USDC");
    if (!result.ok) throw new Error(result.message);
    expect(result.change).toMatchObject({ baseVersion: 1, kind: "revised", totalMinor: 1_200_000, reason: "Extra page" });
    expect(result.change.lines).toHaveLength(2);
    expect(result.change.lines[1].id).toBeUndefined();
  });

  it("reads a cancel with no total and no lines", () => {
    const result = readChangeForm(change({ kind: "cancelled", total: "", lines: "" }), "USDC");
    expect(result.ok && result.change).toMatchObject({ kind: "cancelled", totalMinor: null, lines: [] });
  });

  it("refuses a malformed line, an unknown kind and a missing key", () => {
    expect(readChangeForm(change({ lines: JSON.stringify([{ kind: "charge", label: "X", invoiceOn: "2026-12-01", amountMinor: 1.5 }]) }), "USDC")).toMatchObject({ ok: false });
    expect(readChangeForm(change({ kind: "deleted" }), "USDC")).toMatchObject({ ok: false });
    expect(readChangeForm(change({ idempotencyKey: "" }), "USDC")).toMatchObject({ ok: false });
  });
});
