import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e1e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
}));

const { sessionMock, membershipMock, buildMock, appendMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  membershipMock: vi.fn(),
  buildMock: vi.fn(),
  appendMock: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendMock }));
vi.mock("@/lib/ledger-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ledger-export")>();
  return { ...actual, buildLedgerExport: buildMock };
});

import { GET } from "@/app/api/ledger/export/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MEMBERSHIP = { orgId: ORG, slug: "northstar", name: "Northstar Studio", mode: "sandbox" as const, role: "viewer" as const };

const DOC = {
  format: "vestiarion-ledger-export/1",
  exportedAt: "2026-09-30T12:00:00.000Z",
  workspace: { slug: "northstar", name: "Northstar Studio" },
  head: { seq: 392, hash: "a".repeat(64) },
  keys: [],
  verification: { valid: true, checkedEntries: 2 },
  entries: [
    { seq: 391, id: "e1", ts: "t", actor: "human", domain: "ap", action: "approval_paid", summary: "=1+1", detail: { a: 1 }, body_hash: "b", signature: "s", prev_hash: "p", hash: "h", signing_key_id: null },
    { seq: 392, id: "e2", ts: "t", actor: "human", domain: "system", action: "x", summary: "ok", detail: {}, body_hash: "b", signature: "s", prev_hash: "h", hash: "a".repeat(64), signing_key_id: null },
  ],
};

function call(query: string) {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar Studio", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => GET(new Request(`https://www.vestiarion.xyz/api/ledger/export${query}`)));
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: USER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  buildMock.mockResolvedValue(DOC);
  appendMock.mockResolvedValue(undefined);
});

describe("GET /api/ledger/export", () => {
  it("asks a signed-out visitor to sign in, and builds nothing", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to export this ledger." });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a workspace the person is not a member of, without saying whether it exists", async () => {
    membershipMock.mockResolvedValueOnce(null);
    const response = await call("?org=someone-else&format=json");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(membershipMock).toHaveBeenCalledWith(USER, "someone-else");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown format", async () => {
    const response = await call("?org=northstar&format=pdf");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "format must be json or csv" });
  });

  it("sends the signed JSON as an attachment to any member, a viewer included", async () => {
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-northstar-ledger-392.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual(DOC);
    expect(buildMock).toHaveBeenCalledWith({ slug: "northstar", name: "Northstar Studio" });
  });

  it("sends the CSV with its formula guard", async () => {
    const response = await call("?org=northstar&format=csv");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-northstar-ledger-392.csv"');
    expect(await response.text()).toContain(`"'=1+1"`);
  });

  it("defaults to JSON", async () => {
    const response = await call("?org=northstar");
    expect(response.headers.get("content-disposition")).toContain(".json");
  });

  it("records who exported what, with ids and counts only", async () => {
    await call("?org=northstar&format=csv");
    expect(appendMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "ledger_exported",
      summary: "Ledger exported as CSV: 2 entries, up to #392",
      detail: { by: USER, format: "csv", entries: 2, headSeq: 392 },
    });
  });

  it("still sends the file when the record cannot be written", async () => {
    appendMock.mockRejectedValueOnce(new Error("database hiccup"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(200);
    logged.mockRestore();
  });

  it("answers a fixed 500 when the ledger cannot be read", async () => {
    buildMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("?org=northstar&format=json");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The ledger could not be exported." });
    logged.mockRestore();
  });
});
