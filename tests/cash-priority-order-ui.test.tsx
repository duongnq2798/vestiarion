import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Which bill first, on the Payment plan tab (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md O1, O2): the
 * order with each bill paid first or waiting against the cash, its reason, who set it and what the written policy would
 * pay first; Up and Down and saving only for those who decide payments.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/cash-priority", () => ({ setCashPriorityOrderAction: vi.fn() }));

const { CashPriorityOrder } = await import("@/components/vx/CashPriorityOrder");

const bills = [
  { id: "a", payee: "Cobalt Cloud", amount: 50, due: "Oct 17, 2026", reason: "The production database backups stop if unpaid." },
  { id: "b", payee: "Lumen Print Co.", amount: 4, due: "Oct 18, 2026", reason: "Small and nearly due." },
  { id: "c", payee: "Cobalt Cloud", amount: 30, due: "Oct 17, 2026", reason: "A one-off project can wait." },
];

const render = (canSet: boolean) =>
  renderToStaticMarkup(
    <CashPriorityOrder
      orgSlug="pinecrest-studio"
      fingerprint={"f".repeat(32)}
      basedOn="2026-10-17T21:44:00Z"
      available={57.03}
      bills={bills}
      setLabel="Set by the agent on Oct 17, 2026"
      policyFirst={["Cobalt Cloud", "Lumen Print Co."]}
      canSet={canSet}
    />
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");

describe("CashPriorityOrder", () => {
  it("shows the order with what the cash covers, the reasons, who set it and the written policy's first bills", () => {
    const text = render(true);
    expect(text).toContain("Which bill first");
    expect(text).toContain("Set by the agent on Oct 17, 2026");
    expect(text).toContain("The cash, 57.03 USDC after what is already committed, cannot cover every bill due soon.");
    expect(text).toContain("The written policy would pay Cobalt Cloud, Lumen Print Co. first.");
    // 50 + 4 fit 57.03; the 30 after them waits.
    expect(text).toContain("1. Cobalt Cloud 50.00 USDC Paid first");
    expect(text).toContain("2. Lumen Print Co. 4.00 USDC Paid first");
    expect(text).toContain("3. Cobalt Cloud 30.00 USDC Waits");
    expect(text).toContain("The production database backups stop if unpaid.");
  });

  it("offers Up, Down and saving only to those who decide payments", () => {
    const deciding = render(true);
    expect(deciding).toContain("Use this order");
    expect(deciding).toContain("Up");
    expect(deciding).toContain("It never pays more than the cash holds");
    const reading = render(false);
    expect(reading).not.toContain("Use this order");
    expect(reading).toContain("An owner, admin or approver can change the order.");
  });
});
