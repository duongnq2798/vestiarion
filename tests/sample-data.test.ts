import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { hasSampleData, loadSampleData, removeSampleData, SampleDataError, sampleFixture, type SampleKey } from "@/lib/sample-data";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/sample-data.ts` against a real supabase-js client whose network is
 * a recorder, inside a real organization scope with a real ledger key, as
 * tests/counterparty-limit.test.ts does.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a5";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a5";
const NOW = new Date("2026-09-30T12:00:00.000Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

interface OrgState {
  mode: "sandbox" | "live";
  wallet_host: "own" | "hosted" | null;
  api_key_iv: string | null;
}

function orgRow(state: OrgState) {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: state.mode,
    wallet_host: state.wallet_host,
    api_key_iv: state.api_key_iv,
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const LEDGER_REPLY: FakeReply = {
  body: {
    seq: 1, id: "e1", ts: "2026-09-30T00:00:00Z", actor: "human", domain: "system", action: "x",
    summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
  },
};

function sampleFake(options: {
  org?: Partial<OrgState>;
  counterpartyInsert?: (request: RecordedRequest) => FakeReply | undefined;
  invoiceInsert?: (request: RecordedRequest) => FakeReply | undefined;
  sampleCounterparties?: Array<{ id: string }>;
  invoices?: Array<{ id: string; status?: string; reviewed_at?: string | null }>;
  milestones?: Array<{ id: string }>;
  intents?: Array<{ id: string; status: string }>;
  runningCycles?: Array<{ id: string }>;
} = {}) {
  const org: OrgState = { mode: "sandbox", wallet_host: null, api_key_iv: null, ...options.org };
  const fake = fakeSupabase((request) => {
    const { path, method } = request;
    if (path === "/rest/v1/orgs") return { body: orgRow(org) };
    if (path === "/rest/v1/cycle_runs") return { body: options.runningCycles ?? [] };
    if (path === "/rest/v1/counterparties" && method === "POST") {
      const custom = options.counterpartyInsert?.(request);
      if (custom) return custom;
      const rows = request.body as Array<{ name: string }>;
      return { status: 201, body: rows.map((row, index) => ({ id: `cp-${index}`, name: row.name })) };
    }
    if (path === "/rest/v1/counterparties" && method === "GET") return { body: options.sampleCounterparties ?? [] };
    if (path === "/rest/v1/counterparties" && method === "DELETE") return { body: options.sampleCounterparties ?? [] };
    if (path === "/rest/v1/invoices" && method === "POST") return options.invoiceInsert?.(request) ?? { status: 201, body: null };
    if (path === "/rest/v1/invoices" && method === "GET") return { body: options.invoices ?? [] };
    if (path === "/rest/v1/milestones" && method === "POST") return { status: 201, body: null };
    if (path === "/rest/v1/milestones" && method === "GET") return { body: options.milestones ?? [] };
    if (path === "/rest/v1/payment_intents" && method === "GET") return { body: options.intents ?? [] };
    if (path === "/rest/v1/payment_intents" && method === "DELETE") return { body: null };
    if (path === "/rest/v1/ledger_entries" && method === "GET") return { body: [] };
    if (path === "/rest/v1/rpc/append_ledger_entry") return LEDGER_REPLY;
    throw new Error(`unexpected request ${method} ${path}`);
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

const requestsTo = (requests: RecordedRequest[], path: string, method: string) =>
  requests.filter((request) => request.path === path && request.method === method);
const ledgerBodies = (requests: RecordedRequest[]) =>
  requestsTo(requests, "/rest/v1/rpc/append_ledger_entry", "POST").map((request) => request.body as Record<string, unknown>);

async function refusal(work: Promise<unknown>): Promise<SampleDataError> {
  const error = await work.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SampleDataError);
  return error as SampleDataError;
}

describe("sampleFixture", () => {
  const fixture = sampleFixture(NOW);

  it("has six fictional counterparties with no address, and limits on everyone the agent pays", () => {
    expect(fixture.counterparties.map((row) => row.name)).toEqual([
      "Northwind Hosting",
      "Harbor Office Supply",
      "Kestrel Print Co",
      "Lumen Retail Co",
      "Pinecrest Engineering — Backend Contractor",
      "Marlow Design Studio — Design Contractor",
    ]);
    for (const row of fixture.counterparties) {
      expect(row).not.toHaveProperty("address");
      if (row.role !== "client") expect(row.limit).toBeGreaterThan(0);
    }
  });

  it("stays inside the 10,000 USDC a new sandbox starts with", () => {
    const outgoing =
      fixture.invoices.filter((row) => row.direction === "payable" && row.status !== "paid").reduce((sum, row) => sum + row.amount, 0) +
      fixture.milestones.reduce((sum, row) => sum + row.amount, 0);
    expect(outgoing).toBeLessThan(10_000);
  });

  it("dates everything from the moment it is loaded", () => {
    const due = (memo: string, status?: string) =>
      fixture.invoices.find((row) => row.memo === memo && row.status === status)?.due_date;
    expect(due("Hosting — September")).toBe("2026-10-03T12:00:00.000Z");
    expect(due("Brochure print run", "paid")).toBe("2026-09-10T12:00:00.000Z");
    expect(due("Brochure print run")).toBe("2026-10-02T12:00:00.000Z");
  });

  it("sets up each outcome from the invoice facts and the limits alone", () => {
    const byMemo = (memo: string) => fixture.invoices.filter((row) => row.memo === memo);
    // Paid: a full three-way match under the limit.
    expect(byMemo("Hosting — September")[0]).toMatchObject({ counterparty: "northwind", amount: 240, po_reference: "PO-1042", goods_received: true });
    // Awaiting information: no purchase order, nothing received.
    expect(byMemo("Bandwidth overage")[0]).toMatchObject({ po_reference: null, goods_received: false });
    // Held: over Harbor's 500 limit.
    expect(byMemo("Standing desks")[0]).toMatchObject({ counterparty: "harbor", amount: 1200 });
    expect(fixture.counterparties.find((row) => row.key === "harbor")?.limit).toBe(500);
    // Flagged: the same purchase order and amount as one already paid.
    const [paid, repeat] = byMemo("Brochure print run");
    expect(paid).toMatchObject({ status: "paid", po_reference: "PO-3307", amount: 180 });
    expect(repeat).toMatchObject({ po_reference: "PO-3307", amount: 180 });
    expect(repeat.status).toBeUndefined();
    // Milestones: one verified to release, one waiting.
    expect(fixture.milestones.map((row) => [row.contractor, row.verified])).toEqual([["pinecrest", true], ["marlow", false]]);
  });

  it("keeps every outcome when screening finds a medium risk", () => {
    // 0.25 mirrors paymentLimitForRisk("medium", limit) in src/lib/compliance.ts.
    const MEDIUM_FACTOR = 0.25;
    const limitOf = (key: SampleKey) => fixture.counterparties.find((row) => row.key === key)?.limit as number;

    // The only payable expected to pay: a full three-way match under the limit.
    // (The repeat Kestrel invoice only matters as flagged, so it is skipped here.)
    const paying = fixture.invoices.find((row) => row.memo === "Hosting — September" && row.status !== "paid");
    expect(paying?.amount).toBeLessThanOrEqual(limitOf("northwind") * MEDIUM_FACTOR);

    // Every verified milestone must still clear a quarter of its contractor's limit.
    for (const milestone of fixture.milestones.filter((row) => row.verified)) {
      expect(milestone.amount).toBeLessThanOrEqual(limitOf(milestone.contractor) * MEDIUM_FACTOR);
    }

    // Harbor's held invoice is over the limit outright, so medium risk changes nothing.
    const held = fixture.invoices.find((row) => row.memo === "Standing desks");
    expect(held?.amount).toBeGreaterThan(limitOf("harbor"));
  });
});

describe("loadSampleData", () => {
  it("inserts marked counterparties, then their invoices and milestones by id, and records counts only", async () => {
    const { fake, run } = sampleFake();

    const counts = await run(() => loadSampleData({ actorId: ACTOR, now: NOW }));

    expect(counts).toEqual({ counterparties: 6, invoices: 6, milestones: 2 });
    const [counterparties] = requestsTo(fake.requests, "/rest/v1/counterparties", "POST");
    const rows = counterparties.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.sample).toBe(true);
      expect(row.chain).toBe("ARC-TESTNET");
      expect(row.payment_limit).toBe(row.baseline_payment_limit);
      expect(row).not.toHaveProperty("address");
    }
    const [invoices] = requestsTo(fake.requests, "/rest/v1/invoices", "POST");
    const invoiceRows = invoices.body as Array<Record<string, unknown>>;
    expect(invoiceRows).toHaveLength(6);
    // Harbor is the second counterparty inserted, so its invoice points at the id the insert returned for it.
    expect(invoiceRows.find((row) => row.memo === "Standing desks")?.counterparty_id).toBe("cp-1");
    expect(invoiceRows.every((row) => !("counterparty" in row))).toBe(true);
    const [milestones] = requestsTo(fake.requests, "/rest/v1/milestones", "POST");
    expect((milestones.body as Array<Record<string, unknown>>).map((row) => row.contractor_id)).toEqual(["cp-4", "cp-5"]);

    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("sample_data_loaded");
    expect(entry.p_domain).toBe("system");
    expect(entry.p_actor).toBe("human");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterparties: 6, invoices: 6, milestones: 2 });
  });

  it.each([
    [{ mode: "live" as const }, "not_sandbox"],
    [{ wallet_host: "hosted" as const }, "connected"],
    [{ wallet_host: "own" as const }, "connected"],
    [{ api_key_iv: "iv-1" }, "connected"],
  ])("refuses a workspace that is %j, before writing anything", async (org, code) => {
    const { fake, run } = sampleFake({ org });

    const error = await refusal(run(() => loadSampleData({ actorId: ACTOR, now: NOW })));

    expect(error.code).toBe(code);
    expect(fake.requests.filter((request) => request.method !== "GET" && request.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("answers already_loaded when the one-sample-set index refuses the insert", async () => {
    const { fake, run } = sampleFake({
      counterpartyInsert: () => ({
        status: 409,
        body: { code: "23505", message: 'duplicate key value violates unique constraint "counterparties_one_sample_set"', details: null, hint: null },
      }),
    });

    const error = await refusal(run(() => loadSampleData({ actorId: ACTOR, now: NOW })));

    expect(error.code).toBe("already_loaded");
    expect(error.message).toBe("Sample data is already loaded.");
    expect(ledgerBodies(fake.requests)).toEqual([]);
  });

  it("removes the counterparties it just inserted when the invoices are refused, then reports the failure", async () => {
    const { fake, run } = sampleFake({
      invoiceInsert: () => ({ status: 400, body: { code: "23514", message: "invoices_status_check", details: null, hint: null } }),
    });

    await expect(run(() => loadSampleData({ actorId: ACTOR, now: NOW }))).rejects.toThrow("invoices_status_check");

    const [cleanup] = requestsTo(fake.requests, "/rest/v1/counterparties", "DELETE");
    expect(cleanup.params.get("id")).toBe("in.(cp-0,cp-1,cp-2,cp-3,cp-4,cp-5)");
    expect(ledgerBodies(fake.requests)).toEqual([]);
  });
});

describe("removeSampleData", () => {
  it("deletes the sample obligations' payment intents, then the sample counterparties, and records counts only", async () => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }, { id: "cp-1" }],
      invoices: [{ id: "inv-0" }],
      milestones: [{ id: "ms-0" }],
      intents: [{ id: "pi-0", status: "confirmed" }],
    });

    const result = await run(() => removeSampleData({ actorId: ACTOR }));

    expect(result).toEqual({ counterparties: 2, invoices: 1, milestones: 1, paymentIntents: 1 });
    const [intentLookup] = requestsTo(fake.requests, "/rest/v1/payment_intents", "GET");
    expect(intentLookup.params.get("source_id")).toBe("in.(inv-0,ms-0)");
    const deletes = fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    // Intents first: once the counterparties go, nothing would name those intents any more.
    expect(deletes).toEqual(["/rest/v1/payment_intents", "/rest/v1/counterparties"]);
    const [counterpartyDelete] = requestsTo(fake.requests, "/rest/v1/counterparties", "DELETE");
    expect(counterpartyDelete.params.get("sample")).toBe("eq.true");

    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("sample_data_removed");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterparties: 2, invoices: 1, milestones: 1, paymentIntents: 1 });
  });

  it("skips the intent delete when no sample obligation has one", async () => {
    const { fake, run } = sampleFake({ sampleCounterparties: [{ id: "cp-0" }] });

    await run(() => removeSampleData({ actorId: ACTOR }));

    expect(requestsTo(fake.requests, "/rest/v1/payment_intents", "GET")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/payment_intents", "DELETE")).toEqual([]);
  });

  it("refuses when there is nothing to remove", async () => {
    const { run } = sampleFake();
    expect((await refusal(run(() => removeSampleData({ actorId: ACTOR })))).code).toBe("not_loaded");
  });

  it("refuses while a cycle is running, and deletes nothing", async () => {
    const { fake, run } = sampleFake({ sampleCounterparties: [{ id: "cp-0" }], runningCycles: [{ id: "run-1" }] });

    const error = await refusal(run(() => removeSampleData({ actorId: ACTOR })));

    expect(error.code).toBe("cycle_running");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toEqual([]);
    const [lookup] = requestsTo(fake.requests, "/rest/v1/cycle_runs", "GET");
    expect(lookup.params.get("status")).toBe("eq.running");
    expect(lookup.params.get("started_at")).toMatch(/^gt\./);
  });

  it.each(["submitting", "pending"])("refuses while a sample payment is %s, and deletes nothing", async (status) => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }],
      invoices: [{ id: "inv-0" }],
      intents: [{ id: "pi-0", status }],
    });

    expect((await refusal(run(() => removeSampleData({ actorId: ACTOR })))).code).toBe("payment_in_flight");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toEqual([]);
  });

  it("refuses while approve-and-pay holds a fresh claim on a sample invoice, and deletes nothing", async () => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }],
      invoices: [{ id: "inv-0", status: "processing", reviewed_at: new Date().toISOString() }],
    });

    expect((await refusal(run(() => removeSampleData({ actorId: ACTOR })))).code).toBe("payment_in_flight");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toEqual([]);
  });

  it("proceeds when a processing claim on a sample invoice is stale (reviewed_at 11 minutes old)", async () => {
    const staleReviewedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }],
      invoices: [{ id: "inv-0", status: "processing", reviewed_at: staleReviewedAt }],
    });

    const result = await run(() => removeSampleData({ actorId: ACTOR }));

    expect(result.counterparties).toBe(1);
    const deletes = fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    expect(deletes).toContain("/rest/v1/counterparties");
  });

  it("proceeds when a processing claim on a sample invoice is missing reviewed_at", async () => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }],
      invoices: [{ id: "inv-0", status: "processing", reviewed_at: null }],
    });

    const result = await run(() => removeSampleData({ actorId: ACTOR }));

    expect(result.counterparties).toBe(1);
    const deletes = fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    expect(deletes).toContain("/rest/v1/counterparties");
  });
});

describe("hasSampleData", () => {
  it("asks for one sample counterparty", async () => {
    const loaded = sampleFake({ sampleCounterparties: [{ id: "cp-0" }] });
    await expect(loaded.run(() => hasSampleData())).resolves.toBe(true);
    const [lookup] = requestsTo(loaded.fake.requests, "/rest/v1/counterparties", "GET");
    expect(lookup.params.get("sample")).toBe("eq.true");
    expect(lookup.params.get("limit")).toBe("1");

    await expect(sampleFake().run(() => hasSampleData())).resolves.toBe(false);
  });
});
