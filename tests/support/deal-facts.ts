import type { DealFacts, DealLine } from "@/lib/deals/lines";

/** Deal lines and deals for the tests of the pure deal modules. */

export function line(over: Partial<DealLine> = {}): DealLine {
  return {
    id: "line-1",
    position: 1,
    kind: "charge",
    label: "Deposit (30%)",
    invoiceOn: "2026-10-12",
    dueOn: "2026-10-26",
    amountMinor: 300_000,
    roundingMinor: 0,
    status: "planned",
    addedIn: 1,
    endedIn: null,
    replaces: null,
    releasedAt: null,
    releasedVia: null,
    receivable: null,
    ...over,
  };
}

export function deal(lines: DealLine[], over: Partial<DealFacts> = {}): DealFacts {
  return {
    id: "deal-1",
    status: "active",
    version: 1,
    totalMinor: lines.filter((each) => each.status === "planned" || each.status === "released").reduce((sum, each) => sum + each.amountMinor, 0),
    currency: "USDC",
    startsOn: "2026-10-12",
    termsDays: 14,
    autoRelease: false,
    lines,
    ...over,
  };
}

export const released = (over: Partial<DealLine> = {}) =>
  line({ status: "released", releasedAt: "2026-10-12T09:00:00Z", releasedVia: "person", receivable: { id: "inv-1", status: "pending", dueDate: "2026-10-26T12:00:00Z" }, ...over });
