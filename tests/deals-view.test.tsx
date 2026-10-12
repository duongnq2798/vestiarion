import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/deals", () => ({ createDealAction: vi.fn(), changeDealAction: vi.fn(), releaseDealLineAction: vi.fn(), setDealAutoReleaseAction: vi.fn() }));
vi.mock("@/app/actions/payment-plan", () => ({ approvePlanAction: vi.fn() }));
vi.mock("@/app/actions/treasury", () => ({ refreshOnChainBalanceAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { DealChangeForm } from "@/components/deals/DealChangeForm";
import { DealForm } from "@/components/deals/DealForm";
import { DealSchedule, DealVersions } from "@/components/deals/DealSchedule";
import { DealsSection } from "@/components/deals/DealsSection";
import { PlanIncomingList } from "@/components/vx/PaymentPlan";
import type { DealRecord } from "@/lib/deals/read";
import { deal, line, released } from "./support/deal-facts";

/**
 * Deals as a person reads them (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): the Deals section with each
 * deal's figures, or that deals are not set up; a deal's schedule with each line's state, the rounding a line carries
 * and Release now only for someone who may release; its versions; the forms; and money expected kept apart from cash.
 */

const TODAY = "2026-11-01";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const record = (over: Partial<DealRecord> = {}): DealRecord => ({
  facts: deal([
    released({ id: "11111111-0000-4000-8000-000000000001", amountMinor: 300_000, receivable: { id: "inv-1", status: "received", dueDate: "2026-10-26T12:00:00Z" } }),
    line({ id: "11111111-0000-4000-8000-000000000002", position: 2, label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_001, roundingMinor: 1 }),
  ]),
  title: "Website rebuild",
  customer: { id: "c1c1c1c1-0000-4000-8000-0000000000c1", name: "Acme Studio" },
  digits: 2,
  externalRef: null,
  template: "deposit",
  createdBy: null,
  createdAt: "2026-10-12T09:00:00Z",
  autoReleaseBy: null,
  autoReleaseAt: null,
  versions: [{ version: 1, kind: "signed", totalMinor: 1_000_001, reason: null, changes: [], createdBy: null, createdAt: "2026-10-12T09:00:00Z" }],
  ...over,
});

describe("the Deals section", () => {
  it("says deals are not set up before the migration runs, and nothing else", () => {
    const shown = text(renderToStaticMarkup(<DealsSection deals="not_ready" orgSlug="acme" today={TODAY} />));
    expect(shown).toContain("Deals are not set up on this deployment yet.");
  });

  it("lists each deal with what was released, paid, is outstanding and planned, and its next line", () => {
    const shown = text(renderToStaticMarkup(<DealsSection deals={[record()]} orgSlug="acme" today={TODAY} />));
    expect(shown).toContain("Website rebuild");
    expect(shown).toContain("Acme Studio");
    expect(shown).toContain("Active");
    expect(shown).toMatch(/Released 3,000\.00 USDC/);
    expect(shown).toMatch(/Paid 3,000\.00 USDC/);
    expect(shown).toMatch(/Outstanding 0\.00 USDC/);
    expect(shown).toMatch(/Planned 7,000\.01 USDC/);
    expect(shown).toContain("Next: Balance on delivery, Dec 1, 2026");
  });

  it("invites a first deal when there is none", () => {
    expect(text(renderToStaticMarkup(<DealsSection deals={[]} orgSlug="acme" today={TODAY} />))).toContain("No deals yet");
  });
});

describe("a deal's schedule", () => {
  it("shows each line's state and the rounding a line carries, with Release now for someone who may release", () => {
    const markup = renderToStaticMarkup(<DealSchedule orgSlug="acme" deal={record()} today={TODAY} canWrite />);
    const shown = text(markup);
    expect(shown).toContain("Paid");
    expect(shown).toContain("Planned");
    expect(shown).toContain("Includes 0.01 from rounding");
    expect(shown).toContain("Release now");
    expect(shown).toContain("never cash");
    expect(text(renderToStaticMarkup(<DealSchedule orgSlug="acme" deal={record()} today={TODAY} canWrite={false} />))).not.toContain("Release now");
  });

  it("offers Release again for a line whose receivable was never made", () => {
    const orphan = record({ facts: deal([released({ id: "11111111-0000-4000-8000-000000000003", receivable: null })]) });
    expect(text(renderToStaticMarkup(<DealSchedule orgSlug="acme" deal={orphan} today={TODAY} canWrite />))).toContain("Release again");
  });

  it("lists its versions with their difference and changes", () => {
    const changed = record({
      versions: [
        ...record().versions,
        { version: 2, kind: "revised", totalMinor: 1_200_001, reason: "Extra page", changes: [{ what: "added", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 }], createdBy: null, createdAt: "2026-10-20T09:00:00Z" },
      ],
    });
    const shown = text(renderToStaticMarkup(<DealVersions deal={changed} />));
    expect(shown).toContain("Version 2");
    expect(shown).toContain("Changed");
    expect(shown).toContain("+ 2,000.00 USDC");
    expect(shown).toContain("Reason: Extra page");
    expect(shown).toContain("Adds Price change, 2,000.00 USDC, invoiced Dec 1, 2026");
  });
});

describe("the forms", () => {
  it("New deal offers the four templates, the automatic release, and carries its key", () => {
    const markup = renderToStaticMarkup(<DealForm orgSlug="acme" customers={[{ id: "c1", name: "Acme Studio" }]} currencies={["USDC", "EURC"]} idempotencyKey="key-12345678" today="2026-10-12" />);
    const shown = text(markup);
    for (const words of ["Deposit and balance", "Equal milestones", "Monthly retainer", "Custom lines", "Release each line on its invoice day", "Confirm deal"]) expect(shown).toContain(words);
    expect(markup).toContain('name="idempotencyKey" value="key-12345678"');
  });

  it("Change deal starts from the lines not invoiced yet, never a released one", () => {
    const markup = renderToStaticMarkup(<DealChangeForm orgSlug="acme" facts={record().facts} digits={2} today={TODAY} idempotencyKey="key-12345678" mode="revised" />);
    expect(markup).toContain('value="Balance on delivery"');
    expect(markup).not.toContain('value="Deposit (30%)"');
    expect(text(markup)).toContain("Save as version 2");
    expect(text(markup)).toContain("Propose a correction");
  });
});

describe("money expected in, on the payment plan", () => {
  it("lists receivables due and planned deal lines apart, and says they are not cash", () => {
    const shown = text(
      renderToStaticMarkup(
        <PlanIncomingList
          incoming={{
            expected: [{ id: "r1", from: "Acme Studio", what: "Website rebuild: Deposit (30%)", amount: 3000, currency: "USDC", on: "2026-10-15", overdue: false }],
            planned: [{ id: "p1", from: "Acme Studio: Website rebuild", what: "Balance on delivery", amount: 7000, currency: "USDC", on: "2026-10-20", overdue: false }],
            expectedUsdc: 3000,
            plannedUsdc: 7000,
            plannedRead: true,
          }}
        />
      )
    );
    expect(shown).toContain("Money expected in");
    expect(shown).toContain("money expected is not cash until it arrives");
    expect(shown).toContain("Planned from deals");
    expect(shown).toContain("Balance on delivery");
  });
});

describe("where deals are wired", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("Bills & receivables reads the deals best effort, names each receivable's deal and hands the plan the planned lines", () => {
    const page = read("src/app/o/[slug]/invoices/page.tsx");
    expect(page).toMatch(/readDeals\(\)\.catch/);
    expect(page).toContain("<DealsSection");
    expect(page).toContain("dealLinksOf(deals)");
    expect(page).toContain("plannedLinesOf(deals)");
  });

  it("Treasury hands the outlook and the scenarios the planned lines", () => {
    expect(read("src/app/o/[slug]/console/page.tsx")).toContain("readPlannedDealLines()");
  });
});
