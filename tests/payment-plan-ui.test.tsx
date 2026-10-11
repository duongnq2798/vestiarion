import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/payment-plan", () => ({ approvePlanAction: vi.fn() }));
vi.mock("@/app/actions/treasury", () => ({ refreshOnChainBalanceAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PaymentPlanSection } from "@/components/vx/PaymentPlan";
import { planPayments, type PaymentPlanInput, type PlanBill } from "@/lib/payment-plan";
import type { PlanOutcomes } from "@/lib/payment-plan-outcomes";

/**
 * Bills & receivables' payment plan as a person reads it (docs/superpowers/specs/2026-10-11-payment-plan-design.md P1,
 * P9, P10, P12, P14): the lines and why each is on its day, Approve for someone who approves payments and never on
 * their own bill, approving off with the reason while the balance is stale, and every projection said to be one.
 */

const NOW = Date.UTC(2026, 9, 11, 9, 0);
const VIEWER = "u-viewer";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const bill = (fields: Partial<PlanBill>): PlanBill => ({
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyId: "c-1",
  payee: "Northwind Supply",
  payeeAddress: "0xabc",
  amount: 1000,
  currency: "USDC",
  dueDate: "2026-10-22T12:00:00.000Z",
  status: "scheduled",
  scheduledFor: "2026-10-22T00:00:00.000Z",
  discount: { pct: 2, deadline: "2026-10-15T12:00:00.000Z" },
  paymentLimit: null,
  riskLevel: "clear",
  createdBy: "u-maker",
  ...fields,
});

const planOf = (fields: Partial<PaymentPlanInput> = {}) =>
  planPayments({
    now: NOW,
    operatingUsdc: 2000,
    reserveUsdc: 0,
    reserveApy: 0,
    cushion: 150,
    bills: [
      bill({}),
      bill({ id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a2", payee: "Harbor Office Supply", counterpartyId: "c-2", amount: 300, createdBy: VIEWER }),
      bill({ id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a3", payee: "Atlas Compute", counterpartyId: "c-3", amount: 200, status: "held", scheduledFor: null, discount: null, dueDate: "2026-10-13T12:00:00.000Z" }),
      bill({ id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a4", payee: "Copy Cat", counterpartyId: "c-4", amount: 90, status: "flagged", scheduledFor: null, discount: null }),
    ],
    milestones: [],
    limits: { budget: null, twoApprovalsAbove: null },
    balance: { kind: "simulated" },
    unread: [],
    ...fields,
  });

const OUTCOMES: PlanOutcomes = { paid: 6, paidOnTime: 5, overdueNow: 1, discountsTaken: 12.5, moves: 2 };

const render = (props: Partial<Parameters<typeof PaymentPlanSection>[0]> = {}) =>
  renderToStaticMarkup(<PaymentPlanSection plan={planOf()} outcomes={OUTCOMES} orgSlug="northstar" canDecide viewerId={VIEWER} {...props} />);

describe("the payment plan section", () => {
  it("lists each day's bills with why, the balance after and the discount the day takes, as an estimate", () => {
    const words = text(render());
    expect(words).toContain("Payment plan");
    expect(words).toContain("the next 14 days, in the order the cash allows");
    expect(words).toContain("Oct 15, 2026");
    expect(words).toContain("Pays on Oct 15, 2026, the discount's last day, to take the 2% early-payment discount (20.00 USDC); the balance stays above the cushion.");
    expect(words).toContain("The agent scheduled it for Oct 22, 2026");
    expect(words).toContain("Takes the 2% discount, 20.00 USDC , if paid on this day.");
    expect(words).toContain("Balance after: 1,800.00 USDC");
    expect(words).toContain("Discounts this plan would take");
    expect(words).toContain("An estimate, if paid as planned");
    expect(words).toContain("Nothing here pays a bill.");
    expect(words).not.toMatch(/saved/i);
  });

  it("lists what waits for a person, with the way to Approvals, and what is not counted", () => {
    const markup = render();
    const words = text(markup);
    expect(words).toContain("Waits for a person");
    expect(words).toContain("Decide in Approvals");
    expect(markup).toContain('href="/o/northstar/approvals"');
    expect(words).toContain("Listed, not counted");
    expect(words).toContain("Flagged for review by the agent: not counted unless a person approves it.");
  });

  it("offers Approve on a line the plan would move, named for what it approves, and never on the viewer's own bill (I21)", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Approve paying Northwind Supply on Oct 15, 2026"');
    expect(markup).not.toContain('aria-label="Approve paying Harbor Office Supply on Oct 15, 2026"');
    expect(text(markup)).toContain("You created this bill, so someone else must approve its day.");
    // Only one line the viewer may approve: no batch button for one.
    expect(text(markup)).not.toContain("Approve all shown");
    // The form carries the plan and the line as shown, for the server to check again.
    expect(markup).toMatch(/name="planFingerprint" value="[a-z0-9]+"/);
    expect(markup).toMatch(/name="line" value="1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1:[a-z0-9]+"/);
  });

  it("lets the only approver approve their own bill's day, and batches what is shown", () => {
    const markup = render({ soleApprover: true });
    expect(markup).toContain('aria-label="Approve paying Harbor Office Supply on Oct 15, 2026"');
    expect(text(markup)).toContain("Approve all shown");
    expect(markup.match(/name="line"/g)?.length).toBe(4);
  });

  it("shows no Approve to someone who cannot approve payments", () => {
    const markup = render({ canDecide: false });
    expect(markup).not.toMatch(/Approve paying/);
    expect(text(markup)).toContain("Only someone who can approve payments approves the plan.");
  });

  it("keeps the plan on screen while the balance is stale, says why, offers a refresh and turns approving off (I20)", () => {
    const plan = planOf({ balance: { kind: "chain", syncedAt: new Date(NOW - 40 * 60_000).toISOString() } });
    const markup = render({ plan, soleApprover: true });
    const words = text(markup);
    expect(words).toContain("The balance is not fresh");
    expect(words).toContain("The balance was read from the chain 40 minutes ago. Refresh it to approve the plan.");
    expect(words).toContain("Refresh balance");
    expect(words).toContain("Pays on Oct 15, 2026");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Approve paying Northwind Supply on Oct 15, 2026"[^>]*aria-describedby="payment-plan-blocked"|<button[^>]*aria-label="Approve paying Northwind Supply on Oct 15, 2026"[^>]*aria-describedby="payment-plan-blocked"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-describedby="payment-plan-blocked"[^>]*aria-label="Approve paying Northwind Supply on Oct 15, 2026"/);
  });

  it("previews the cash effect beside the schedule as it stands, as a projection", () => {
    const words = text(render());
    expect(words).toContain("Cash effect");
    expect(words).toContain("Projected, before any receivable arrives.");
    expect(words).toContain("As scheduled now");
    expect(words).toContain("With this plan");
  });

  it("says in words what the struck amount and a balance under the cushion are, not by look alone", () => {
    expect(text(render())).toContain("Billed 1,000.00 USDC , pays 980.00 USDC");
    const tight = text(render({ plan: planOf({ cushion: 1900 }) }));
    expect(tight).toContain("1,800.00 USDC , under the cushion");
    expect(tight).toContain("A balance under the cushion is in bold.");
  });

  it("counts the last 30 days from what happened", () => {
    const words = text(render());
    expect(words).toContain("Last 30 days");
    expect(words).toContain("Paid by the due day 5 of 6");
    expect(words).toContain("Discounts taken 12.50 USDC");
    expect(words).toContain("Days moved by a person 2");
    expect(words).toContain("Overdue now 1");
  });

  it("says when the plan could not be read, and when nothing leaves", () => {
    expect(text(render({ plan: null }))).toContain("The payment plan could not be read. Reload the page in a moment.");
    const empty = text(render({ plan: planOf({ bills: [] }) }));
    expect(empty).toContain("Nothing leaves in the next 14 days");
    expect(empty).toContain("No bill or milestone is due by Oct 24, 2026.");
  });

  it("heads Bills & receivables, over the whole list rather than a status filter", () => {
    const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "invoices", "page.tsx"), "utf8");
    expect(page).toContain("{!filter && (\n            <PaymentPlanSection");
    expect(page.indexOf("<PaymentPlanSection")).toBeLessThan(page.indexOf('<SectionHeader title="Payables"'));
  });
});
