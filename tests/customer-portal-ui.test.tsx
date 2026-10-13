import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FromCustomers } from "@/components/portal/FromCustomers";
import { StatementView } from "@/components/portal/StatementView";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { buildStatement, type CustomerRequest } from "@/lib/customer-portal/model";
import { customerNote, fromCustomerItems, statementLinkRows } from "@/lib/customer-portal/view";

/**
 * The customer portal's screens (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3, P8, I16): the
 * statement a customer reads, which never calls a claim a payment and names no one but the business and the customer;
 * its dead and expired pages; the actions, which hand the link and the form to the library and refresh only on success;
 * and the Receivables tab's list, with each request's next step.
 */

const { readMock, submitMock, replyMock, refreshMock, authorizeMock, commands } = vi.hoisted(() => ({
  readMock: vi.fn(),
  submitMock: vi.fn(),
  replyMock: vi.fn(),
  refreshMock: vi.fn(),
  authorizeMock: vi.fn(),
  commands: { share: vi.fn(), stop: vi.fn(), reply: vi.fn(), close: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/cache")>()), refresh: refreshMock, revalidatePath: vi.fn() }));
vi.mock("@/lib/customer-portal/public", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-portal/public")>()),
  readStatement: readMock,
  submitCustomerRequest: submitMock,
  replyAsCustomer: replyMock,
}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn(), withOrg: (_id: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/commands/customer-portal", () => ({
  shareCustomerStatement: commands.share,
  stopCustomerStatement: commands.stop,
  replyToCustomerRequest: commands.reply,
  closeCustomerRequestCommand: commands.close,
}));

import { shareCustomerStatementAction } from "@/app/actions/customer-portal";
import { submitStatementRequestAction } from "@/app/statement/[token]/actions";
import StatementPage from "@/app/statement/[token]/page";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const TOKEN = `vxc_${"C".repeat(43)}`;
const NOW = Date.parse("2026-10-13T09:00:00Z");
const INVOICE = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001a1";

function request(fields: Partial<CustomerRequest> & Pick<CustomerRequest, "kind">): CustomerRequest {
  return {
    id: `req-${fields.kind}`,
    invoiceId: INVOICE,
    counterpartyId: "cust",
    linkId: "link",
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

const view = (requests: CustomerRequest[] = [], payUrl: string | null = null) =>
  buildStatement({
    orgName: "Northstar Studio",
    customerName: "Acme Corp",
    expiresAt: "2026-11-12T09:00:00Z",
    now: NOW,
    invoices: [
      { id: INVOICE, amount: 1250, currency: "USDC", dueDate: "2026-10-05T12:00:00Z", memo: "Website, phase 2", poReference: "PO-77", status: "pending", settledAt: null },
      { id: "inv-eur", amount: 300, currency: "EURC", dueDate: "2026-10-25T12:00:00Z", memo: "Hosting", poReference: null, status: "pending", settledAt: null },
    ],
    owed: new Map([[INVOICE, { outstanding: 750, received: 500 }]]),
    payLinks: new Map(payUrl ? [[INVOICE, payUrl]] : []),
    requests,
  });

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

beforeEach(() => {
  for (const mock of [readMock, submitMock, replyMock, refreshMock, authorizeMock, ...Object.values(commands)]) mock.mockReset();
});

describe("the statement a customer reads", () => {
  it("says what is owed in each currency apart, each open invoice with what is still owed and how late, and its actions", () => {
    const page = text(render(<StatementView view={view()} token={TOKEN} />));
    expect(page).toContain("What Acme Corp owes Northstar Studio");
    expect(page).toContain("This link works until Nov 12, 2026.");
    expect(page).toContain("750.00 USDC 1 open invoice · 750.00 USDC overdue");
    expect(page).toContain("300.00 EURC 1 open invoice");
    expect(page).toContain("Overdue 8 days");
    expect(page).toContain("Still owed. Received 500.00 of 1,250.00 USDC.");
    for (const action of ["Ask for a pay link", "I paid", "Promise to pay", "Dispute"]) expect(page).toContain(action);
  });

  it("offers Pay on Arc through the invoice's pay link instead of asking for one", () => {
    const markup = render(<StatementView view={view([], "https://www.vestiarion.xyz/pay/vxr_x")} token={TOKEN} />);
    expect(markup).toContain('href="https://www.vestiarion.xyz/pay/vxr_x"');
    expect(text(markup)).toContain("Pay on Arc");
  });

  it("shows a claim of payment as the customer's word, being checked, and never as paid", () => {
    const page = text(render(<StatementView view={view([request({ kind: "paid", paidOn: "2026-10-10", reference: "WIRE-2210", amount: 750 })])} token={TOKEN} />));
    expect(page).toContain("You said you paid on Oct 10, 2026");
    expect(page).toContain("Northstar Studio is checking for your payment. The invoice stays open until they find it.");
    expect(page).not.toMatch(/\bPaid\b/);
  });

  it("shows the thread with the business's replies under its name, and a way to write more", () => {
    const dispute = request({
      kind: "dispute",
      messages: [
        { id: "m1", author: "customer", body: "We were charged twice.", createdAt: "2026-10-12T10:00:00Z", by: null },
        { id: "m2", author: "business", body: "Checking with our bank.", createdAt: "2026-10-12T15:00:00Z", by: null },
      ],
    });
    const page = text(render(<StatementView view={view([dispute])} token={TOKEN} />));
    expect(page).toContain("You · Oct 12, 2026 We were charged twice.");
    expect(page).toContain("Northstar Studio · Oct 12, 2026 Checking with our bank.");
    expect(page).toContain("Reminders about this invoice wait until Northstar Studio resolves it.");
    expect(page).toContain("Write to Northstar Studio");
  });

  it("keeps the amount and its currency in view in the I paid form, in a field that takes a phone's decimal keyboard", () => {
    const markup = render(<StatementView view={view()} token={TOKEN} openForm={{ invoiceId: INVOICE, form: "paid" }} />);
    expect(text(markup)).toContain("Tell them you paid 750.00 USDC still owed on Website, phase 2");
    expect(markup).toMatch(/<input[^>]*name="amount"[^>]*inputMode="decimal"|<input[^>]*inputMode="decimal"[^>]*name="amount"/i);
    expect(markup).toContain('value="750.00"');
    expect(markup).toContain('max="2026-10-14"');
  });

  it("bounds a promise to today up to 90 days ahead", () => {
    const markup = render(<StatementView view={view()} token={TOKEN} openForm={{ invoiceId: INVOICE, form: "promise" }} />);
    expect(markup).toContain('min="2026-10-13"');
    expect(markup).toContain('max="2027-01-11"');
    expect(text(markup)).toContain("Reminders about this invoice wait until then.");
  });
});

describe("the statement page", () => {
  it.each([
    [{ state: "dead" }, "This link no longer works. Ask the business that sent it for a new one."],
    [{ state: "expired", expiresAt: "2026-10-01T09:00:00Z" }, "This link has expired. It worked until Oct 1, 2026. Ask the business that sent it for a new one."],
  ])("says a dead or expired link in one sentence and names no one", async (read, words) => {
    readMock.mockResolvedValueOnce(read);
    const page = text(renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ token: TOKEN }) })));
    expect(page).toContain(words);
    expect(page).not.toContain("Northstar");
  });

  it("says a read that failed, without its cause", async () => {
    readMock.mockRejectedValueOnce(new Error("secret detail"));
    const page = text(renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ token: TOKEN }) })));
    expect(page).toContain("This statement could not load. Try again in a moment.");
    expect(page).not.toContain("secret detail");
  });
});

