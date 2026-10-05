import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { loadNewPayeeFacts } from "@/lib/new-payee-facts";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2): every address
 * the workspace has made a confirmed payment to, and each counterparty's ledger entries that set or confirmed its
 * address, newest first.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0c0";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function workspace() {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "demo", name: "Demo", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    if (request.path === "/rest/v1/payment_intents") return { body: [{ destination: "0xAbC0000000000000000000000000000000000001" }, { destination: null }] };
    if (request.path === "/rest/v1/ledger_entries") {
      return {
        body: [
          { action: "counterparty_address_confirmed", detail: { by: "bao", counterpartyId: "cp-1", address: "0x2" } },
          { action: "create_counterparty", detail: { by: "anna", counterpartyId: "cp-2", address: "0x3" } },
          { action: "counterparty_address_changed", detail: { by: "anna", counterpartyId: "cp-1", to: "0x2" } },
        ],
      };
    }
    return { body: [] };
  });
}

describe("loadNewPayeeFacts", () => {
  it("reads the confirmed payments' addresses, lowercase, and each counterparty's address entries newest first", async () => {
    const fake = workspace();
    const facts = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => loadNewPayeeFacts(db(), ["cp-1", "cp-2"])));
    expect([...facts.paidTo]).toEqual(["0xabc0000000000000000000000000000000000001"]);
    expect(facts.entries.get("cp-1")?.map((entry) => entry.action)).toEqual(["counterparty_address_confirmed", "counterparty_address_changed"]);
    expect(facts.entries.get("cp-2")?.map((entry) => entry.action)).toEqual(["create_counterparty"]);

    const intents = fake.requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(intents?.params.get("status")).toBe("eq.confirmed");
    const ledger = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries");
    expect(ledger?.params.get("domain")).toBe("eq.compliance");
    expect(ledger?.params.get("action")).toBe("in.(create_counterparty,counterparty_address_changed,counterparty_address_confirmed)");
    expect(ledger?.params.get("detail->>counterpartyId")).toBe("in.(cp-1,cp-2)");
    expect(ledger?.params.get("order")).toBe("seq.desc");
  });

  it("reads no ledger entries when no counterparty is asked about", async () => {
    const fake = workspace();
    const facts = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => loadNewPayeeFacts(db(), [])));
    expect(facts.entries.size).toBe(0);
    expect(fake.requests.some((request) => request.path === "/rest/v1/ledger_entries")).toBe(false);
  });
});
