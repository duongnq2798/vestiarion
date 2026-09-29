import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { buildOpenApiDocument, OPERATIONS, operationById } from "@/lib/api/openapi";
import { ApiErrorSchema } from "@/lib/api/schemas";
import type { AuthenticatedKey } from "@/lib/platform/api-keys";
import { GET as getCounterparties } from "@/app/api/v1/counterparties/route";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as getInsights } from "@/app/api/v1/insights/route";
import { GET as getInvoices } from "@/app/api/v1/invoices/route";
import { GET as getLedger } from "@/app/api/v1/ledger/route";
import { GET as getLedgerVerify } from "@/app/api/v1/ledger/verify/route";
import { GET as getMilestones } from "@/app/api/v1/milestones/route";
import { GET as getOpenApi } from "@/app/api/v1/openapi.json/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { GET as getTreasury } from "@/app/api/v1/treasury/route";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

function v1Routes(dir = path.join(process.cwd(), "src/app/api/v1"), prefix = "/api/v1"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...v1Routes(full, `${prefix}/${name.replace(/^\[(.+)\]$/, "{$1}")}`));
    else if (name === "route.ts") out.push(prefix);
  }
  return out;
}

describe("the OpenAPI document", () => {
  it("documents every v1 route exactly once, and nothing else", () => {
    const documented = OPERATIONS.map((op) => op.path).sort();
    expect(documented).toEqual(v1Routes().filter((p) => p !== "/api/v1/openapi.json").sort());
  });

  it("never closes an object to new fields, so adding one to v1 breaks no validating client", () => {
    expect(JSON.stringify(buildOpenApiDocument("https://example.test"))).not.toContain('"additionalProperties":false');
  });

  it("is a structurally valid 3.1 document whose refs all resolve", () => {
    const doc = buildOpenApiDocument("https://example.test") as {
      openapi: string;
      info: object;
      servers: Array<{ url: string }>;
      paths: object;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: "Vestiarion API", version: "v1" });
    expect(doc.servers).toEqual([{ url: "https://example.test" }]);
    expect(doc.components.securitySchemes).toHaveProperty("bearerAuth");
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(doc.components.schemas).toHaveProperty(ref);
    // A `$defs` ref would resolve against the document root, where there is
    // no `$defs`; every schema must be inlined under its component.
    expect(JSON.stringify(doc)).not.toContain("#/$defs/");
  });

  it("gives every operation the key requirement, a 200, and its 401 and 500", () => {
    const doc = buildOpenApiDocument("https://example.test") as {
      paths: Record<string, Record<string, { operationId: string; security: unknown; responses: Record<string, unknown> }>>;
    };
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
    expect(operations.map((op) => op.operationId).sort()).toEqual(OPERATIONS.map((op) => op.id).sort());
    for (const op of operations) {
      expect(op.security, op.operationId).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op.responses), op.operationId).toEqual(expect.arrayContaining(["200", "401", "500"]));
    }
  });

  it("describes the page parameters as the routes enforce them", () => {
    for (const op of OPERATIONS.filter((candidate) => candidate.collection)) {
      expect(op.params.find((p) => p.name === "limit"), op.id).toMatchObject({ type: "integer", default: 50, minimum: 1, maximum: 200 });
      expect(op.params.map((p) => p.name), op.id).toContain("cursor");
      expect(op.errors, op.id).toContain("invalid_request");
    }
    expect(operationById("get-counterparty")?.params).toEqual([expect.objectContaining({ name: "id", in: "path", required: true })]);
    expect(operationById("get-counterparty")?.errors).toContain("not_found");
  });

  it("keeps stable operation ids, which are the reference page URLs", () => {
    expect(OPERATIONS.map((op) => op.id)).toMatchInlineSnapshot(`
      [
        "get-status",
        "list-ledger-entries",
        "verify-ledger",
        "list-invoices",
        "list-counterparties",
        "get-counterparty",
        "list-milestones",
        "get-treasury",
        "get-insights",
      ]
    `);
  });

  it("finds an operation by id, and nothing for an unknown one", () => {
    expect(operationById("list-invoices")?.path).toBe("/api/v1/invoices");
    expect(operationById("nope")).toBeUndefined();
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("serves the document publicly, with no key, cacheable", async () => {
    const response = getOpenApi();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths)).toHaveLength(OPERATIONS.length);
  });
});

/**
 * Each route, driven through the recorded fake database as
 * `tests/api-key-scope.test.ts` drives them, must answer a 200 that parses
 * against its documented schema. The rows put `null` in every nullable column
 * the routes read, which is where a schema that claims a field is always
 * present would be caught.
 */
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return {
    ...actual,
    authenticateApiKey: vi.fn(async () => KEY),
    touchApiKeyUsed: vi.fn(async () => {}),
  };
});

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters" });

const ORG = "0a0a0a0a-0000-4000-8000-00000000000a";
const KEY: AuthenticatedKey = { keyId: "1a1a1a1a-0000-4000-8000-00000000001a", orgId: ORG, scopes: ["read"] };
const COUNTERPARTY_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const AT = "2026-09-29T00:00:00+00:00";

const ORG_ROW = { id: ORG, slug: "org-a", name: "Org A", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };

