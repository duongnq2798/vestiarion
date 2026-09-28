import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createInvoiceAction } from "@/app/actions/intake";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `createInvoiceAction` against a real supabase-js client whose network is a
 * recorder. Two stand-ins, both for things a node test cannot have: the
 * `server-only` marker, which Next resolves itself and which is not installed
 * as a package, and the signed-in session behind `authorizeMutation`, which
 * reads request cookies. Everything after authorization is the real action,
 * entering the organization through the real `inOrg`.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({
  authorizeMutation: async () => ({
    ok: true,
    user: { id: USER, email: null },
    membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", role: "owner" },
  }),
}));

const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

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
function organizationDatabase(counterparties: Array<{ id: string; name: string }>) {
  return (sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (sent.path === "/rest/v1/counterparties") {
      const found = counterparties.filter((row) => sent.params.get("id") === `eq.${row.id}`);
      if (!wantsObject) return { body: found };
      if (found.length === 1) return { body: found[0] };
      return {
        status: 406,
        body: { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "Cannot coerce the result to a single JSON object" },
      };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1" } };
    return { body: [] };
  };
}

describe("createInvoiceAction's counterparty lookup", () => {
  it("answers a counterparty this organization does not hold as not found, and adds nothing", async () => {
    // Another organization's counterparty id, or one that never existed: the
    // lookup is scoped to this organization, so both find nothing — and the
    // form says so in words rather than in PostgREST's.
    const fake = fakeSupabase(organizationDatabase([]));
    const result = await runWith({ config, db: fake.client }, () => createInvoiceAction({ ok: false, message: "" }, invoiceForm()));

    expect(result).toEqual({ ok: false, message: "Counterparty not found." });
    const lookup = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties");
    expect(lookup?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(lookup?.params.get("id")).toBe(`eq.${COUNTERPARTY}`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
    expect(fake.requests.some((sent) => sent.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });

  it("goes on to add the invoice for a counterparty it does hold", async () => {
    const fake = fakeSupabase(organizationDatabase([{ id: COUNTERPARTY, name: "Acme Supplies" }]));
    await runWith({ config, db: fake.client }, () => createInvoiceAction({ ok: false, message: "" }, invoiceForm()));

    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ counterparty_id: COUNTERPARTY, org_id: ORG, created_by: USER });
  });
});
