import { describe, expect, it } from "vitest";
import { planCancel, planRevision, proposeCorrection, type ProposedLine } from "@/lib/deals/revision";
import { deal, line, released } from "./support/deal-facts";

/**
 * A change to a signed deal is a new version (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7-D9): it ends
 * planned lines and adds new ones, never touches a released or paid line, shows the difference, and proposes a
 * correcting line for a price change.
 */

const TODAY = "2026-11-01";

/** 10,000.00 USDC: the 30% deposit released and paid, the 70% balance planned for December 1. */
const signed = () =>
  deal([
    released({ id: "deposit", amountMinor: 300_000, receivable: { id: "inv-1", status: "received", dueDate: "2026-10-26T12:00:00Z" } }),
    line({ id: "balance", position: 2, label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_000 }),
  ]);

const kept = (lines: ProposedLine[]) => lines.map(({ id, kind, label, invoiceOn, amountMinor }) => ({ id, kind, label, invoiceOn, amountMinor }));

describe("a price change after the deposit was paid", () => {
  it("proposes a correcting line for a higher price, on the last planned line's day", () => {
    const proposal = proposeCorrection(signed(), 1_200_000, TODAY);
    expect(kept(proposal)).toEqual([
      { id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 700_000 },
      { id: undefined, kind: "charge", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 },
    ]);
    const result = planRevision(signed(), { kind: "revised", totalMinor: 1_200_000, lines: proposal });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision).toMatchObject({ fromTotalMinor: 1_000_000, toTotalMinor: 1_200_000, differenceMinor: 200_000, toVersion: 2, end: [] });
    expect(result.revision.add).toEqual([
      { position: 3, kind: "charge", label: "Price change", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 200_000, roundingMinor: 0, replaces: null },
    ]);
    // The paid deposit is neither ended nor added again: nothing paid is rewritten.
    expect(JSON.stringify(result.revision)).not.toContain('"deposit"');
  });

  it("reduces the planned balance for a lower price, as a new line replacing it", () => {
    const proposal = proposeCorrection(signed(), 800_000, TODAY);
    expect(kept(proposal)).toEqual([{ id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 500_000 }]);
    const result = planRevision(signed(), { kind: "revised", totalMinor: 800_000, lines: proposal });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision.end).toEqual([{ id: "balance", status: "superseded" }]);
    expect(result.revision.add).toMatchObject([{ label: "Balance on delivery", amountMinor: 500_000, replaces: "balance" }]);
    expect(result.revision.changes).toEqual([{ what: "amount", lineId: "balance", label: "Balance on delivery", fromMinor: 700_000, toMinor: 500_000 }]);
  });

  it("cancels the balance and records a credit when the price falls below what was invoiced", () => {
    const proposal = proposeCorrection(signed(), 200_000, TODAY);
    expect(kept(proposal)).toEqual([{ id: undefined, kind: "credit", label: "Credit for price change", invoiceOn: TODAY, amountMinor: -100_000 }]);
    const result = planRevision(signed(), { kind: "revised", totalMinor: 200_000, lines: proposal });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision.end).toEqual([{ id: "balance", status: "cancelled" }]);
    expect(result.revision.add).toMatchObject([{ kind: "credit", amountMinor: -100_000, dueOn: "2026-11-15" }]);
    expect(result.revision.changes.map((change) => change.what)).toEqual(["removed", "credit"]);
  });

  it("takes a credit back first when the price rises again", () => {
    const credited = deal([...signed().lines.slice(0, 1), line({ id: "credit", position: 3, kind: "credit", label: "Credit for price change", amountMinor: -100_000, invoiceOn: TODAY })]);
    expect(kept(proposeCorrection(credited, 250_000, TODAY))).toEqual([{ id: "credit", kind: "credit", label: "Credit for price change", invoiceOn: TODAY, amountMinor: -50_000 }]);
    expect(kept(proposeCorrection(credited, 400_000, TODAY))).toEqual([{ id: undefined, kind: "charge", label: "Price change", invoiceOn: TODAY, amountMinor: 100_000 }]);
  });

  it("goes by invoice day, not by the order lines were added, once a line was moved", () => {
    // The deposit moved from Oct 12 to Oct 20 (version 2): its new line comes after the balance, yet is invoiced first.
    const moved = deal(
      [
        line({ id: "deposit", amountMinor: 300_000, status: "superseded", endedIn: 2 }),
        line({ id: "balance", position: 2, label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_000 }),
        line({ id: "deposit-2", position: 3, invoiceOn: "2026-10-20", dueOn: "2026-11-03", amountMinor: 300_000, addedIn: 2, replaces: "deposit" }),
      ],
      { version: 2 }
    );
    // A higher price is invoiced with the last line, on delivery, not with the deposit.
    expect(kept(proposeCorrection(moved, 1_200_000, "2026-10-13")).at(-1)).toEqual({ id: undefined, kind: "charge", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 });
    // A lower price comes off the last line invoiced, the balance, before the deposit.
    expect(kept(proposeCorrection(moved, 900_000, "2026-10-13"))).toEqual([
      { id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 600_000 },
      { id: "deposit-2", kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-20", amountMinor: 300_000 },
    ]);
  });
});

