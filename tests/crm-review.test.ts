import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import { crmReview } from "@/lib/connectors/crm-review";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * The HubSpot list on Bills & receivables (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H13): the
 * billing email offered for a customer is the one Use this email fills, the company's main contact's email as HubSpot
 * gave it last, whatever order the deals are listed in.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const CUSTOMER = "cccccccc-0000-4000-8000-0000000000c1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const connection = { id: "conn-1", provider: "hubspot", status: "connected", externalOrgId: "48291736", externalOrgName: "northstar-studio.example" } as Connection;

const row = (id: string, fields: Record<string, unknown>) => ({
  id, connection_id: "conn-1", external_id: `ext-${id}`, name: `Deal ${id}`, amount: 1000, currency: "USD", close_on: "2026-10-01", pipeline_label: "Sales Pipeline",
  stage_label: "Closed Won", stage_state: "won", company_external_id: "9100000001", company_name: "Northwind Labs", company_email: null, source_status: "present",
  deal_id: null, baseline: null, flagged: null, external_updated_at: "2026-10-01T00:00:00.000Z", ...fields,
});

describe("crmReview's billing emails", () => {
  it("offers the email HubSpot gave last for the company, which is the one Use this email fills", async () => {
    // Listed by close day, newest first: the deal read last closed earlier, and carries the contact's email now.
    const rows = [
      row("a", { close_on: "2026-10-05", company_email: "old@northwind.example", external_updated_at: "2026-10-02T00:00:00.000Z" }),
      row("b", { close_on: "2026-09-01", company_email: "billing@northwind.example", external_updated_at: "2026-10-11T00:00:00.000Z" }),
      row("c", { close_on: "2026-08-01", company_email: "older@northwind.example", external_updated_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/crm_deals") return { body: rows };
      if (sent.path === "/rest/v1/external_links") return { body: [{ external_id: "9100000001", local_id: CUSTOMER }] };
      if (sent.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Northwind Labs", notice_email: null }] };
      return { body: [] };
    });
    const view = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => crmReview(connection));
    expect(view.state === "list" ? view.emails : null).toEqual([{ counterpartyId: CUSTOMER, name: "Northwind Labs", email: "billing@northwind.example" }]);
  });
});
