import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { mapOrganisation, mapPayment, mapPayments, paymentBody, paymentOnBill, referenceFilter, validationMessage } from "@/lib/xero/payments";
import { bill, bookPayment, findPayment, organisation, payment, xeroBooking } from "@/lib/xero/payments-api";
import { xeroProvider } from "@/lib/xero/provider";
import { XERO_READ_SCOPES, XERO_SCOPES, XERO_WRITE_SCOPES } from "@/lib/xero/settings";

/**
 * Booking payments in Xero (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W1, W7, W8, W11), against
 * recorded Xero-shaped answers and a recording fetch: no call leaves the test.
 */

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests", "fixtures", "xero", name), "utf8");
const body = (name: string): unknown => JSON.parse(fixture(name));
const NOW = Date.parse("2026-10-12T09:20:00.000Z");
const TENANT = "b2c885a9-4bb9-4a00-9b6e-6c2bf60b1a6b";
const TOKEN = "access-token-value";
const BILL = "0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0101";
const HASH = `0x${"3c".repeat(32)}`;
const ACCOUNT = "6f7594f2-f059-4d56-9e67-47ac9733bfe9";
const request = { accessToken: TOKEN, externalOrgId: TENANT };

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

function recorder(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    sent.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl, now: () => NOW } };
}

const json = (value: string | unknown, init: ResponseInit = {}) =>
  new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("the scopes (W8)", () => {
  it("asks for the read scopes as before, and accounting.payments to book", () => {
    expect([...XERO_READ_SCOPES]).toEqual(["offline_access", "accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read"]);
    expect([...XERO_WRITE_SCOPES]).toEqual(["accounting.payments"]);
    expect([...XERO_SCOPES]).toEqual([...XERO_READ_SCOPES, "accounting.payments"]);
    const provider = xeroProvider({ clientId: "91E5715B1199038080D6D0BBACCD4E60", clientSecret: "s" });
    expect(provider.booking?.writeScopes).toEqual(["accounting.payments"]);
  });
});

describe("mapOrganisation (W1)", () => {
  it("reads the Demo Company as a demo organisation", () => {
    expect(mapOrganisation(body("organisation-demo.json"), TENANT)).toEqual({ externalOrgId: TENANT, name: "Demo Company (Global)", demo: true, baseCurrency: "USD" });
  });

  it("reads a real organisation, and a trial, as real books", () => {
    expect(mapOrganisation(body("organisation-real.json"), "t")).toMatchObject({ name: "Northwind Trading Pte Ltd", demo: false, baseCurrency: "SGD" });
    expect(mapOrganisation(body("organisation-trial.json"), "t")).toMatchObject({ name: "Hoyt Studio", demo: false });
  });

  it("takes Xero's word only: no flag at all is not a demo", () => {
    expect(mapOrganisation({ Organisations: [{ Name: "Somewhere" }] }, "t")).toMatchObject({ demo: false, baseCurrency: null });
    expect(mapOrganisation({ Organisations: [{ Name: "Demo-ish", Class: "DEMO" }] }, "t")).toMatchObject({ demo: true });
    expect(() => mapOrganisation({ Organisations: [] }, "t")).toThrow(ProviderError);
  });

  it("never takes an organisation Xero says is not a demo company for one, whatever its class says", () => {
    expect(mapOrganisation({ Organisations: [{ Name: "Mixed", IsDemoCompany: false, Class: "DEMO" }] }, "t")).toMatchObject({ demo: false });
    expect(mapOrganisation({ Organisations: [{ Name: "Words", IsDemoCompany: "true", Class: "STANDARD" }] }, "t")).toMatchObject({ demo: false });
  });
});

describe("payments in Xero's JSON", () => {
  it("reads a payment made against a bill", () => {
    const [made] = mapPayments(body("payment-created.json"));
    expect(made).toEqual({
      externalId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379",
      billExternalId: BILL,
      accountExternalId: ACCOUNT,
      amount: "31.39",
      currency: "USD",
      date: "2026-10-12",
      reference: HASH,
      status: "active",
    });
  });

  it("finds the one standing on this bill with this reference before a deleted one, and none on another bill", () => {
    const listed = mapPayments(body("payments-by-reference.json"));
    expect(listed.map((one) => one.status)).toEqual(["deleted", "active"]);
    expect(paymentOnBill(listed, BILL, HASH)?.externalId).toBe("b26fd49a-cbae-470a-a8f8-bcbc119e0379");
    expect(paymentOnBill(listed, "0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0999", HASH)).toMatchObject({ status: "deleted" });
    expect(paymentOnBill(listed, "another-bill", HASH)).toBeNull();
    expect(mapPayment({ Amount: 1 })).toBeNull();
  });

  it("books against the bill, from the account by its id, on the day, for the amount, with the reference", () => {
    expect(paymentBody({ billExternalId: BILL, accountExternalId: ACCOUNT, amount: "31.39", currency: "USD", date: "2026-10-12", reference: HASH })).toEqual({
      Payments: [{ Invoice: { InvoiceID: BILL }, Account: { AccountID: ACCOUNT }, Date: "2026-10-12", Amount: 31.39, Reference: HASH }],
    });
  });

  it("says a refusal in Xero's own words, once each", () => {
    expect(validationMessage(body("payment-validation-error.json"))).toBe("Payment amount exceeds the amount outstanding on this document");
    expect(validationMessage({ Message: "A validation exception occurred" })).toBe("A validation exception occurred");
    expect(validationMessage("nope")).toBeNull();
  });

  it("filters by a reference only when it is a transaction hash", () => {
    expect(referenceFilter(HASH)).toBe(`Reference=="${HASH}"`);
    expect(() => referenceFilter('x" || 1==1')).toThrow(ProviderError);
  });
});

