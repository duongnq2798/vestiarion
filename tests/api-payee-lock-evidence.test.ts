import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import type { FakeReply, RecordedRequest } from "./support/fake-supabase";
import { API_ORG, apiWorld, callRoute, readKey, writesIn } from "./support/evidence-api";

/**
 * The payee lock's evidence through the API (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA1-EA3, EA5, EA7): the pack's signed JSON for a period of whole UTC days, either end open; a member named by user id
 * with no email; a period that does not read refused before anything is read; over 4 MB refused.
 */

const active = crypto.generateKeyPairSync("ed25519");
const { readSpy } = vi.hoisted(() => ({ readSpy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/api-keys")>()),
  authenticateApiKey: vi.fn(),
  touchApiKeyUsed: vi.fn(async () => {}),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [] }),
}));
vi.mock("@/lib/payee-lock-evidence-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payee-lock-evidence-read")>();
  readSpy.mockImplementation(actual.readPayeeLockEvidence);
  return { ...actual, readPayeeLockEvidence: readSpy };
});

import { GET } from "@/app/api/v1/payee-lock/evidence/route";
import { API_DOCUMENT_MAX_BYTES } from "@/lib/api/evidence";
import { authenticateApiKey } from "@/lib/platform/api-keys";
import { payeeLockEvidence, type PayeeLockEvidence } from "@/lib/payee-lock-evidence";

const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const APPROVER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a2";
const LEFT = "9f8e7d6c-4a4f-4a7e-9b1e-0000000000a3";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003a1";
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x2222222222222222222222222222222222222222";
const EMAILS = ["owner@northstar.test", "approver@northstar.test"];

const INPUTS: LedgerEntryInput[] = [
  { actor: "human", domain: "system", action: "payee_lock_changed", summary: "Lock on", detail: { by: LEFT, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 24 } } },
  { actor: "human", domain: "compliance", action: "counterparty_address_changed", summary: "Changed", detail: { by: OWNER, counterpartyId: CP, from: OLD, to: NEW, chain: "ARC-TESTNET" } },
  {
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_confirmed",
    summary: "Confirmed",
    detail: { by: APPROVER, counterpartyId: CP, address: NEW, chain: "ARC-TESTNET", via: "confirm", verification: { method: "call", contact: "Accounts line", contactOnFileBefore: true }, payeeLock: { coolingHours: 24 } },
  },
];
const ROWS: Array<LedgerRow & { org_id: string }> = buildChain(INPUTS, active.privateKey, ledgerKeyId(active.publicKey)).map((row, index) => ({
  ...row,
  ts: `2026-10-0${index + 2}T10:00:00.000Z`,
  org_id: API_ORG,
}));

function workspace() {
  return apiWorld((request: RecordedRequest): FakeReply => {
    switch (request.path) {
      case "/rest/v1/ledger_entries": {
        const counterparty = request.params.get("detail->>counterpartyId");
        return { body: counterparty ? ROWS.filter((row) => counterparty.includes(String(row.detail.counterpartyId))) : ROWS.filter((row) => row.action !== "counterparty_address_confirmed") };
      }
      case "/rest/v1/counterparties":
        return { body: [{ id: CP, name: "Harbor Print" }] };
      case "/rest/v1/rpc/org_members":
        return {
          body: [
            { user_id: OWNER, email: EMAILS[0], role: "owner", joined_at: "2025-12-01T00:00:00Z" },
            { user_id: APPROVER, email: EMAILS[1], role: "approver", joined_at: "2025-12-01T00:00:00Z" },
          ],
        };
      default:
        return { body: [] };
    }
  });
}

const evidence = (world: ReturnType<typeof workspace>, query = "") => callRoute(world, GET, `/api/v1/payee-lock/evidence${query}`, {});
type Answer = { data: PayeeLockEvidence };

beforeEach(() => {
  const key = readKey();
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockImplementation(async () => key);
});

describe("GET /api/v1/payee-lock/evidence (evidence API EA1, EA2)", () => {
  it.each([
    ["a period", "?from=2026-10-01&to=2026-10-31", { from: "2026-10-01", to: "2026-10-31" }],
    ["an open start", "?to=2026-10-31", { from: null, to: "2026-10-31" }],
    ["an open end", "?from=2026-10-01", { from: "2026-10-01", to: null }],
    ["no period at all", "", { from: null, to: null }],
  ])("answers %s with the pack's signed JSON", async (_name, query, period) => {
    const response = await evidence(workspace(), query);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = (await response.json()) as Answer;
    expect(data.format).toBe("vestiarion-payee-lock-evidence/1");
    expect(data.period).toEqual(period);
    expect(data.changes).toHaveLength(1);
  });

  it("names a member by user id with no email, and one who left by the first 8 characters of theirs (EA3)", async () => {
    const response = await evidence(workspace(), "?from=2026-10-01&to=2026-10-31");
    const text = await response.text();
    for (const email of EMAILS) expect(text).not.toContain(email);
    const { data } = JSON.parse(text) as Answer;
    expect(data.changes[0].change.enteredBy).toEqual({ kind: "member", userId: OWNER, email: null });
    expect(data.changes[0].confirmation?.by).toEqual({ kind: "member", userId: APPROVER, email: null });
    expect(data.lock.changes[0].by).toEqual({ kind: "former_member", id: LEFT.slice(0, 8) });
  });

  it.each(["?from=2026-10-32", "?from=2026-10-31&to=2026-10-01", "?to=October"])("refuses %s before any request to the workspace (EA5)", async (query) => {
    const world = workspace();
    const response = await evidence(world, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "from and to must be days as YYYY-MM-DD, from no later than to" } });
    expect(world.requests).toEqual([]);
  });

  it("writes nothing", async () => {
    const world = workspace();
    await evidence(world);
    expect(writesIn(world.requests)).toEqual([]);
  });
});

describe("a period over 4 MB (evidence API EA7)", () => {
  function packOf(bytes: number): PayeeLockEvidence {
    const doc = (name: string) =>
      payeeLockEvidence({
        workspace: { slug: "northstar-studio", name },
        network: "arc-testnet",
        period: { from: null, to: null },
        lock: { on: true, coolingHours: 24 },
        entries: [],
        counterparties: new Map(),
        members: new Map(),
        keys: [],
        now: new Date("2026-10-25T09:00:00Z"),
        people: "id",
      });
    const empty = new TextEncoder().encode(JSON.stringify({ data: doc("") })).length;
    return doc("x".repeat(bytes - empty));
  }

  it("refuses one over the cap, asking for a shorter period, and answers one at the cap", async () => {
    readSpy.mockResolvedValueOnce(packOf(API_DOCUMENT_MAX_BYTES + 1));
    const over = await evidence(workspace());
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({
      error: { code: "invalid_request", message: "This period's evidence is over 4 MB, more than one answer carries. Ask for a shorter period with from and to." },
    });
    readSpy.mockResolvedValueOnce(packOf(API_DOCUMENT_MAX_BYTES));
    expect((await evidence(workspace())).status).toBe(200);
  });
});