/** One row per table the v1 routes read, with every nullable column `null`. */
const NULL_ROWS: Record<string, unknown[]> = {
  "/rest/v1/ledger_entries": [{
    seq: 1, id: "e-1", ts: AT, actor: "agent", domain: "ap", action: "cycle_complete", summary: "Cycle complete", detail: null,
    body_hash: "b".repeat(64), signature: "s".repeat(128), prev_hash: "0".repeat(64), hash: "h".repeat(64), signing_key_id: null,
  }],
  "/rest/v1/invoices": [{
    id: "i-1", direction: "payable", status: "pending", amount: "1.5", currency: null, memo: null, po_reference: null, goods_received: null,
    due_date: AT, decided_at: null, settled_at: null, escalated_at: null, agent_reasoning: null, tx_ref: null, created_at: AT, counterparties: null,
  }],
  "/rest/v1/counterparties": [{
    id: COUNTERPARTY_ID, name: "Priya Raman", role: "contractor", address: null, chain: null, jurisdiction: null, risk_level: "unscreened",
    risk_notes: null, baseline_payment_limit: null, payment_limit: null, last_screened_at: null, performance_score: null, performance_inputs: null, created_at: AT,
  }],
  "/rest/v1/compliance_checks": [{
    id: "c-1", counterparty_id: COUNTERPARTY_ID, risk_level: "clear", source: "bundled", notes: null, raw_score: null, matched_entity_id: null,
    screening_mode: "simulate", status: "complete", created_at: AT, counterparties: null,
  }],
  "/rest/v1/milestones": [{
    id: "m-1", title: "Milestone", amount: "2", status: "pending", verification_source: null, verification_method: "unverified",
    verification_status: "unverified", verification_checked_at: null, verified_at: null, verification_detail: null, verified: null,
    decided_at: null, settled_at: null, agent_reasoning: null, tx_ref: null, created_at: AT, counterparties: null,
  }],
  "/rest/v1/accounts": [{ id: "a-1", name: "Operating", kind: "operating", chain: "ARC-TESTNET", token: "USDC", address: null, balance: "0", apy: "0" }],
  "/rest/v1/cycle_snapshots": [{
    id: "s-1", cycle_run_id: "r-1", captured_at: AT, total_liquid: 0, open_payables: 0, open_receivables: 0,
    obligations_due_7d: 0, obligations_due_14d: 0, reserve_position: 0, chain_mode: "simulate",
  }],
  "/rest/v1/forecasts": [{ id: "f-1", as_of: AT, horizon_days: 14, projected_inflow: 0, projected_outflow: 0, liquid_balance: 0, recommendation: null }],
  "/rest/v1/treasury_actions": [{ id: "t-1", action: "rebalance", amount: 1, from_account: null, to_account: null, reasoning: null, created_at: AT }],
  "/rest/v1/payment_intents": [{
    id: "p-1", source_type: "invoice", source_id: "i-1", provider_tx_id: "sim_1", tx_hash: null, fee_usd: 0, fee_source: "simulated_profile",
    settled_in_ms: null, chain: "ARC-TESTNET", provider_mode: "simulate", executed_at: AT, status: "confirmed",
  }],
  "/rest/v1/cycle_runs": [{
    id: "r-1", started_at: AT, finished_at: AT, duration_ms: 1, decision_count: null, paid_count: null, held_count: null, flagged_count: null,
    awaiting_info_count: null, released_count: null, model_decision_count: null, heuristic_decision_count: null, guardrail_override_count: null,
    reference_disagreement_count: null, status: null, failed_stage: null, error_message: null, chain_mode: "simulate", screening_mode: "simulate",
  }],
};

function database(tables: Record<string, unknown[]>) {
  return (request: RecordedRequest) => (request.path === "/rest/v1/orgs" ? { body: ORG_ROW } : { body: tables[request.path] ?? [] });
}

async function call(tables: Record<string, unknown[]>, handler: (request: Request) => Promise<Response>, url: string) {
  const fake = fakeSupabase(database(tables));
  const request = new Request(`https://vestiarion.invalid${url}`, { headers: { authorization: `Bearer vxk_abcdefgh_${"A".repeat(43)}` } });
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => handler(request));
}

const detail = (request: Request) => getCounterparty(request, { params: Promise.resolve({ id: COUNTERPARTY_ID }) });

const ROUTES: Array<[id: string, url: string, handler: (request: Request) => Promise<Response>]> = [
  ["get-status", "/api/v1/status", getStatus],
  ["list-ledger-entries", "/api/v1/ledger", getLedger],
  ["verify-ledger", "/api/v1/ledger/verify", getLedgerVerify],
  ["list-invoices", "/api/v1/invoices", getInvoices],
  ["list-counterparties", "/api/v1/counterparties", getCounterparties],
  ["get-counterparty", `/api/v1/counterparties/${COUNTERPARTY_ID}`, detail],
  ["list-milestones", "/api/v1/milestones", getMilestones],
  ["get-treasury", "/api/v1/treasury", getTreasury],
  ["get-insights", "/api/v1/insights", getInsights],
];

describe("each route's real 200 parses", () => {
  it("drives every documented operation", () => {
    expect(ROUTES.map(([id]) => id).sort()).toEqual(OPERATIONS.map((op) => op.id).sort());
  });

  it.each(ROUTES)("%s, with every nullable column null", async (id, url, handler) => {
    const response = await call(NULL_ROWS, handler, url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(() => operationById(id)!.response.parse(body)).not.toThrow();
    // Nothing the route sends is left out of the schema.
    expect(operationById(id)!.response.parse(body)).toEqual(body);
  });

  it.each(ROUTES.filter(([id]) => id !== "get-counterparty"))("%s, with an empty workspace", async (id, url, handler) => {
    const response = await call({}, handler, url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(operationById(id)!.response.parse(body)).toEqual(body);
  });

  it("answers an unknown counterparty with a 404 in the documented error shape", async () => {
    const response = await call({}, detail, `/api/v1/counterparties/${COUNTERPARTY_ID}`);
    expect(response.status).toBe(404);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("not_found");
    expect(operationById("get-counterparty")!.errors).toContain(body.error.code);
  });
});
