import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { apiError, handleApiRequest } from "@/lib/api/guard";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("handleApiRequest", () => {
  it("runs the handler in the founding organization — the transitional binding of spec §4.5", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/orgs"
        ? { body: { id: FOUNDING_ORG_ID, slug: "founding", name: "Vestiarion workspace", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
        : { body: [] }
    );
    const response = await runWith({ config, db: fake.client }, () => handleApiRequest("test", async () => ({ orgId: currentOrgId() })));
    expect(await response.json()).toEqual({ orgId: FOUNDING_ORG_ID });
  });

  it("sends a coded error the handler settles on inside that scope as it is", async () => {
    const fake = fakeSupabase(foundingDatabase({}));
    const response = await runWith({ config, db: fake.client }, () =>
      handleApiRequest("test", async () => apiError("not_found", "Nothing here."))
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Nothing here." } });
  });
});

/**
 * The one v1 route that looks a caller-supplied id up. It used to do that
 * before entering `handleApiRequest`, which is now where the founding
 * organization is entered; these pin that the lookup happens inside it.
 */
describe("GET /api/v1/counterparties/{id}", () => {
  const TOKEN = "api-founding-scope-test-token";
  const ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
  const previousToken = process.env.AGENT_API_TOKEN;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
    else process.env.AGENT_API_TOKEN = previousToken;
  });

  async function get(fake: ReturnType<typeof fakeSupabase>) {
    process.env.AGENT_API_TOKEN = TOKEN;
    const request = new Request(`https://vestiarion.invalid/api/v1/counterparties/${ID}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return runWith({ config, db: fake.client }, () => getCounterparty(request, { params: Promise.resolve({ id: ID }) }));
  }

  function tenantRequests(fake: ReturnType<typeof fakeSupabase>): RecordedRequest[] {
    return fake.requests.filter((request) => request.path !== "/rest/v1/orgs");
  }

  it("answers an id the founding organization does not hold as not found", async () => {
    const fake = fakeSupabase(foundingDatabase({}));
    const response = await get(fake);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: `Counterparty "${ID}" was not found.` } });
    expect(tenantRequests(fake).map((request) => [request.path, request.params.get("id")])).toEqual([
      ["/rest/v1/counterparties", `eq.${ID}`],
    ]);
    for (const request of tenantRequests(fake)) expect(carriesOrg(request, FOUNDING_ORG_ID)).toBe(true);
  });

  it("serves one it does hold, with its screening history, asking only within that organization", async () => {
    const fake = fakeSupabase(
      foundingDatabase({
        "/rest/v1/counterparties": [{ id: ID, name: "Priya Raman", role: "contractor", risk_level: "clear", created_at: "2026-09-28T00:00:00Z" }],
        "/rest/v1/compliance_checks": [{ id: "check-1", risk_level: "clear", source: "bundled", screening_mode: "simulate", status: "complete", created_at: "2026-09-28T00:00:00Z" }],
      })
    );
    const response = await get(fake);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; screeningHistory: Array<{ id: string }> } };
    expect(body.data.id).toBe(ID);
    expect(body.data.screeningHistory.map((check) => check.id)).toEqual(["check-1"]);
    expect(tenantRequests(fake).map((request) => request.path)).toEqual(["/rest/v1/counterparties", "/rest/v1/compliance_checks"]);
    for (const request of tenantRequests(fake)) expect(carriesOrg(request, FOUNDING_ORG_ID)).toBe(true);
  });
});

/**
 * An organization whose Circle credentials are stored but cannot be read
 * refuses to pay rather than fall back to simulation (R12). Status must say
 * that, not report payments as simulated — a client reading `simulate` would
 * expect a cycle to settle invoices, and none will.
 */
describe("GET /api/v1/status", () => {
  const TOKEN = "api-status-test-token";
  const previousToken = process.env.AGENT_API_TOKEN;
  const previousMasterKeys = process.env.VESTIARION_MASTER_KEYS;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
    else process.env.AGENT_API_TOKEN = previousToken;
    if (previousMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
    else process.env.VESTIARION_MASTER_KEYS = previousMasterKeys;
  });

  async function status(foundingRow: Record<string, unknown>) {
    process.env.AGENT_API_TOKEN = TOKEN;
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: foundingRow } : { body: [] }));
    const request = new Request("https://vestiarion.invalid/api/v1/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    const response = await runWith({ config, db: fake.client }, () => getStatus(request));
    return { response, body: (await response.json()) as { data: { provenance: Record<string, string> } } };
  }

  it("reports payments and yield as unavailable when the stored Circle credentials cannot be read", async () => {
    // Sealed under a master key this deployment no longer holds.
    const retired = parseMasterKeys(`retired:${crypto.randomBytes(32).toString("base64")}`);
    process.env.VESTIARION_MASTER_KEYS = `current:${crypto.randomBytes(32).toString("base64")}`;
    const { response, body } = await status({
      ...FOUNDING_ROW,
      circle_api_key_enc: encryptSecret("circle-key", { orgId: FOUNDING_ORG_ID, column: "circle_api_key_enc" }, retired),
      circle_entity_secret_enc: encryptSecret("entity-secret", { orgId: FOUNDING_ORG_ID, column: "circle_entity_secret_enc" }, retired),
    });

    expect(response.status).toBe(200);
    expect(body.data.provenance).toEqual({ payments: "unavailable", yield: "unavailable", screening: "simulate" });
  });

  it("still reports simulate for an organization with no Circle credentials stored", async () => {
    const { body } = await status(FOUNDING_ROW);
    expect(body.data.provenance).toEqual({ payments: "simulate", yield: "simulate", screening: "simulate" });
  });
});

const FOUNDING_ROW = { id: FOUNDING_ORG_ID, slug: "founding", name: "Vestiarion workspace", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };

/** The founding organization's row, plus whatever tenant rows a test puts in `tables`. */
function foundingDatabase(tables: Record<string, unknown[]>) {
  return (request: RecordedRequest) =>
    request.path === "/rest/v1/orgs" ? { body: FOUNDING_ROW } : { body: tables[request.path] ?? [] };
}
