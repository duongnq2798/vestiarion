import type { DealRecord } from "@/lib/deals/read";

/**
 * The deal the deals guide's pictures show (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): Website rebuild
 * for Acme Studio, signed for 10,000.01 USDC as a 30% deposit and the balance on delivery, then changed to 12,000.01 USDC
 * with a price change line. The deposit was released and paid; the balance and the price change are planned.
 */

export const DEALS_SHOT_TODAY = "2026-11-02";

const DEAL_ID = "dddddddd-0000-4000-8000-0000000000d1";
type Line = DealRecord["facts"]["lines"][number];

const line = (id: string, over: Partial<Line>): Line => ({
  id: `11111111-0000-4000-8000-00000000000${id}`,
  position: 1,
  kind: "charge",
  label: "",
  invoiceOn: "2026-10-12",
  dueOn: "2026-10-26",
  amountMinor: 0,
  roundingMinor: 0,
  status: "planned",
  addedIn: 1,
  endedIn: null,
  replaces: null,
  releasedAt: null,
  releasedVia: null,
  receivable: null,
  ...over,
});

export function dealShot(): DealRecord {
  return {
    facts: {
      id: DEAL_ID,
      status: "active",
      version: 2,
      totalMinor: 1_200_001,
      currency: "USDC",
      startsOn: "2026-10-12",
      termsDays: 14,
      autoRelease: true,
      lines: [
        line("1", {
          label: "Deposit (30%)",
          amountMinor: 300_000,
          status: "released",
          releasedAt: "2026-10-12T09:00:00Z",
          releasedVia: "person",
          receivable: { id: "eeeeeeee-0000-4000-8000-0000000000e1", status: "received", dueDate: "2026-10-26T12:00:00Z" },
        }),
        line("2", { position: 2, label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_001, roundingMinor: 1 }),
        line("3", { position: 3, label: "Price change", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 200_000, addedIn: 2 }),
      ],
    },
    title: "Website rebuild",
    customer: { id: "c1c1c1c1-0000-4000-8000-0000000000c1", name: "Acme Studio" },
    digits: 2,
    externalRef: "HS-48213",
    template: "deposit",
    createdBy: null,
    createdAt: "2026-10-12T09:00:00Z",
    autoReleaseBy: null,
    autoReleaseAt: "2026-10-12T09:00:00Z",
    versions: [
      { version: 1, kind: "signed", totalMinor: 1_000_001, reason: null, changes: [], createdBy: null, createdAt: "2026-10-12T09:00:00Z" },
      {
        version: 2,
        kind: "revised",
        totalMinor: 1_200_001,
        reason: "Extra landing page agreed on Oct 30",
        changes: [{ what: "added", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 }],
        createdBy: null,
        createdAt: "2026-10-30T10:00:00Z",
      },
    ],
  };
}
