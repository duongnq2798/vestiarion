import { describe, expect, it } from "vitest";
import {
  buildStatement,
  customerRequestWords,
  financeNextStep,
  readSubmission,
  reminderPause,
  type CustomerRequest,
  type StatementInput,
} from "@/lib/customer-portal/model";
import { customerPortalTokenHash, generateCustomerPortalToken } from "@/lib/customer-portal/token";

/**
 * The customer portal's pure rules (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3, P4, P7, P8): what a
 * customer's form may say, when a promise or a dispute pauses the agent's reminders, what the statement shows, the words
 * the customer reads about each request, and finance's next step on each.
 */

const TODAY = "2026-10-13";
const NOW = Date.parse(`${TODAY}T09:00:00Z`);

function request(fields: Partial<CustomerRequest> & Pick<CustomerRequest, "kind">): CustomerRequest {
  return {
    id: fields.id ?? `req-${fields.kind}`,
    invoiceId: fields.invoiceId ?? "inv-1",
    counterpartyId: "cust-1",
    linkId: "link-1",
    paidOn: null,
    reference: null,
    amount: null,
    promisedOn: null,
    status: "open",
    outcome: null,
    createdAt: "2026-10-12T10:00:00Z",
    closedAt: null,
    messages: [],
    ...fields,
  };
}

describe("the statement link", () => {
  it("is vxc_ and 43 base64url characters, stored only as the SHA-256 of its secret", () => {
    const { token, secretHash } = generateCustomerPortalToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^vxc_[A-Za-z0-9_-]{43}$/);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(customerPortalTokenHash(token)).toBe(secretHash);
  });

  it("is never looked up when malformed", () => {
    expect(customerPortalTokenHash("vxc_short")).toBeNull();
    expect(customerPortalTokenHash(`vxr_${"a".repeat(43)}`)).toBeNull();
    expect(customerPortalTokenHash(`vxc_${"a".repeat(43)}/x`)).toBeNull();
  });
});

describe("readSubmission", () => {
  const base = { invoiceId: "8d0f3c8e-0d8e-4a8c-9f3a-1b2c3d4e5f60" };

  it("reads I paid: the day, and a reference, an amount and a note when given", () => {
    expect(readSubmission({ ...base, kind: "paid", paidOn: "2026-10-12", reference: " WIRE-2210 ", amount: "1,250.00", message: "" }, TODAY)).toEqual({
      ok: true,
      submission: { ...base, kind: "paid", paidOn: "2026-10-12", reference: "WIRE-2210", amount: 1250, promisedOn: null, message: null },
    });
  });

  it("refuses a day paid that is missing, after today or more than a year ago", () => {
    expect(readSubmission({ ...base, kind: "paid", paidOn: "" }, TODAY)).toMatchObject({ ok: false, field: "paidOn", message: "Enter the day you paid." });
    expect(readSubmission({ ...base, kind: "paid", paidOn: "2026-10-15" }, TODAY)).toMatchObject({ ok: false, field: "paidOn", message: "The day you paid can't be after today." });
    expect(readSubmission({ ...base, kind: "paid", paidOn: "2025-10-01" }, TODAY)).toMatchObject({ ok: false, field: "paidOn" });
    expect(readSubmission({ ...base, kind: "paid", paidOn: "12/10/2026" }, TODAY)).toMatchObject({ ok: false, field: "paidOn" });
  });

  it("refuses an amount that is not one, and a reference or message that is too long", () => {
    expect(readSubmission({ ...base, kind: "paid", paidOn: TODAY, amount: "abc" }, TODAY)).toMatchObject({ ok: false, field: "amount" });
    expect(readSubmission({ ...base, kind: "paid", paidOn: TODAY, amount: "-5" }, TODAY)).toMatchObject({ ok: false, field: "amount" });
    expect(readSubmission({ ...base, kind: "paid", paidOn: TODAY, reference: "x".repeat(121) }, TODAY)).toMatchObject({ ok: false, field: "reference" });
    expect(readSubmission({ ...base, kind: "dispute", message: "x".repeat(2001) }, TODAY)).toMatchObject({ ok: false, field: "message" });
  });

  it("reads a promise for today up to 90 days ahead", () => {
    expect(readSubmission({ ...base, kind: "promise", promisedOn: TODAY }, TODAY)).toMatchObject({ ok: true, submission: { promisedOn: TODAY } });
    expect(readSubmission({ ...base, kind: "promise", promisedOn: "2027-01-11" }, TODAY)).toMatchObject({ ok: true });
    expect(readSubmission({ ...base, kind: "promise", promisedOn: "2027-01-12" }, TODAY)).toMatchObject({ ok: false, field: "promisedOn", message: "Choose a day within 90 days." });
    expect(readSubmission({ ...base, kind: "promise", promisedOn: "2026-10-12" }, TODAY)).toMatchObject({ ok: false, field: "promisedOn", message: "Choose today or a later day." });
    expect(readSubmission({ ...base, kind: "promise" }, TODAY)).toMatchObject({ ok: false, field: "promisedOn", message: "Choose the day you will pay." });
  });

  it("needs a dispute's words, and nothing for a pay link", () => {
    expect(readSubmission({ ...base, kind: "dispute", message: "   " }, TODAY)).toMatchObject({ ok: false, field: "message", message: "Say what is wrong with this invoice." });
    expect(readSubmission({ ...base, kind: "pay_link" }, TODAY)).toMatchObject({ ok: true, submission: { kind: "pay_link", message: null } });
  });

  it("refuses an unknown kind or an invoice id that is not one", () => {
    expect(readSubmission({ ...base, kind: "refund" }, TODAY)).toMatchObject({ ok: false });
    expect(readSubmission({ invoiceId: "not-a-uuid", kind: "pay_link" }, TODAY)).toMatchObject({ ok: false });
  });
});

