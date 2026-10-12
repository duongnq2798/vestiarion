import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/platform/accounting-sync/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { currentOrgId } from "@/lib/context";
import type { CrmProvider } from "@/lib/connectors/crm";
import type { AccountingProvider } from "@/lib/connectors/provider";
import { sweepAccounting } from "@/lib/connectors/sweep";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * The accounting sweeper (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X7, X16): each connection due
 * runs in its own workspace's scope, one held by another run is left, a provider this deployment has not set up is
 * skipped, a grant nobody finished choosing for is revoked and deleted, and before migration 0101 has run there is
 * nothing to do. The route answers only with its bearer token, and only with counts.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

function world(respond: (sent: RecordedRequest) => FakeReply | undefined) {
  const fake = fakeSupabase((sent) => respond(sent) ?? (sent.path === "/rest/v1/orgs" ? { body: orgs.orgRow(ORG) } : { body: [] }));
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const revoke = vi.fn(async () => true);
const xero = { id: "xero", revoke } as unknown as AccountingProvider;

describe("sweepAccounting", () => {
  it("has nothing to do before migration 0101 has run", async () => {
    const { run } = world((sent) =>
      sent.path === "/rest/v1/rpc/accounting_connections_due" ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.accounting_connections_due" } } : undefined
    );
    expect(await run(() => sweepAccounting({ providerFor: () => xero }))).toMatchObject({ setUp: false, connections: 0 });
  });

  it("runs each connection due in its own workspace, leaves one another run holds, and skips a provider not set up", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/rpc/accounting_connections_due") {
        return { body: [{ org_id: ORG, connection_id: "conn-1", provider: "xero" }, { org_id: ORG, connection_id: "conn-2", provider: "quickbooks" }] };
      }
      // Another run holds the lease: the claim updates nothing.
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [] };
      return undefined;
    });
    const summary = await run(() => sweepAccounting({ providerFor: (id) => (id === "xero" ? xero : null) }));
    expect(summary).toEqual({ setUp: true, connections: 1, synced: 0, partial: 0, failed: 0, reconnect: 0, busy: 1, pendingRevoked: 0 });
    const claim = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH");
    expect(claim?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(claim?.params.get("id")).toBe("eq.conn-1");
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/rpc/accounting_connections_due")?.body).toEqual({ p_limit: 50 });
  });

  describe("pending grants", () => {
    const masterKeys = `t1:${crypto.randomBytes(32).toString("base64")}`;
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.VESTIARION_MASTER_KEYS;
      process.env.VESTIARION_MASTER_KEYS = masterKeys;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
      else process.env.VESTIARION_MASTER_KEYS = saved;
    });

    it("revokes and deletes a grant nobody finished choosing for", async () => {
      const keys = parseMasterKeys(masterKeys);
      const row = {
        id: "tok-p", org_id: ORG, provider: "xero", connection_id: null, authorized_by: "u", access_expires_at: "2026-10-12T08:30:00Z", scopes: [], version: 1,
        choices: [], choose_until: "2026-10-12T07:40:00Z",
        access_token_enc: encryptSecret("access-p", { orgId: ORG, column: "accounting_tokens.access_token_enc/tok-p" }, keys),
        refresh_token_enc: encryptSecret("refresh-p", { orgId: ORG, column: "accounting_tokens.refresh_token_enc/tok-p" }, keys),
      };
      const { fake, run } = world((sent) => {
        if (sent.path === "/rest/v1/rpc/accounting_connections_due") return { body: [] };
        if (sent.path === "/rest/v1/orgs") return { body: { ...orgs.orgRow(ORG), ledger_signing_key_enc: null } };
        if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET") return { body: [row] };
        return undefined;
      });
      revoke.mockClear();
      const summary = await run(() => sweepAccounting({ providerFor: () => xero, now: () => Date.parse("2026-10-12T08:00:00.000Z") }));
      expect(summary.pendingRevoked).toBe(1);
      expect(revoke).toHaveBeenCalledWith("refresh-p");
      const removed = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "DELETE");
      expect(removed?.params.get("id")).toBe("eq.tok-p");
    });
  });

  it("syncs a CRM connection with the CRM runner, in its own workspace (HubSpot connector H7)", async () => {
    const { run } = world((sent) =>
      sent.path === "/rest/v1/rpc/accounting_connections_due" ? { body: [{ org_id: ORG, connection_id: "conn-hub", provider: "hubspot" }] } : undefined
    );
    const hubspot = { id: "hubspot", kind: "crm" } as unknown as CrmProvider;
    const seen: Array<{ connectionId: string; org: string }> = [];
    const sync = vi.fn(async (connectionId: string) => {
      seen.push({ connectionId, org: currentOrgId() });
      return { outcome: "synced" as const };
    });
    const summary = await run(() => sweepAccounting({ providerFor: () => xero, crm: { providerFor: (id) => (id === "hubspot" ? hubspot : null), sync } }));
    expect(summary).toMatchObject({ connections: 1, synced: 1 });
    expect(seen).toEqual([{ connectionId: "conn-hub", org: ORG }]);
    expect(sync).toHaveBeenCalledWith("conn-hub", hubspot);
  });
});

describe("POST /api/platform/accounting-sync", () => {
  it("answers 401 without the agent's bearer token, and reads nothing", async () => {
    const saved = process.env.AGENT_API_TOKEN;
    process.env.AGENT_API_TOKEN = "agent-token-for-tests-0123456789";
    try {
      const response = await POST(new Request("https://www.vestiarion.xyz/api/platform/accounting-sync", { method: "POST" }));
      expect(response.status).toBe(401);
    } finally {
      if (saved === undefined) delete process.env.AGENT_API_TOKEN;
      else process.env.AGENT_API_TOKEN = saved;
    }
  });
});
