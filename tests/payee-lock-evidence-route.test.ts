import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * Downloading the payee lock's evidence pack (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP1, EP6):
 * the audit export's gate, a malformed period refused before the workspace is looked up, and the reader's queries: the
 * changes and lock changes in the period, then every later entry of the counterparties they name. Nothing is written.
 */

const { ORG, OWNER, APPROVER, NORTHWIND } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e1e",
  OWNER: "63a43a55-78f9-4b85-907a-eea1483a06af",
  APPROVER: "9b1c2d3e-0000-4000-8000-00000000a002",
  NORTHWIND: "28e7be97-df37-4b15-9d43-be8a330f6ece",
}));
const { publicKey } = crypto.generateKeyPairSync("ed25519");

const { sessionMock, membershipMock } = vi.hoisted(() => ({ sessionMock: vi.fn(), membershipMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: publicKey, retired: [] }),
}));

import { GET } from "@/app/api/evidence/payee-lock/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MEMBERSHIP = { orgId: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live" as const, role: "viewer" as const };

const signed = (seq: number, ts: string, action: string, detail: Record<string, unknown>) => ({
  seq,
  id: `e${seq}`,
  ts,
  actor: "human",
  domain: "compliance",
  action,
  summary: action,
  detail,
  body_hash: "b".repeat(64),
  signature: "5".repeat(128),
  prev_hash: "0".repeat(64),
  hash: "a".repeat(64),
  signing_key_id: "k1",
});
const CHANGE = signed(4839, "2026-10-20T11:14:02Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: "0xC4c2", to: "0xa8a4" });
const LOCK = signed(4832, "2026-10-20T11:12:40Z", "payee_lock_changed", { by: OWNER, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 4 } });
const CONFIRMED = signed(4863, "2026-10-20T12:10:52Z", "counterparty_address_confirmed", {
  by: APPROVER,
  counterpartyId: NORTHWIND,
  address: "0xa8a4",
  verification: { method: "call", contact: "accounts line", contactOnFileBefore: true },
  payeeLock: { coolingHours: 4 },
});

function call(query: string, options: { headers?: Record<string, string>; failLedger?: boolean } = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } };
    }
    if (request.path === "/rest/v1/ledger_entries") {
      if (options.failLedger) return { status: 500, body: { message: "relation ledger_entries: secret detail" } };
      if (request.params.get("action")) return { body: [LOCK, CHANGE] };
      return { body: [CONFIRMED] };
    }
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: NORTHWIND, name: "Northwind Referrals" }] };
    if (request.path === "/rest/v1/approval_policies") return { body: [{ payee_lock: true, payee_lock_cooling_hours: 4 }] };
    if (request.path === "/rest/v1/rpc/org_members") {
      return { body: [{ user_id: OWNER, email: "owner@pinecrest.test", role: "owner", joined_at: "2026-10-12" }, { user_id: APPROVER, email: "approver@pinecrest.test", role: "approver", joined_at: "2026-10-15" }] };
    }
    return { body: [] };
  });
  const response = runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
    GET(new Request(`https://www.vestiarion.xyz/api/evidence/payee-lock${query}`, options.headers ? { headers: options.headers } : undefined))
  );
  return { response, fake };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: OWNER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
});