describe("reminderPause", () => {
  it("holds an invoice's reminders while a dispute is open, whatever a promise says", () => {
    expect(reminderPause([request({ kind: "dispute" }), request({ kind: "promise", promisedOn: "2026-10-20" })], TODAY)).toEqual({ reason: "dispute", until: null });
  });

  it("holds them through a promise's day, and after it until finance reviews the promise (collections context C3)", () => {
    expect(reminderPause([request({ kind: "promise", promisedOn: TODAY })], TODAY)).toEqual({ reason: "promise", until: TODAY });
    expect(reminderPause([request({ kind: "promise", promisedOn: "2026-10-12" })], TODAY)).toEqual({ reason: "promise_passed", until: null });
    expect(reminderPause([request({ kind: "promise", promisedOn: "2026-10-12", status: "closed", outcome: "resolved", closedAt: "2026-10-13T08:00:00Z" })], TODAY)).toBeNull();
  });

  it("holds them while a claim of payment is open (collections context C2)", () => {
    expect(reminderPause([request({ kind: "paid", paidOn: "2026-10-12" })], TODAY)).toEqual({ reason: "paid", until: null });
  });

  it("ignores a closed request and a pay link asked for", () => {
    expect(reminderPause([request({ kind: "dispute", status: "closed", outcome: "resolved", closedAt: "2026-10-13T08:00:00Z" })], TODAY)).toBeNull();
    expect(reminderPause([request({ kind: "pay_link" })], TODAY)).toBeNull();
  });
});

function statementInput(overrides: Partial<StatementInput> = {}): StatementInput {
  return {
    orgName: "Northstar Studio",
    customerName: "Acme Corp",
    expiresAt: "2026-11-12T09:00:00Z",
    now: NOW,
    invoices: [
      { id: "inv-1", amount: 1250, currency: "USDC", dueDate: "2026-10-05T12:00:00Z", memo: "Website, phase 2", poReference: "PO-77", status: "pending", settledAt: null },
      { id: "inv-2", amount: 400, currency: "USDC", dueDate: "2026-10-20T12:00:00Z", memo: null, poReference: null, status: "pending", settledAt: null },
      { id: "inv-3", amount: 300, currency: "EURC", dueDate: "2026-10-25T12:00:00Z", memo: "Hosting", poReference: null, status: "matched", settledAt: null },
      { id: "inv-4", amount: 800, currency: "USDC", dueDate: "2026-09-01T12:00:00Z", memo: "Phase 1", poReference: null, status: "received", settledAt: "2026-09-03T10:00:00Z" },
      { id: "inv-5", amount: 90, currency: "USDC", dueDate: "2026-05-01T12:00:00Z", memo: "Old", poReference: null, status: "received", settledAt: "2026-05-02T10:00:00Z" },
      { id: "inv-6", amount: 50, currency: "USDC", dueDate: "2026-10-01T12:00:00Z", memo: "Rejected", poReference: null, status: "rejected", settledAt: null },
    ],
    owed: new Map([["inv-1", { outstanding: 750, received: 500 }]]),
    payLinks: new Map([["inv-2", "https://www.vestiarion.xyz/pay/vxr_x"]]),
    requests: [],
    ...overrides,
  };
}

describe("buildStatement", () => {
  it("lists open invoices by due day, with what is still owed and how late, and totals by currency, never summed across", () => {
    const view = buildStatement(statementInput());
    expect(view.open.map((line) => line.id)).toEqual(["inv-1", "inv-2", "inv-3"]);
    expect(view.open[0]).toMatchObject({ label: "Website, phase 2", reference: "PO-77", amount: 1250, owed: 750, received: 500, overdueDays: 8, state: "overdue" });
    expect(view.open[1]).toMatchObject({ label: "Invoice due Oct 20, 2026", overdueDays: 0, state: "open", payUrl: "https://www.vestiarion.xyz/pay/vxr_x" });
    expect(view.totals).toEqual([
      { currency: "USDC", owed: 1150, overdue: 750, open: 2 },
      { currency: "EURC", owed: 300, overdue: 0, open: 1 },
    ]);
  });

  it("shows paid invoices from the last 90 days, newest first, and never a rejected one", () => {
    const view = buildStatement(statementInput());
    expect(view.paid.map((line) => line.id)).toEqual(["inv-4"]);
    expect([...view.open, ...view.paid].some((line) => line.id === "inv-6")).toBe(false);
  });

  it("puts each request under its invoice, open ones first, and says when reminders wait", () => {
    const view = buildStatement(
      statementInput({
        requests: [
          request({ id: "r1", kind: "promise", invoiceId: "inv-2", promisedOn: "2026-10-18" }),
          request({ id: "r2", kind: "paid", invoiceId: "inv-2", paidOn: "2026-10-10", status: "closed", outcome: "not_received", closedAt: "2026-10-12T15:00:00Z" }),
        ],
      })
    );
    const line = view.open.find((item) => item.id === "inv-2");
    expect(line?.requests.map((item) => item.id)).toEqual(["r1", "r2"]);
    expect(line?.pause).toEqual({ reason: "promise", until: "2026-10-18" });
  });
});

