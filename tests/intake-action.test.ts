import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createInvoiceAction } from "@/app/actions/intake";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `createInvoiceAction` against a real supabase-js
 * client whose network is a recorder. Two stand-ins, both for things a node test cannot have: the
 * `server-only` marker, which Next resolves itself and which is not installed
 * as a package, and the signed-in session behind `authorize`, which
 * reads request cookies. Everything after authorization is the real action,
 * entering the organization through the real `inOrg`.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
}));

vi.mock("server-only", () => ({}));
const { rateMock } = vi.hoisted(() => ({ rateMock: vi.fn() }));
vi.mock("@/lib/fx/usd-rates", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/fx/usd-rates")>()), usdRate: rateMock }));
vi.mock("@/lib/auth/authorize", () => ({
  authorize: async () => ({
    ok: true,
    user: { id: USER, email: null },
    membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", role: "owner" },
  }),
}));

const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters" });

function invoiceForm(): FormData {
  const form = new FormData();
  form.set("orgSlug", "northstar");
  form.set("direction", "payable");
  form.set("counterpartyId", COUNTERPARTY);
  form.set("amount", "10.50");
  form.set("memo", "Services");
  form.set("poReference", "PO-42");
  form.set("goodsReceived", "on");
  form.set("dueDate", "2026-10-31");
  return form;
}

/**
 * The organization's row, and a counterparties table holding `counterparties`,
 * answered the way PostgREST answers: an object request for a row that is not
 * there is a 406, an array request is `[]`.
 */
function organizationDatabase(counterparties: Array<{ id: string; name: string }>, shadowOn = false) {
  return (sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (sent.path === "/rest/v1/counterparties") {
      // The form looks one up by id.
      const found = sent.params.get("id") ? counterparties.filter((row) => sent.params.get("id") === `eq.${row.id}`) : counterparties;
      if (!wantsObject) return { body: found };
      if (found.length === 1) return { body: found[0] };
      return {
        status: 406,
        body: { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "Cannot coerce the result to a single JSON object" },
      };
    }
    if (sent.path === "/rest/v1/shadow_modes") return { body: shadowOn ? [{ currency: "VND", started_at: "2026-10-07T00:00:00Z", started_by: USER }] : [] };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") {
      const id = (index: number) => `0b6c1c9e-4a4f-4a7e-9b1e-0000000001a${index + 1}`;
      return { body: Array.isArray(sent.body) ? sent.body.map((_, index) => ({ id: id(index) })) : { id: id(0) } };
    }
    return { body: [] };
  };
}

describe("createInvoiceAction's counterparty lookup", () => {
  it("answers a counterparty this organization does not hold as not found, and adds nothing", async () => {
    // Another organization's counterparty id, or one that never existed: the
    // lookup is scoped to this organization, so both find nothing — and the
    // form says so in words rather than in PostgREST's.
    const fake = fakeSupabase(organizationDatabase([]));
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, invoiceForm()));

    expect(result).toEqual({ ok: false, message: "Counterparty not found." });
    const lookup = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties");
    expect(lookup?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(lookup?.params.get("id")).toBe(`eq.${COUNTERPARTY}`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
    expect(fake.requests.some((sent) => sent.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });

  it("goes on to add the invoice for a counterparty it does hold", async () => {
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, invoiceForm()));

    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ counterparty_id: COUNTERPARTY, org_id: ORG, created_by: USER });
  });

  it("inserts the invoice's currency: EURC when the form says so, and USDC by default", async () => {
    for (const [currency, expected] of [["EURC", "EURC"], [null, "USDC"]] as const) {
      const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
      const form = invoiceForm();
      if (currency) form.set("currency", currency);
      await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, form));
      const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
      expect(insert?.body).toMatchObject({ currency: expected });
    }
  });

  it("inserts no discount terms when the form leaves them blank", async () => {
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, invoiceForm()));

    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ early_pay_discount_pct: null, discount_due_date: null });
  });

  it("inserts the discount percent and the deadline at noon UTC when the form carries terms", async () => {
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
    const form = invoiceForm();
    form.set("earlyPayDiscountPct", "2");
    form.set("discountDeadline", "2026-10-20");
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, form));

    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ early_pay_discount_pct: "2", discount_due_date: "2026-10-20T12:00:00.000Z" });
  });

  it("refuses a discount percent without its deadline with an error on the deadline field, and adds nothing", async () => {
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
    const form = invoiceForm();
    form.set("earlyPayDiscountPct", "2");
    form.set("discountDeadline", "");
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, form));

    expect(result).toEqual({
      ok: false,
      message: "Discount deadline: Enter the last day the discount applies, on or before the due date, or clear the discount.",
      fieldErrors: { discountDeadline: "Enter the last day the discount applies, on or before the due date, or clear the discount." },
    });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });
});

describe("createInvoiceAction and a bill in the business's own currency (shadow mode S6)", () => {
  const VND = { currency: "VND", perUsd: 25_935.897512, source: "ExchangeRate-API", at: "2026-10-07T00:02:32.000Z" };
  const billForm = () => {
    const form = invoiceForm();
    form.set("currency", "VND");
    form.set("amount", "2.500.000");
    return form;
  };

  it("adds it in shadow mode at its USDC amount, with the bill's own figure and the rate", async () => {
    rateMock.mockReset().mockResolvedValue(VND);
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }], true));
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, billForm()));

    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({
      amount: "96.39",
      currency: "USDC",
      original_currency: "VND",
      original_amount: 2_500_000,
      fx_rate: 25_935.897512,
      fx_source: "ExchangeRate-API",
      fx_at: "2026-10-07T00:02:32.000Z",
    });
    expect(rateMock).toHaveBeenCalledWith("VND");
  });

  it("refuses it outside shadow mode, and adds nothing", async () => {
    rateMock.mockReset().mockResolvedValue(VND);
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }], false));
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, billForm()));

    expect(result).toEqual({ ok: false, message: "A bill in another currency is taken in shadow mode only. Vestiarion pays in USDC or EURC." });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });

  it("says when the day's rate could not be read, and adds nothing", async () => {
    const { FxRateError } = await import("@/lib/fx/usd-rates");
    rateMock.mockReset().mockRejectedValue(new FxRateError("The day's rate could not be read. Try again in a moment."));
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }], true));
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => createInvoiceAction({ ok: false, message: "" }, billForm()));

    expect(result).toEqual({ ok: false, message: "The day's rate could not be read. Try again in a moment." });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });
});
