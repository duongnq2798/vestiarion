import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllocationLines } from "@/components/AllocationLines";
import { ApplyPayments } from "@/components/ApplyPayments";
import { invoiceDecision } from "@/components/vx/map";
import type { AllocationBook } from "@/lib/allocations/book";
import { toMicros, type AllocationRow, type PaymentIn, type ReceivableIn } from "@/lib/allocations/model";
import { applyPaymentsView, paymentsByReceivable, receivableViews } from "@/lib/allocations/view";
import { trailStep } from "@/lib/decision-trail";
import type { InvoiceRow } from "@/lib/queries";

/**
 * Where money applied to receivables shows (docs/superpowers/specs/2026-10-12-allocations-design.md L11, L12): each
 * receivable's card says what was received and what is still owed, with each payment and fee, and Reverse for an owner
 * or admin; Apply payments lists money received with what is left, the suggestions with why, and Apply; the trail tells
 * each application. The actions authorize first.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { authorizeMock, applyMock, reverseMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), applyMock: vi.fn(), reverseMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/commands/allocations", () => ({ applyReceivedPayment: applyMock, reverseAppliedPayment: reverseMock }));

import { applyPaymentAction, reverseAllocationAction } from "@/app/actions/allocations";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const M = (amount: number) => toMicros(amount);
const ACME = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;
const PAYMENT_ID = "018f8ce0-1557-7b54-a931-4d777f6ba900";
const [A, B] = ["018f8ce0-1557-7b54-a931-4d777f6ba00a", "018f8ce0-1557-7b54-a931-4d777f6ba00b"];

const receivable = (id: string, amount: number, over: Partial<ReceivableIn> = {}): ReceivableIn => ({
  id,
  counterpartyId: "acme",
  customer: "Acme Corp",
  amount: M(amount),
  currency: "USDC",
  status: "pending",
  dueDate: "2026-10-15T12:00:00Z",
  createdAt: "2026-10-01T09:00:00Z",
  memo: id === A ? "Invoice INV-1042: October retainer" : "Invoice INV-1043: Design sprint",
  poReference: null,
  ...over,
});
const payment = (over: Partial<PaymentIn> = {}): PaymentIn => ({
  id: PAYMENT_ID,
  circleTxId: "circle-1",
  txHash: TX,
  from: ACME,
  amount: M(500),
  currency: "USDC",
  receivedAt: "2026-10-12T09:00:00Z",
  wholeMatch: null,
  ...over,
});
const applied = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  id: "row-1",
  kind: "payment",
  invoiceId: A,
  transferId: PAYMENT_ID,
  amount: M(300),
  currency: "USDC",
  reverses: null,
  reason: null,
  basis: "person",
  paymentSeq: 1,
  createdBy: "person-1",
  createdAt: "2026-10-12T10:00:00Z",
  ...over,
});
const book = (over: Partial<AllocationBook> = {}): AllocationBook => ({ available: true, rows: [applied()], payments: [payment()], floatSenders: new Set(), ...over });

const invoiceRow = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: A,
  direction: "receivable",
  counterparty_id: "acme",
  counterparty_name: "Acme Corp",
  amount: 900,
  memo: "Invoice INV-1042: October retainer",
  po_reference: null,
  goods_received: false,
  due_date: "2026-10-15T12:00:00Z",
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  ...over,
});

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "u1", email: null }, membership: { orgId: "o1", slug: "mai", name: "Mai Studio", mode: "live", role: "owner" } });
  applyMock.mockReset().mockResolvedValue({ ok: true, message: "Applied to 1 invoice." });
  reverseMock.mockReset().mockResolvedValue({ ok: true, message: "Reversed." });
});

describe("a receivable's card", () => {
  const views = receivableViews(book(), [receivable(A, 900)]);

  it("says part paid, with what was received and what is still owed", () => {
    const decision = invoiceDecision(invoiceRow(), undefined, [], { network: "arc-testnet", allocations: views });
    expect(decision.outcomeLabel).toBe("Part paid");
    expect(decision.reasoning).toBe(
      "Part paid: 300.00 USDC of 900.00 USDC received from one payment, and 600.00 USDC still owed. When exactly the rest arrives in the operating wallet on Arc testnet, the agent applies it by itself; another amount waits under Apply payments."
    );
    expect(decision.evidence).toEqual(
      expect.arrayContaining([
        { label: "Received", value: "300.00 of 900.00 USDC", state: "ok" },
        { label: "Still owed", value: "600.00 USDC", state: "missing" },
      ])
    );
  });

  it("says a receivable paid by payments applied is received on Arc, with any fee", () => {
    const rows = [applied({ amount: M(899.7) }), applied({ id: "row-2", kind: "fee", transferId: null, paymentSeq: null, basis: null, amount: M(0.3), reason: "Transfer fee" })];
    const paid = receivableViews(book({ rows }), [receivable(A, 900, { status: "received" })]);
    const decision = invoiceDecision(invoiceRow({ status: "received", tx_ref: TX }), undefined, [], { network: "arc-testnet", allocations: paid });
    expect(decision.outcomeLabel).toBe("Received on Arc");
    expect(decision.reasoning).toBe("Paid by one payment received on Arc testnet, 899.70 USDC, and 0.30 USDC recorded as a fee.");
  });

  it("is as before with nothing applied", () => {
    const decision = invoiceDecision(invoiceRow(), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Awaiting payment");
    expect(decision.reasoning).toContain("When the exact amount arrives in the operating wallet on Arc testnet, the agent matches it to this invoice.");
  });

  it("lists each payment and fee applied, with Reverse and Record a fee for an owner or admin", () => {
    const view = views.get(A)!;
    const owner = text(renderToStaticMarkup(<AllocationLines orgSlug="mai" network="arc-testnet" view={view} label="Invoice INV-1042: October retainer" canWrite />));
    expect(owner).toContain("Payments applied");
    expect(owner).toContain("Received 300.00 USDC of 900.00 USDC . 600.00 USDC still owed.");
    expect(owner).toContain("received Oct 12, 2026 from 0x2222…2222");
    expect(owner).toContain("Reverse");
    expect(owner).toContain("Record a fee");
    const viewer = text(renderToStaticMarkup(<AllocationLines orgSlug="mai" network="arc-testnet" view={view} label="Invoice INV-1042" canWrite={false} />));
    expect(viewer).not.toContain("Reverse");
    expect(viewer).not.toContain("Record a fee");
  });
});

describe("Apply payments", () => {
  const customers = [{ id: "acme", name: "Acme Corp", address: ACME }];

  it("lists what is left of each payment, whose credit it is, and the suggestions with why", () => {
    const views = applyPaymentsView(book(), [receivable(A, 900), receivable(B, 200)], customers);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ applied: 300, unapplied: 200, version: 1, creditFor: "Acme Corp", sender: "Acme Corp" });
    expect(views[0].suggestions[0]).toMatchObject({ rule: "exact", lines: [{ invoiceId: B, label: "Invoice INV-1043: Design sprint", amount: 200 }] });
    const page = text(renderToStaticMarkup(<ApplyPayments orgSlug="mai" network="arc-testnet" payments={views} canWrite />));
    expect(page).toContain("Apply payments 1");
    expect(page).toContain("500.00 USDC received Oct 12, 2026 from Acme Corp");
    expect(page).toContain("300.00 USDC applied. 200.00 USDC left as credit for Acme Corp.");
    expect(page).toContain("Left from a payment applied to Acme Corp before, and exactly what is still owed on Invoice INV-1043: Design sprint.");
    expect(page).toContain("Apply by hand");
    const viewer = text(renderToStaticMarkup(<ApplyPayments orgSlug="mai" network="arc-testnet" payments={views} canWrite={false} />));
    expect(viewer).toContain("Only an owner or admin of this workspace can apply payments.");
    expect(viewer).not.toContain("Apply by hand");
  });

  it("asks for a reason before a difference is recorded as a fee", () => {
    const views = applyPaymentsView(book({ rows: [], payments: [payment({ amount: M(99.7) })] }), [receivable(A, 100)], customers);
    const page = text(renderToStaticMarkup(<ApplyPayments orgSlug="mai" network="arc-testnet" payments={views} canWrite />));
    expect(page).toContain("0.30 USDC short of what is owed on Invoice INV-1042: October retainer, which may be a fee");
    expect(page).toContain("Why the difference is a fee");
    expect(page).toContain("Apply and record the fee");
    expect(page).toContain("Apply, leave the rest owed");
  });

  it("folds money in with no suggestion, and leaves out a whole match, test USDC from the float and a payment applied in full", () => {
    const FLOAT = "0xf10a7000000000000000000000000000000000f1";
    const payments = [
      payment({ id: "p-stray", from: "0x9999999999999999999999999999999999999999", amount: M(17) }),
      payment({ id: "p-whole", wholeMatch: A }),
      payment({ id: "p-float", from: FLOAT }),
      payment({ id: "p-done", amount: M(300) }),
    ];
    const rows = [applied({ transferId: "p-done" })];
    const views = applyPaymentsView(book({ rows, payments, floatSenders: new Set([FLOAT]) }), [receivable(A, 900)], customers);
    expect(views.map((view) => view.id)).toEqual(["p-stray"]);
    const page = text(renderToStaticMarkup(<ApplyPayments orgSlug="mai" network="arc-testnet" payments={views} canWrite />));
    expect(page).toContain("Other money in, with no suggestion (1)");
  });

  it("finds a payment by search, and the receivables a payment was applied to", () => {
    const found = paymentsByReceivable(book());
    expect(found.get(A)?.map((p) => p.txHash)).toEqual([TX]);
  });
});

describe("the trail", () => {
  const step = (action: string, actor: string, detail: Record<string, unknown>) => trailStep({ seq: 9, ts: "2026-10-12T10:00:00Z", actor, action, summary: "", detail }, "arc-testnet");

  it("tells each application, fee and reversal, with what is owed after", () => {
    expect(step("ar_payment_applied", "human", { amount: 300, currency: "USDC", txHash: TX, outstandingAfter: 600, unappliedAfter: 200, suggestion: { rule: "exact" } })).toMatchObject({
      who: "person",
      tone: "done",
      text: "A person applied 300.00 USDC received on Arc testnet, as the agent suggested.",
      notes: ["· 600.00 USDC still owed", "· 200.00 USDC of the payment left to apply"],
      txHash: TX,
    });
    expect(step("ar_payment_applied", "agent", { amount: 600, currency: "USDC", outstandingAfter: 0, unappliedAfter: 0 })).toMatchObject({
      who: "agent",
      text: "The agent applied 600.00 USDC received on Arc testnet: what was still owed.",
      notes: ["✓ Nothing is owed on it now"],
    });
    expect(step("ar_fee_recorded", "human", { amount: 0.3, currency: "USDC", reason: "Transfer fee", outstandingAfter: 0 })?.text).toBe("A person recorded 0.30 USDC as a fee: Transfer fee.");
    expect(step("ar_allocation_reversed", "human", { amount: 300, currency: "USDC", reason: "Wrong invoice", reversedKind: "payment", outstandingAfter: 900 })).toMatchObject({
      tone: "stopped",
      text: "A person reversed 300.00 USDC applied: Wrong invoice.",
      notes: ["· 900.00 USDC still owed"],
    });
  });
});

describe("the actions", () => {
  it("authorize records.write first, and read the input before any command", async () => {
    const input = { paymentId: PAYMENT_ID, version: 1, lines: [{ invoiceId: B, amount: "200.00" }], fees: [] };
    expect(await applyPaymentAction("mai", input)).toEqual({ ok: true, message: "Applied to 1 invoice." });
    expect(authorizeMock).toHaveBeenCalledWith("mai", "records.write");
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", role: "owner" }), input);

    expect(await applyPaymentAction("mai", { ...input, version: null })).toEqual({ ok: false, message: "That could not be read. Reload the page and try again." });
    expect(await reverseAllocationAction("mai", { allocationId: "not-an-id", reason: "x" })).toMatchObject({ ok: false });

    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    applyMock.mockClear();
    expect(await applyPaymentAction("mai", input)).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("are wired into Bills & receivables, with search, and the receivable's card", () => {
    const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "invoices", "page.tsx"), "utf8");
    expect(page).toContain("readAllocationBook(db())");
    expect(page).toContain("<ApplyPayments orgSlug={slug} network={network} payments={toApply} canWrite={canWrite} />");
    expect(page).toContain("Applying payments is not set up on this deployment yet.");
    expect(page).toContain('<form method="get" role="search"');
    expect(page).toContain("invoiceMatch(search, invoice, ");
  });

  it("count a part-paid receivable on Treasury at what is still owed, the rest being in the wallet already", () => {
    const treasury = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");
    expect(treasury).toContain("readAllocationRows(db(), { invoiceIds: receivableIds }).catch(");
    expect(treasury).toContain("amount: stillOwed(invoice, applied), counterparty: invoice.counterparty_name");
  });

  it("count a part-paid receivable in the payment plan's money expected in at what is still owed", () => {
    const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "invoices", "page.tsx"), "utf8");
    expect(page).toContain("[invoice.id, stillOwed(invoice, book?.rows ?? [])]");
  });
});
