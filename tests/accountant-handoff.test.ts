import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
}));

const { sessionMock, membershipMock, buildMock, recentMock, appendEntryMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  membershipMock: vi.fn(),
  buildMock: vi.fn(),
  recentMock: vi.fn(),
  appendEntryMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock, membershipsOf: vi.fn() }));
vi.mock("@/lib/accountant/handoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountant/handoff")>();
  return { ...actual, buildHandoff: buildMock, recentHandoffsBy: recentMock };
});
vi.mock("@/lib/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ledger")>();
  return { ...actual, appendLedgerEntry: appendEntryMock };
});

import { GET } from "@/app/api/accountant/handoff/route";
import { handoffCsvChunks, handoffFileName, handoffPeriod, HANDOFF_FORMAT, type HandoffDoc } from "@/lib/accountant/handoff";

/**
 * The hand-off export (docs/superpowers/specs/2026-10-13-accountant-console-design.md A7): the audit export's gate, in
 * its order, with the membership read afresh on the request, so a member removed a moment ago gets the 404 of someone
 * who never was one; a month that reads; one CSV table, formula-safe, its amounts each in their own currency.
 */

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MEMBERSHIP = { orgId: ORG, slug: "harbor-bakery", name: "Harbor Bakery", mode: "live" as const, role: "accountant" as const, network: "arc-testnet" as const };

const DOC: HandoffDoc = {
  format: HANDOFF_FORMAT,
  exportedAt: "2026-10-13T09:00:00.000Z",
  workspace: { slug: "harbor-bakery", name: "Harbor Bakery" },
  period: { from: "2026-09-01", to: "2026-10-01", label: "September 2026", key: "2026-09" },
  ledgerHead: { seq: 812, hash: "a".repeat(64) },
  cut: false,
  decisions: [{ seq: 790, at: "2026-09-12T10:00:00Z", actor: "agent", action: "ap_hold", summary: "=HYPERLINK(\"x\")", invoiceId: "inv-1", hash: "h1" }],
  payments: [
    { id: "pi-1", source: "invoice", sourceId: "inv-2", status: "confirmed", amount: "1250", token: "USDC", destination: "0xabc", simulated: false, txHash: "0xtx", sentAt: "2026-09-14T10:00:00Z", confirmedAt: "2026-09-14T10:01:00Z" },
    { id: "pi-2", source: "invoice", sourceId: "inv-3", status: "confirmed", amount: "800", token: "EURC", destination: "0xdef", simulated: false, txHash: "0xtx2", sentAt: "2026-09-15T10:00:00Z", confirmedAt: "2026-09-15T10:01:00Z" },
  ],
  bookings: [{ id: "bk-1", provider: "xero", invoiceId: "inv-2", amount: "1250", currency: "USD", paidOn: "2026-09-14", state: "confirmed", reference: "Arc 0xtx", account: "090 Business Bank", confirmedAt: "2026-09-15T08:00:00Z" }],
  openItems: [{ kind: "Customer says paid", title: "Acme Retail", detail: "Says it paid on Oct 11, 2026.", amount: "1800", currency: "USDC", since: "2026-10-12T08:00:00Z", link: "https://www.vestiarion.xyz/o/harbor-bakery/invoices?tab=receivables#from-customers" }],
  unread: [],
};

function call(query: string, headers?: Record<string, string>) {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "harbor-bakery", name: "Harbor Bakery", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
    GET(new Request(`https://www.vestiarion.xyz/api/accountant/handoff${query}`, headers ? { headers } : undefined))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: USER, email: null });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  buildMock.mockResolvedValue(DOC);
  recentMock.mockResolvedValue(0);
  appendEntryMock.mockResolvedValue(undefined);
});

