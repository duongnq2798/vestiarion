import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/accounting", () => ({ addAccountingBillsAction: vi.fn(), dismissAccountingBillsAction: vi.fn() }));
import { AccountingBillsReview, reviewSelection } from "@/components/AccountingBillsReview";
import type { ReviewRowView } from "@/lib/connectors/review";

/**
 * The bills an accounting tool brought in start unticked (Bills & receivables tabs B12): a recorded demo added every bill
 * on the list, a 2,500 USD one included, with one click on Add, because each started ticked. Nothing is ticked until a
 * person ticks it, one by one or with Select all; the server's checks are unchanged.
 */

const row = (id: string, status: ReviewRowView["status"] = "add"): ReviewRowView =>
  ({ id, supplier: `Supplier ${id}`, number: `B-${id}`, amount: "2500", currency: "USD", dueOn: "2026-10-28", status, reason: status === "add" ? undefined : "Already added" }) as ReviewRowView;

describe("AccountingBillsReview", () => {
  it("starts with no bill ticked, so Add adds nothing until a person chooses", () => {
    const markup = renderToStaticMarkup(
      <AccountingBillsReview provider="xero" orgSlug="acme" connectionId="conn-1" organisation="Demo Company" items={[row("1"), row("2")]} closed={[]} canAdd />
    );
    expect(markup).not.toMatch(/role="checkbox"[^>]*aria-checked="true"/);
    expect(markup.match(/role="checkbox"[^>]*aria-checked="false"/g)?.length).toBe(3);
    expect(markup).toContain("Select all");
    // Every action names no bill, and is off.
    expect(markup).not.toContain('name="billId"');
    expect(markup.match(/<button[^>]*disabled=""[^>]*>/g)?.length).toBe(3);
  });

  it("shows Select all only to someone who adds records, with bills that can be added", () => {
    const viewer = renderToStaticMarkup(<AccountingBillsReview provider="xero" orgSlug="acme" connectionId="conn-1" organisation={null} items={[row("1")]} closed={[]} canAdd={false} />);
    expect(viewer).not.toContain("Select all");
    const none = renderToStaticMarkup(<AccountingBillsReview provider="xero" orgSlug="acme" connectionId="conn-1" organisation={null} items={[row("1", "duplicate")]} closed={[]} canAdd />);
    expect(none).not.toContain("Select all");
  });

  it("says where to look at a bill closed in the tool after it was added", () => {
    const markup = renderToStaticMarkup(
      <AccountingBillsReview provider="xero" orgSlug="acme" connectionId="conn-1" organisation={null} items={[]} closed={[{ id: "r", supplier: "Hicks", number: "H-1", sourceStatus: "voided" }]} canAdd />
    );
    expect(markup).toContain("Look at it in Bills before the agent pays it.");
  });
});

describe("reviewSelection", () => {
  it("ticks every bill that can be added, or none, and says whether all, some or none are ticked", () => {
    const addable = ["1", "2", "3"];
    expect(reviewSelection(new Set(), addable)).toBe(false);
    expect(reviewSelection(new Set(["1"]), addable)).toBe("indeterminate");
    expect(reviewSelection(new Set(["1", "2", "3"]), addable)).toBe(true);
    expect(reviewSelection(new Set(["1", "2", "3", "dup"]), addable)).toBe(true);
  });
});
