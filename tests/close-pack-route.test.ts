import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { samplePack } from "./support/close-pack-fixtures";

/**
 * Downloading the monthly close pack (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP12-CP15): the
 * audit export's gate in its order, a bad format or month refused before the workspace is looked up, the CSV and the
 * signed JSON with their names and headers, one `close_pack_exported` per download signing the SHA-256 of the bytes
 * served, and the brake counted from the ledger's own entries.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c9a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c9",
}));

const { sessionMock, membershipMock, readMock, appendEntryMock, downloadTokenMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  membershipMock: vi.fn(),
  readMock: vi.fn(),
  appendEntryMock: vi.fn(),
  downloadTokenMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock, membershipsOf: vi.fn() }));
vi.mock("@/lib/close-pack/read", () => ({ readClosePack: readMock }));
// The per-instance brake lets every download through, but in the tests of a burst, which run the real bucket.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rate-limit")>()), takeClosePackDownloadToken: downloadTokenMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: appendEntryMock }));

import { GET } from "@/app/api/evidence/close-pack/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
// A viewer: every member may download the close pack (CP14).
const MEMBERSHIP = { orgId: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live" as const, role: "viewer" as const, network: "arc-testnet" as const };
const NOW = new Date("2026-11-02T09:00:00Z");

/** The brake's read: downloads and Google Sheets exports, failed ones too, count together (close pack Sheets GS11). */
const BRAKE = "in.(close_pack_exported,close_pack_export_failed)";