describe("the statement's actions", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };

  it("hands the link and the form to the library, and refreshes the page only once it was sent", async () => {
    submitMock.mockResolvedValueOnce({ ok: true, message: "Sent." });
    expect(await submitStatementRequestAction({ ok: false, message: "" }, form({ token: TOKEN, invoiceId: INVOICE, kind: "dispute", message: "Wrong rate." }))).toEqual({ ok: true, message: "Sent." });
    expect(submitMock).toHaveBeenCalledWith(TOKEN, { invoiceId: INVOICE, kind: "dispute", paidOn: "", reference: "", amount: "", promisedOn: "", message: "Wrong rate." }, expect.any(Number), {
      defer: expect.any(Function),
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    submitMock.mockResolvedValueOnce({ ok: false, field: "message", message: "Say what is wrong with this invoice." });
    await submitStatementRequestAction({ ok: false, message: "" }, form({ token: TOKEN, invoiceId: INVOICE, kind: "dispute" }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("says a fixed sentence when something fails, never its cause", async () => {
    submitMock.mockRejectedValueOnce(new Error("db password in message"));
    expect(await submitStatementRequestAction({ ok: false, message: "" }, form({ token: TOKEN }))).toEqual({ ok: false, message: "That did not work. Try again in a moment.", field: "form" });
  });

  it("asks the workspace's own permission to make a link, and gives the link once", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(await shareCustomerStatementAction({ ok: false, message: "" }, form({ orgSlug: "mai", counterpartyId: INVOICE, days: "30" }))).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(authorizeMock).toHaveBeenCalledWith("mai", "records.write");
    expect(commands.share).not.toHaveBeenCalled();
  });
});

describe("the Receivables tab's list of what customers said", () => {
  const items = (requests: CustomerRequest[], over: { payLinked?: Set<string>; sandbox?: boolean; status?: string } = {}) =>
    fromCustomerItems({
      requests,
      invoices: new Map([[INVOICE, { id: INVOICE, counterpartyName: "Acme Corp", amount: 1250, currency: "USDC", status: over.status ?? "pending", dueDate: "2026-10-05T12:00:00Z", memo: "Website, phase 2" }]]),
      owedOf: () => 750,
      payLinked: over.payLinked ?? new Set(),
      sandbox: over.sandbox ?? false,
      today: "2026-10-13",
      members: new Map([["member-1", "ana@northstar.example"]]),
      invoiceHref: (id) => `/o/northstar/invoices?tab=receivables&open=${id}`,
    });

  it("labels a claim of payment as the customer's word, with what to look for, and both ways to close it", () => {
    const [item] = items([request({ kind: "paid", paidOn: "2026-10-10", reference: "WIRE-2210", amount: 750 })]);
    expect(item).toMatchObject({
      kindLabel: "Customer says paid",
      said: "Says it paid 750.00 USDC on Oct 10, 2026, reference WIRE-2210.",
      owed: "750.00 USDC still owed",
      step: { label: "Find the payment" },
    });
    const page = text(render(<FromCustomers orgSlug="northstar" items={[item]} canWrite />));
    expect(page).toContain("Customer says paid");
    expect(page).toContain("Payment found");
    expect(page).toContain("Not received");
    expect(page).not.toMatch(/\bPaid\b(?! on)/);
  });

  it("says when the reminders wait, and names who replied", () => {
    const [item] = items([
      request({
        kind: "dispute",
        messages: [
          { id: "m1", author: "customer", body: "Charged twice.", createdAt: "2026-10-12T10:00:00Z", by: null },
          { id: "m2", author: "business", body: "Checking.", createdAt: "2026-10-12T11:00:00Z", by: "member-1" },
        ],
      }),
    ]);
    expect(item.pause).toBe("Reminders wait until you resolve it");
    expect(item.messages.map((message) => message.who)).toEqual(["Acme Corp", "ana@northstar.example"]);
  });

  it("sends finance to the invoice to make a pay link, and shows only what a viewer may read", () => {
    const [item] = items([request({ kind: "pay_link" })]);
    expect(item.step).toMatchObject({ label: "Make a pay link", openInvoice: true });
    const markup = render(<FromCustomers orgSlug="northstar" items={[item]} canWrite={false} />);
    expect(text(markup)).toContain("Next: Make a pay link");
    expect(markup).not.toContain(">Open the invoice</a>");
    expect(markup).not.toContain("<form");
    expect(render(<FromCustomers orgSlug="northstar" items={[item]} canWrite />)).toContain(">Open the invoice</a>");
  });

  it("says on a receivable's row what its customer said, a dispute first, and never that it is paid", () => {
    expect(customerNote([request({ kind: "paid", paidOn: "2026-10-10" }), request({ kind: "dispute" })])).toBe("Disputed by the customer");
    expect(customerNote([request({ kind: "paid", paidOn: "2026-10-10" })])).toBe("Customer says paid Oct 10, 2026");
    expect(customerNote([request({ kind: "promise", promisedOn: "2026-10-18" })])).toBe("Customer promised by Oct 18, 2026");
    expect(customerNote([request({ kind: "dispute", status: "closed", outcome: "resolved", closedAt: "2026-10-12T00:00:00Z" })])).toBeNull();
  });

  it("lists links live first, saying until when each works and who made it", () => {
    const rows = statementLinkRows(
      [
        { id: "old", counterpartyId: "c1", createdBy: null, createdAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z", expired: true },
        { id: "new", counterpartyId: "c1", createdBy: "member-1", createdAt: "2026-10-13T00:00:00Z", expiresAt: "2026-11-12T00:00:00Z", expired: false },
      ],
      new Map([["c1", "Acme Corp"]]),
      new Map([["member-1", "ana@northstar.example"]])
    );
    expect(rows.map((row) => [row.id, row.until, row.made])).toEqual([
      ["new", "Works until Nov 12, 2026", "Made by ana@northstar.example on Oct 13, 2026"],
      ["old", "Expired Oct 1, 2026", "Made by a former member on Sep 1, 2026"],
    ]);
  });
});
