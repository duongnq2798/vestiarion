import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CounterpartyPurchaseOrdersEdit, { purchaseOrdersLabel } from "@/components/intake/CounterpartyPurchaseOrdersEdit";

/**
 * Whether a counterparty needs purchase orders, on its card on Counterparties (three-way match design M2): what the
 * card says, and who may change it.
 */

vi.mock("@/app/actions/intake", () => ({ updateCounterpartyPurchaseOrdersAction: vi.fn() }));

describe("CounterpartyPurchaseOrdersEdit", () => {
  it("offers Change, named for the counterparty for a screen reader", () => {
    const markup = renderToStaticMarkup(
      <CounterpartyPurchaseOrdersEdit orgSlug="acme" counterparty={{ id: "c1", name: "Centronex", purchaseOrderRequired: true }} />
    );
    expect(markup).toContain("Change");
    expect(markup).toContain('aria-label="Change whether Centronex needs purchase orders"');
  });
});

describe("purchaseOrdersLabel", () => {
  it("says a purchase order is needed, as for every counterparty by default", () => {
    expect(purchaseOrdersLabel(true)).toBe("Needed before the agent pays");
  });

  it("says when the counterparty is paid without them, and that the goods received still are", () => {
    expect(purchaseOrdersLabel(false)).toBe("Not needed · goods received still is");
  });
});

describe("the Counterparties page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "counterparties", "page.tsx"), "utf8");

  it("shows whether a vendor or contractor needs purchase orders, and not for a client, whose payables wait for a person", () => {
    expect(page).toMatch(/counterparty\.role !== "client" && \(\s*<div[^>]*>\s*<dt className="text-ink-3">Purchase orders<\/dt>/);
    expect(page).toContain("purchaseOrdersLabel(counterparty.purchase_order_required !== false)");
  });

  it("offers Change only to people who may add records", () => {
    expect(page).toMatch(/\{canWrite && \(\s*<CounterpartyPurchaseOrdersEdit/);
  });
});