function call(query: string, options: { headers?: Record<string, string>; recent?: number; recentKinds?: string[] } = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } };
    }
    if (request.path === "/rest/v1/ledger_entries" && options.recentKinds && request.params.has("detail->>by")) {
      // The person's recent entries by kind, filtered as the database would by the read's action list.
      const asked = (request.params.get("action") ?? "").replace(/^in\.\(|\)$/g, "").replace(/^eq\./, "").split(",");
      return { body: options.recentKinds.filter((kind) => asked.includes(kind)).map((_, index) => ({ id: `x${index}` })) };
    }
    if (request.path === "/rest/v1/ledger_entries" && request.params.get("action") === BRAKE) {
      return { body: Array.from({ length: options.recent ?? 0 }, (_, index) => ({ id: `x${index}` })) };
    }
    return { body: [] };
  });
  const response = runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
    GET(new Request(`https://www.vestiarion.xyz/api/evidence/close-pack${query}`, options.headers ? { headers: options.headers } : undefined))
  );
  return { response, fake };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: USER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  readMock.mockResolvedValue(samplePack());
  appendEntryMock.mockResolvedValue(undefined);
  downloadTokenMock.mockReset();
  downloadTokenMock.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/evidence/close-pack (close pack CP12, CP14)", () => {
  it("refuses a cross-site request before reading anything", async () => {
    const answer = await call("?org=pinecrest-studio&month=2026-10", { headers: { "sec-fetch-site": "cross-site" } }).response;
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ error: "Download the close pack from the workspace." });
    expect(sessionMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("asks someone signed out to sign in", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const answer = await call("?org=pinecrest-studio&month=2026-10").response;
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: "Sign in to download this close pack." });
    expect(readMock).not.toHaveBeenCalled();
  });

  it("refuses a bad format, and a malformed or future month, before looking the workspace up", async () => {
    const format = await call("?org=pinecrest-studio&month=2026-10&format=pdf").response;
    expect(format.status).toBe(400);
    expect(await format.json()).toEqual({ error: "format must be csv or json" });
    for (const month of ["2026-13", "2026-1", "202610", "2026-12", "2019-12"]) {
      const answer = await call(`?org=pinecrest-studio&month=${month}`).response;
      expect(answer.status, month).toBe(400);
      expect(await answer.json()).toEqual({ error: "month must be YYYY-MM, and not a month still to come" });
    }
    expect(membershipMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("answers a non-member 404, as for a workspace that does not exist, reading the membership on this request", async () => {
    membershipMock.mockResolvedValueOnce(null);
    const answer = await call("?org=pinecrest-studio&month=2026-10").response;
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: "Not found" });
    expect(membershipMock).toHaveBeenCalledWith(USER, "pinecrest-studio");
    expect(readMock).not.toHaveBeenCalled();
    expect(appendEntryMock).not.toHaveBeenCalled();
  });

  it("gives a member the signed JSON with its name and headers, read in the workspace's scope", async () => {
    const answer = await call("?org=pinecrest-studio&month=2026-10").response;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-close-pack-pinecrest-studio-2026-10.json"');
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    const doc = await answer.json();
    expect(doc.format).toBe("vestiarion-close-pack/1");
    expect(doc.workspace).toEqual({ slug: "pinecrest-studio", name: "Pinecrest Studio" });
    expect(doc.rows).toHaveLength(3);
    expect(doc.notSettled).toHaveLength(1);
    expect(readMock).toHaveBeenCalledWith(
      expect.objectContaining({ month: expect.objectContaining({ key: "2026-10" }), workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" } })
    );
  });

  it("reads last month when no month is given, and answers JSON when no format is", async () => {
    const answer = await call("?org=pinecrest-studio").response;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(readMock).toHaveBeenCalledWith(expect.objectContaining({ month: expect.objectContaining({ key: "2026-10", label: "October 2026" }) }));
  });

  it("gives the CSV with its byte-order mark, one row per settled payment", async () => {
    const answer = await call("?org=pinecrest-studio&month=2026-10&format=csv").response;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-close-pack-pinecrest-studio-2026-10.csv"');
    const bytes = new Uint8Array(await answer.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes.slice(3)).trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0].startsWith("paid_at,payment_id,record,record_id,")).toBe(true);
    expect(lines[1]).toContain("Northwind Supplies");
  });

  it("names a month not ended so far, so an early copy is never mistaken for the closed month", async () => {
    readMock.mockResolvedValueOnce(samplePack({ now: new Date("2026-10-25T09:00:00Z") }));
    const answer = await call("?org=pinecrest-studio&month=2026-10&format=csv").response;
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-close-pack-pinecrest-studio-2026-10-so-far.csv"');
  });

  it("records one close_pack_exported signing the SHA-256 of the bytes it served, with the counts and no email (CP13)", async () => {
    for (const format of ["csv", "json"] as const) {
      appendEntryMock.mockClear();
      const answer = await call(`?org=pinecrest-studio&month=2026-10&format=${format}`).response;
      const bytes = new Uint8Array(await answer.arrayBuffer());
      expect(appendEntryMock).toHaveBeenCalledTimes(1);
      const entry = appendEntryMock.mock.calls[0][0];
      expect(entry).toMatchObject({ actor: "human", domain: "system", action: "close_pack_exported" });
      expect(entry.summary).toBe(`Close pack for October 2026 downloaded as ${format.toUpperCase()}: 3 payments settled, 1 not settled`);
      expect(entry.detail).toEqual({ by: USER, month: "2026-10", ended: true, format, payments: 3, notSettled: 1, sha256: sha256(bytes), headSeq: 99 });
      expect(JSON.stringify(entry)).not.toContain("@");
    }
  });

  it("answers the eleventh download in ten minutes 429 with retry-after: 600, counted from the ledger (CP15)", async () => {
    const { response, fake } = call("?org=pinecrest-studio&month=2026-10", { recent: 10 });
    const answer = await response;
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("600");
    expect(await answer.json()).toEqual({ error: "Too many close pack downloads in the last 10 minutes. Try again later." });
    const count = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("action") === BRAKE);
    expect(count?.params.get("detail->>by")).toBe(`eq.${USER}`);
    expect(count?.params.get("ts")).toBe(`gt.${new Date(NOW.getTime() - 10 * 60_000).toISOString()}`);
    expect(readMock).not.toHaveBeenCalled();
    expect(appendEntryMock).not.toHaveBeenCalled();
    // Nine leave room for one more.
    expect((await call("?org=pinecrest-studio&month=2026-10", { recent: 9 }).response).status).toBe(200);
  });

  it("counts a recent close_pack_export_failed toward the eleventh download: one brake for downloads and Sheets exports (close pack Sheets GS11)", async () => {
    const nineAndAFailure = [...Array<string>(9).fill("close_pack_exported"), "close_pack_export_failed"];
    const answer = await call("?org=pinecrest-studio&month=2026-10", { recentKinds: nineAndAFailure }).response;
    expect(answer.status).toBe(429);
    expect(readMock).not.toHaveBeenCalled();
    // The nine downloads alone leave room for one more.
    expect((await call("?org=pinecrest-studio&month=2026-10", { recentKinds: nineAndAFailure.slice(0, 9) }).response).status).toBe(200);
  });

  it("answers a burst of downloads sent at once 429 past six, before the ledger is counted or the month is read (CP15)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
    downloadTokenMock.mockImplementation(actual.takeClosePackDownloadToken);
    sessionMock.mockResolvedValue({ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1", email: null });
    // Every one of them counts the same nine earlier downloads in the ledger before any of them appends its own.
    const calls = Array.from({ length: 9 }, () => call("?org=pinecrest-studio&month=2026-10", { recent: 9 }));
    const answers = await Promise.all(calls.map((one) => one.response));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200, 429, 429, 429]);
    const limited = answers[8];
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Too many close pack downloads in a row. Try again in a minute." });
    expect(readMock).toHaveBeenCalledTimes(6);
    expect(appendEntryMock).toHaveBeenCalledTimes(6);
    const counted = (one: (typeof calls)[number]) => one.fake.requests.some((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("action") === BRAKE);
    expect(calls.map(counted)).toEqual([true, true, true, true, true, true, false, false, false]);
  });

  it("holds each workspace's downloads apart, as the ledger's count does (CP15)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
    downloadTokenMock.mockImplementation(actual.takeClosePackDownloadToken);
    sessionMock.mockResolvedValue({ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d2", email: null });
    const OTHER = { ...MEMBERSHIP, orgId: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c9b", slug: "harbor-print", name: "Harbor Print" };
    membershipMock.mockImplementation(async (_user: string, slug: string) => (slug === "harbor-print" ? OTHER : MEMBERSHIP));
    // An accountant downloads one client's month six times, then another client's.
    const first = await Promise.all(Array.from({ length: 7 }, () => call("?org=pinecrest-studio&month=2026-10&format=csv").response));
    expect(first.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect((await call("?org=harbor-print&month=2026-10&format=csv").response).status).toBe(200);
  });

  it("takes the brake's token only for a member, once the session, format and month are good, by person and workspace", async () => {
    sessionMock.mockResolvedValueOnce(null);
    expect((await call("?org=pinecrest-studio&month=2026-10").response).status).toBe(401);
    expect((await call("?org=pinecrest-studio&month=2026-10&format=pdf").response).status).toBe(400);
    expect((await call("?org=pinecrest-studio&month=2026-13").response).status).toBe(400);
    membershipMock.mockResolvedValueOnce(null);
    expect((await call("?org=no-such-workspace&month=2026-10").response).status).toBe(404);
    expect(downloadTokenMock).not.toHaveBeenCalled();
    expect((await call("?org=pinecrest-studio&month=2026-10").response).status).toBe(200);
    expect(downloadTokenMock).toHaveBeenCalledWith(`${USER}:${ORG}`);
  });

  it("answers a failed read 500, records nothing and names nothing of why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readMock.mockRejectedValueOnce(new Error("relation payment_intents: secret detail"));
    const answer = await call("?org=pinecrest-studio&month=2026-10").response;
    expect(answer.status).toBe(500);
    const text = await answer.text();
    expect(JSON.parse(text)).toEqual({ error: "The close pack could not be read." });
    expect(text).not.toContain("secret detail");
    expect(appendEntryMock).not.toHaveBeenCalled();
  });

  it("still serves the file when the ledger refuses the entry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    appendEntryMock.mockRejectedValueOnce(new Error("no signing key"));
    const answer = await call("?org=pinecrest-studio&month=2026-10&format=csv").response;
    expect(answer.status).toBe(200);
    expect(appendEntryMock).toHaveBeenCalledTimes(1);
  });

  it("writes nothing but the one ledger entry", async () => {
    const { response, fake } = call("?org=pinecrest-studio&month=2026-10&format=csv");
    expect((await response).status).toBe(200);
    expect(fake.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });
});