describe("GET /api/accountant/handoff", () => {
  it("refuses a request from another site before reading anything", async () => {
    const response = await call("?org=harbor-bakery&format=csv&month=2026-09", { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(sessionMock).not.toHaveBeenCalled();
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in", async () => {
    sessionMock.mockResolvedValueOnce(null);
    expect((await call("?org=harbor-bakery")).status).toBe(401);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("refuses a format or a month that does not read, and a month still to come", async () => {
    expect((await call("?org=harbor-bakery&format=xlsx")).status).toBe(400);
    expect((await call("?org=harbor-bakery&month=2026-13")).status).toBe(400);
    expect((await call("?org=harbor-bakery&month=2099-01")).status).toBe(400);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("answers a removed member as it answers someone who never was one, reading the membership on this request", async () => {
    membershipMock.mockResolvedValueOnce(null);
    const response = await call("?org=harbor-bakery&format=csv&month=2026-09");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(membershipMock).toHaveBeenCalledWith(USER, "harbor-bakery");
    expect(buildMock).not.toHaveBeenCalled();
    expect(appendEntryMock).not.toHaveBeenCalled();
  });

  it("sends the month as a CSV attachment for an accountant, and records the export in the ledger", async () => {
    const response = await call("?org=harbor-bakery&format=csv&month=2026-09");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="vestiarion-harbor-bakery-handoff-2026-09.csv"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A BOM first, so a spreadsheet reads UTF-8 as UTF-8.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.split("\r\n")[0]).toBe("﻿section,id,date,kind,status,counterparty_or_title,amount,currency,reference,detail,link");
    expect(buildMock).toHaveBeenCalledWith(MEMBERSHIP, expect.objectContaining({ key: "2026-09" }), expect.objectContaining({ origin: expect.any(String) }));
    expect(appendEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "system",
        action: "handoff_exported",
        detail: { by: USER, format: "csv", month: "2026-09", decisions: 1, payments: 2, bookings: 1, openItems: 1, headSeq: 812 },
      })
    );
  });

  it("sends JSON as one document", async () => {
    const response = await call("?org=harbor-bakery&format=json&month=2026-09");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual(DOC);
  });

  it("stops past ten hand-offs in ten minutes, recording nothing", async () => {
    recentMock.mockResolvedValueOnce(10);
    const response = await call("?org=harbor-bakery&format=csv&month=2026-09");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(buildMock).not.toHaveBeenCalled();
    expect(appendEntryMock).not.toHaveBeenCalled();
  });

  it("says it failed without saying why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    buildMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const response = await call("?org=harbor-bakery&format=csv&month=2026-09");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The hand-off could not be exported." });
  });
});

describe("handoffPeriod", () => {
  const now = new Date("2026-10-13T09:00:00Z");
  it("is the last full month by default, a named month otherwise", () => {
    expect(handoffPeriod(null, now)).toEqual({ from: "2026-09-01", to: "2026-10-01", label: "September 2026", key: "2026-09" });
    expect(handoffPeriod("2026-10", now)).toEqual({ from: "2026-10-01", to: "2026-11-01", label: "October 2026", key: "2026-10" });
    expect(handoffPeriod(null, new Date("2026-01-05T00:00:00Z"))?.key).toBe("2025-12");
  });

  it("refuses a month that does not read or is still to come", () => {
    for (const month of ["2026-11", "2026-00", "26-09", "2026-9", "1999-01"]) expect(handoffPeriod(month, now), month).toBeNull();
  });
});

describe("handoffCsvChunks", () => {
  it("writes one table, a section per row, each amount in its own currency, and neutralises a formula", () => {
    const lines = [...handoffCsvChunks(DOC)].join("").split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1 + 1 + 1 + 2 + 1 + 1);
    expect(lines[1]).toMatch(/^workspace,harbor-bakery,/);
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[3]).toBe("payment,pi-1,2026-09-14T10:01:00Z,invoice,confirmed,0xabc,1250,USDC,0xtx,on chain,inv-2");
    expect(lines[4]).toContain(",800,EURC,");
    expect(lines[5]).toBe("booking,bk-1,2026-09-14,xero,confirmed,090 Business Bank,1250,USD,Arc 0xtx,confirmed 2026-09-15T08:00:00Z,inv-2");
    expect(lines[6]).toMatch(/^open_item,,2026-10-12T08:00:00Z,Customer says paid,open,Acme Retail,1800,USDC,/);
  });

  it("names the file by workspace and month", () => {
    expect(handoffFileName("harbor-bakery", DOC.period, "json")).toBe("vestiarion-harbor-bakery-handoff-2026-09.json");
  });
});
