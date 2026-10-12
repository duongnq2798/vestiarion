import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { connectionFor, NotSetUpError } from "@/lib/connectors/connections";
import { accountingPanelView } from "@/lib/connectors/panel";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * What the Xero card reads (docs/superpowers/specs/2026-10-12-xero-connector-design.md X15, X16): before migration 0101
 * has run it says Xero is not set up yet and nothing fails; without a connection, that none is; with one, its status in
 * business words, the bills waiting, the pages a sync under way has read, and no token anywhere.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e51";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const NOW = Date.parse("2026-10-12T14:00:00.000Z");

const ROW = {
  id: "conn-1", org_id: ORG, provider: "xero", external_org_id: "tenant-1", external_org_name: "Demo Company (Global)", status: "connected", scopes: [],
  connected_by: "u", connected_at: "2026-10-12T07:00:00Z", consent_version: "xero-2026-10-12", consented_at: "2026-10-12T07:00:00Z", revoked_at: null,
  window_from: "2026-07-14", last_synced_at: "2026-10-12T13:55:00Z", last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
  payment_account: { id: "a", code: "091", name: "Arc USDC wallet", currency: "USD" }, payment_account_at: "2026-10-12T08:00:00Z",
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined) {
  const fake = fakeSupabase((sent) => respond(sent) ?? (sent.path === "/rest/v1/orgs" ? { body: orgs.orgRow(ORG) } : { body: [] }));
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  return { fake, run };
}

const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.accounting_connections' in the schema cache" } };

describe("accountingPanelView", () => {
  it("says not set up before migration 0101, and connectionFor says why", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/accounting_connections" ? MISSING : undefined));
    expect(await run(() => accountingPanelView("xero", NOW))).toEqual({ state: "not_set_up" });
    await expect(run(() => connectionFor("xero"))).rejects.toBeInstanceOf(NotSetUpError);
  });

  it("says not connected when the workspace never connected", async () => {
    const { run } = world(() => undefined);
    expect(await run(() => accountingPanelView("xero", NOW))).toEqual({ state: "not_connected" });
  });

  it("reads the connection's status, the bills waiting, a sync under way and the account chosen", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_connections") return { body: [ROW] };
      if (sent.path === "/rest/v1/accounting_bills" && sent.method === "HEAD") {
        return { body: null, headers: { "content-range": sent.params.get("review_state") === "eq.review" ? "*/3" : "*/1" } };
      }
      if (sent.path === "/rest/v1/accounting_sync_cursors") return { body: [{ page: 3 }] };
      if (sent.path === "/rest/v1/accounting_bills") return { body: [{ contact_name: "PowerDirect", number: "PD-4471", amount_due: 1250, currency: "USD" }] };
      return undefined;
    });
    const view = await run(() => accountingPanelView("xero", NOW));
    expect(view).toEqual({
      state: "connection",
      connectionId: "conn-1",
      status: { tone: "ok", title: "Connected to Demo Company (Global)", detail: ["Last synced 5 minutes ago.", "Syncing: 2 of Xero's pages read so far."], reconnect: false },
      connected: true,
      revoked: false,
      organisation: "Demo Company (Global)",
      waiting: 3,
      closedAfterAdded: 1,
      paymentAccount: { id: "a", code: "091", name: "Arc USDC wallet", currency: "USD" },
      sample: { supplier: "PowerDirect", number: "PD-4471", amount: "1250", currency: "USD" },
    });
    // The card reads the tenant tables only: never the tokens.
    expect(fake.requests.some((sent) => sent.path.includes("accounting_tokens"))).toBe(false);
  });

  it("shows a revoked connection when there is no other", async () => {
    const { run } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" ? { body: [{ ...ROW, status: "revoked", revoked_at: "2026-10-12T12:00:00Z" }] } : undefined
    );
    expect(await run(() => accountingPanelView("xero", NOW))).toMatchObject({ state: "connection", revoked: true, waiting: 0, status: { title: "Disconnected from Demo Company (Global)" } });
  });
});