describe("customerRequestWords", () => {
  const org = "Northstar Studio";

  it("says a claim of payment is being checked, and never that the invoice is paid", () => {
    const words = customerRequestWords(request({ kind: "paid", paidOn: "2026-10-10", reference: "WIRE-2210", amount: 1250 }), { orgName: org, currency: "USDC", today: TODAY, payUrl: null });
    expect(words.title).toBe("You said you paid on Oct 10, 2026");
    expect(words.detail).toBe("1,250.00 USDC · reference WIRE-2210");
    expect(words.status).toBe("Northstar Studio is checking for your payment. The invoice stays open until they find it.");
    expect(`${words.title} ${words.status}`).not.toMatch(/\bpaid\b(?! on)/);
  });

  it("says what happened to a closed claim", () => {
    expect(customerRequestWords(request({ kind: "paid", paidOn: "2026-10-10", status: "closed", outcome: "resolved", closedAt: "2026-10-12T00:00:00Z" }), { orgName: org, currency: "USDC", today: TODAY, payUrl: null }).status).toBe(
      "Northstar Studio found your payment."
    );
    expect(customerRequestWords(request({ kind: "paid", paidOn: "2026-10-10", status: "closed", outcome: "not_received", closedAt: "2026-10-12T00:00:00Z" }), { orgName: org, currency: "USDC", today: TODAY, payUrl: null }).status).toBe(
      "Northstar Studio has not received this payment. Check its details, then tell them again."
    );
  });

  it("says a promise and a dispute hold the reminders", () => {
    expect(customerRequestWords(request({ kind: "promise", promisedOn: "2026-10-18" }), { orgName: org, currency: "USDC", today: TODAY, payUrl: null })).toMatchObject({
      title: "You promised to pay by Oct 18, 2026",
      status: "Reminders about this invoice wait until then.",
    });
    expect(customerRequestWords(request({ kind: "dispute" }), { orgName: org, currency: "USDC", today: TODAY, payUrl: null })).toMatchObject({
      title: "You disputed this invoice",
      status: "Reminders about this invoice wait until Northstar Studio resolves it.",
    });
  });
});

describe("financeNextStep", () => {
  const live = { invoiceOpen: true, payLink: false, sandbox: false, today: TODAY, owed: 750, currency: "USDC" as const };

  it("asks finance to find a claimed payment, never to mark it paid", () => {
    const step = financeNextStep(request({ kind: "paid", paidOn: "2026-10-10", reference: "WIRE-2210", amount: 750 }), live);
    expect(step).toMatchObject({ label: "Find the payment", closes: ["resolved", "not_received"] });
    expect(step.detail).toBe(
      "Look for 750.00 USDC paid on Oct 10, 2026, reference WIRE-2210. Once it arrived, apply it under Apply payments, then close this as found. The agent's reminders wait until you close it."
    );
  });

  it("closes a claim whose invoice was paid since", () => {
    expect(financeNextStep(request({ kind: "paid", paidOn: "2026-10-10" }), { ...live, invoiceOpen: false })).toMatchObject({ label: "Close it: the invoice is paid", closes: ["resolved"] });
  });

  it("waits on a promise until its day, then follows up", () => {
    expect(financeNextStep(request({ kind: "promise", promisedOn: "2026-10-18" }), live)).toMatchObject({ label: "Wait until Oct 18, 2026" });
    expect(financeNextStep(request({ kind: "promise", promisedOn: "2026-10-12" }), live)).toMatchObject({ label: "Review it: the promised day passed" });
  });

  it("asks for a reply and a resolution on a dispute", () => {
    expect(financeNextStep(request({ kind: "dispute" }), live)).toMatchObject({ label: "Reply, then resolve", reply: true, closes: ["resolved"] });
  });

  it("sends finance to make a pay link, and closes once one exists", () => {
    expect(financeNextStep(request({ kind: "pay_link" }), live)).toMatchObject({ label: "Make a pay link", openInvoice: true });
    expect(financeNextStep(request({ kind: "pay_link" }), { ...live, payLink: true })).toMatchObject({ label: "Close it: the pay link is on their statement", closes: ["resolved"] });
    expect(financeNextStep(request({ kind: "pay_link" }), { ...live, sandbox: true }).detail).toMatch(/sandbox/);
  });
});