describe("GET /api/evidence/payee-lock", () => {
  it("refuses a cross-site request before reading anything", async () => {
    const { response } = call("?org=pinecrest-studio", { headers: { "sec-fetch-site": "cross-site" } });
    expect((await response).status).toBe(403);
    expect(sessionMock).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in", async () => {
    sessionMock.mockResolvedValueOnce(null);
    expect((await call("?org=pinecrest-studio").response).status).toBe(401);
  });

  it("refuses a malformed or reversed period without looking up the workspace", async () => {
    for (const query of ["?org=pinecrest-studio&from=2026-13-01", "?org=pinecrest-studio&from=2026-10-31&to=2026-10-01", "?org=pinecrest-studio&to=yesterday"]) {
      expect((await call(query).response).status).toBe(400);
    }
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it("answers a non-member 404, as for a workspace that does not exist", async () => {
    membershipMock.mockResolvedValueOnce(null);
    expect((await call("?org=pinecrest-studio").response).status).toBe(404);
  });

  it("gives a member the pack as a JSON file, read in the workspace's scope, writing nothing", async () => {
    const { response, fake } = call("?org=pinecrest-studio&from=2026-10-20&to=2026-10-20");
    const answer = await response;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-payee-lock-evidence-pinecrest-studio-2026-10-20-2026-10-20.json"');
    expect(answer.headers.get("cache-control")).toBe("no-store");

    const doc = await answer.json();
    expect(doc.format).toBe("vestiarion-payee-lock-evidence/1");
    expect(doc.workspace).toEqual({ slug: "pinecrest-studio", name: "Pinecrest Studio" });
    expect(doc.period).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(doc.lock.now).toEqual({ on: true, coolingHours: 4 });
    expect(doc.changes).toHaveLength(1);
    expect(doc.changes[0]).toMatchObject({
      counterparty: { id: NORTHWIND, name: "Northwind Referrals" },
      change: { enteredBy: { kind: "member", email: "owner@pinecrest.test" }, entry: 4839 },
      confirmation: { by: { kind: "member", email: "approver@pinecrest.test" }, secondPerson: true, waitHours: 4, entry: 4863 },
    });
    expect(doc.entries.map((entry: { seq: number }) => entry.seq)).toEqual([4832, 4839, 4863]);
    // Each entry is checked with the workspace's keys: these fixtures are not really signed, so none checks out.
    expect(doc.entries.every((entry: { check: { ok: boolean | null } }) => entry.check.ok !== true)).toBe(true);
    expect(doc.keys).toHaveLength(1);

    // The changes and lock changes within the period's whole UTC days, then the named counterparties' later entries.
    const ledger = fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    expect(ledger[0].params.get("action")).toBe("in.(counterparty_address_changed,payee_lock_changed)");
    expect(ledger[0].params.getAll("ts")).toEqual(["gte.2026-10-20T00:00:00.000Z", "lt.2026-10-21T00:00:00.000Z"]);
    expect(ledger[1].params.get("detail->>counterpartyId")).toBe(`in.(${NORTHWIND})`);
    // All of their entries, so a transfer to an earlier address is told apart from a payment to this one.
    expect(ledger[1].params.get("seq")).toBeNull();
    expect(fake.requests.filter((request) => request.method !== "GET" && !request.path.startsWith("/rest/v1/rpc/"))).toEqual([]);
  });

  it("gives the pack as CSV with format=csv, one row per change, and refuses any other format (EP9)", async () => {
    // Another member, so these downloads leave the owner's six a minute to the tests that count them.
    sessionMock.mockResolvedValue({ id: APPROVER, email: null });
    const answer = await call("?org=pinecrest-studio&from=2026-10-20&to=2026-10-20&format=csv").response;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-payee-lock-evidence-pinecrest-studio-2026-10-20-2026-10-20.csv"');
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await answer.arrayBuffer());
    // A byte-order mark first, so Excel reads it as UTF-8.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes.slice(3)).trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("counterparty,counterparty_id,changed_at,")).toBe(true);
    expect(lines[1]).toContain("Northwind Referrals");
    expect(lines[1]).toContain("approver@pinecrest.test");
    expect((await call("?org=pinecrest-studio&format=pdf").response).status).toBe(400);
  });

  it("asks for the ids a hundred at a time, so no request's address grows too long", async () => {
    const many = Array.from({ length: 150 }, (_, index) =>
      signed(5000 + index, "2026-10-20T11:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: "cp-" + index, from: null, to: "0xa8a4" })
    );
    const fake = fakeSupabase((request: RecordedRequest) => {
      if (request.path === "/rest/v1/orgs") {
        return { body: { id: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } };
      }
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("action")) return { body: many };
      if (request.path === "/rest/v1/approval_policies") return { body: [{ payee_lock: false, payee_lock_cooling_hours: 0 }] };
      return { body: [] };
    });
    sessionMock.mockResolvedValue({ id: "chunking-member", email: null });
    const answer = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      GET(new Request("https://www.vestiarion.xyz/api/evidence/payee-lock?org=pinecrest-studio"))
    );
    expect(answer.status).toBe(200);
    const history = fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("detail->>counterpartyId"));
    expect(history.map((request) => (request.params.get("detail->>counterpartyId") ?? "").split(",").length)).toEqual([100, 50]);
    expect(fake.requests.filter((request) => request.path === "/rest/v1/counterparties")).toHaveLength(2);
  });

  it("lets a member download six packs a minute", async () => {
    sessionMock.mockResolvedValue({ id: "rate-limited-member", email: null });
    for (let index = 0; index < 6; index += 1) expect((await call("?org=pinecrest-studio").response).status).toBe(200);
    const seventh = await call("?org=pinecrest-studio").response;
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get("retry-after")).toBe("60");
  });

  it("says when the pack could not be read, and nothing of why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await call("?org=pinecrest-studio", { failLedger: true }).response;
    expect(answer.status).toBe(500);
    expect(await answer.text()).not.toContain("secret detail");
  });
});