describe("the calls", () => {
  it("reads the organisation in its tenant", async () => {
    const { sent, deps } = recorder(() => json(fixture("organisation-demo.json")));
    expect(await organisation(request, deps)).toMatchObject({ demo: true });
    expect(sent[0].url.toString()).toBe("https://api.xero.com/api.xro/2.0/Organisation");
    expect(sent[0].headers.get("xero-tenant-id")).toBe(TENANT);
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("reads one bill as it is now, and none once Xero has none", async () => {
    const { sent, deps } = recorder(() => json(fixture("invoice-one.json")));
    expect(await bill({ ...request, billId: BILL }, deps)).toMatchObject({ externalId: BILL, status: "open", amountDue: "31.39", currency: "USD" });
    expect(sent[0].url.pathname).toBe(`/api.xro/2.0/Invoices/${BILL}`);
    const gone = recorder(() => new Response("Not found", { status: 404 }));
    expect(await bill({ ...request, billId: BILL }, gone.deps)).toBeNull();
    await expect(bill({ ...request, billId: "../Contacts" }, gone.deps)).rejects.toThrow(ProviderError);
  });

  it("finds a payment by its reference, deleted ones included", async () => {
    const { sent, deps } = recorder(() => json(fixture("payments-by-reference.json")));
    expect(await findPayment({ ...request, billId: BILL, reference: HASH }, deps)).toMatchObject({ externalId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379", status: "active" });
    expect(sent[0].url.pathname).toBe("/api.xro/2.0/Payments");
    expect(sent[0].url.searchParams.get("where")).toBe(`Reference=="${HASH}"`);
  });

  it("falls back to the bill's own payments when Xero will not take the filter", async () => {
    const withPayment = JSON.parse(fixture("invoice-one.json"));
    withPayment.Invoices[0].Payments = [{ PaymentID: "p-77", Date: "/Date(1791763200000+0000)/", Amount: 31.39, Reference: HASH, CurrencyRate: 1 }];
    const { sent, deps } = recorder((call) => (call.url.pathname.endsWith("/Payments") ? new Response("{}", { status: 400 }) : json(withPayment)));
    expect(await findPayment({ ...request, billId: BILL, reference: HASH }, deps)).toMatchObject({ externalId: "p-77", billExternalId: BILL, status: "active" });
    expect(sent.map((call) => call.url.pathname)).toEqual(["/api.xro/2.0/Payments", `/api.xro/2.0/Invoices/${BILL}`]);
  });

  it("books with PUT and an Idempotency-Key, and reads the payment Xero made", async () => {
    const { sent, deps } = recorder(() => json(fixture("payment-created.json")));
    const outcome = await bookPayment(
      { ...request, idempotencyKey: "vestiarion-booking-1-abc", payment: { billExternalId: BILL, accountExternalId: ACCOUNT, amount: "31.39", currency: "USD", date: "2026-10-12", reference: HASH } },
      deps
    );
    expect(outcome).toMatchObject({ ok: true, payment: { externalId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379", amount: "31.39" } });
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].url.toString()).toBe("https://api.xero.com/api.xro/2.0/Payments");
    expect(sent[0].headers.get("idempotency-key")).toBe("vestiarion-booking-1-abc");
    expect(sent[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent[0].body)).toEqual({ Payments: [{ Invoice: { InvoiceID: BILL }, Account: { AccountID: ACCOUNT }, Date: "2026-10-12", Amount: 31.39, Reference: HASH }] });
  });

  it("returns a refusal in Xero's words, and throws on an outage, a timeout or a rate limit", async () => {
    const input = { ...request, idempotencyKey: "k", payment: { billExternalId: BILL, accountExternalId: ACCOUNT, amount: "99", currency: "USD", date: "2026-10-12", reference: HASH } };
    const refused = recorder(() => json(fixture("payment-validation-error.json"), { status: 400 }));
    expect(await bookPayment(input, refused.deps)).toEqual({ ok: false, message: "Payment amount exceeds the amount outstanding on this document" });
    const down = recorder(() => new Response("", { status: 503 }));
    await expect(bookPayment(input, down.deps)).rejects.toMatchObject({ failure: "unavailable" });
    const slow = recorder(() => {
      throw new Error("timeout");
    });
    await expect(bookPayment(input, slow.deps)).rejects.toMatchObject({ failure: "unavailable" });
    const limited = recorder(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    await expect(bookPayment(input, limited.deps)).rejects.toMatchObject({ failure: "rate_limited" });
    const scope = recorder(() => new Response("", { status: 403 }));
    await expect(bookPayment(input, scope.deps)).rejects.toMatchObject({ failure: "forbidden" });
  });

  it("reads a payment back by its id, and none once Xero has none", async () => {
    const { sent, deps } = recorder(() => json(fixture("payment-created.json")));
    expect(await payment({ ...request, paymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379" }, deps)).toMatchObject({ status: "active", reference: HASH });
    expect(sent[0].url.pathname).toBe("/api.xro/2.0/Payments/b26fd49a-cbae-470a-a8f8-bcbc119e0379");
    const gone = recorder(() => new Response("", { status: 404 }));
    expect(await payment({ ...request, paymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379" }, gone.deps)).toBeNull();
  });

  it("is the seam the core calls", async () => {
    const { deps } = recorder(() => json(fixture("organisation-real.json")));
    expect(await xeroBooking(deps).organisation(request)).toMatchObject({ demo: false });
  });
});