describe("planRevision", () => {
  it("moves a milestone: the old line is superseded by one on its new day", () => {
    const result = planRevision(signed(), {
      kind: "revised",
      totalMinor: 1_000_000,
      lines: [{ id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-20", amountMinor: 700_000 }],
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision.end).toEqual([{ id: "balance", status: "superseded" }]);
    expect(result.revision.add).toMatchObject([{ invoiceOn: "2026-12-20", dueOn: "2027-01-03", replaces: "balance", position: 3 }]);
    expect(result.revision.changes).toEqual([{ what: "moved", lineId: "balance", label: "Balance on delivery", from: "2026-12-01", to: "2026-12-20" }]);
    expect(result.revision.differenceMinor).toBe(0);
  });

  it("never rewrites a released line, even unchanged in the proposal", () => {
    const result = planRevision(signed(), {
      kind: "revised",
      totalMinor: 1_000_000,
      lines: [
        { id: "deposit", kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-20", amountMinor: 300_000 },
        { id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 400_000 },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: "released_line" });
  });

  it("refuses lines that do not add up to the new total, an unknown line, and no change at all", () => {
    expect(planRevision(signed(), { kind: "revised", totalMinor: 1_100_000, lines: [{ id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 700_000 }] })).toMatchObject({
      ok: false,
      code: "sum",
    });
    expect(planRevision(signed(), { kind: "revised", totalMinor: 1_000_000, lines: [{ id: "gone", kind: "charge", label: "X", invoiceOn: "2026-12-01", amountMinor: 700_000 }] })).toMatchObject({
      ok: false,
      code: "unknown_line",
    });
    expect(planRevision(signed(), { kind: "revised", totalMinor: 1_000_000, lines: [{ id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 700_000 }] })).toMatchObject({
      ok: false,
      code: "no_change",
    });
  });

  it("refuses a credit beyond what was invoiced, and a change to a cancelled deal", () => {
    expect(
      planRevision(signed(), {
        kind: "revised",
        totalMinor: 900_000,
        lines: [
          { id: "balance", kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 1_000_000 },
          { kind: "credit", label: "Goodwill", invoiceOn: TODAY, amountMinor: -400_000 },
        ],
      })
    ).toMatchObject({ ok: false, code: "credit" });
    expect(planRevision({ ...signed(), status: "cancelled" }, { kind: "revised", totalMinor: 1_000_000, lines: [] })).toMatchObject({ ok: false, code: "status" });
  });

  it("adds and removes lines, each said in the changes", () => {
    const result = planRevision(signed(), {
      kind: "revised",
      totalMinor: 1_000_000,
      lines: [
        { kind: "charge", label: "Design", invoiceOn: "2026-11-15", amountMinor: 350_000 },
        { kind: "charge", label: "Build", invoiceOn: "2026-12-15", amountMinor: 350_000 },
      ],
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision.end).toEqual([{ id: "balance", status: "cancelled" }]);
    expect(result.revision.add.map((added) => [added.position, added.label])).toEqual([
      [3, "Design"],
      [4, "Build"],
    ]);
    expect(result.revision.changes.map((change) => change.what)).toEqual(["removed", "added", "added"]);
  });
});

describe("cancel and reopen", () => {
  it("cancel stops the planned lines and keeps what was released", () => {
    const result = planCancel(signed());
    if (!result.ok) throw new Error(result.message);
    expect(result.revision).toMatchObject({ kind: "cancelled", toTotalMinor: 300_000, differenceMinor: -700_000, end: [{ id: "balance", status: "cancelled" }], add: [] });
  });

  it("cannot cancel a cancelled deal", () => {
    expect(planCancel({ ...signed(), status: "cancelled" })).toMatchObject({ ok: false, code: "status" });
  });

  it("reopens a cancelled deal with new lines for what is left", () => {
    const cancelled = deal([signed().lines[0], line({ id: "balance", position: 2, status: "cancelled", endedIn: 2, amountMinor: 700_000 })], { status: "cancelled", version: 2 });
    const result = planRevision(cancelled, { kind: "reopened", totalMinor: 900_000, lines: [{ kind: "charge", label: "Reduced scope", invoiceOn: "2026-12-10", amountMinor: 600_000 }] });
    if (!result.ok) throw new Error(result.message);
    expect(result.revision).toMatchObject({ kind: "reopened", fromVersion: 2, toVersion: 3, fromTotalMinor: 300_000, toTotalMinor: 900_000, end: [] });
    expect(planRevision(cancelled, { kind: "reopened", totalMinor: 300_000, lines: [] })).toMatchObject({ ok: false, code: "no_lines" });
  });
});
