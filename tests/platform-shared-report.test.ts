import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { generateReportShareToken } from "@/lib/report-share-token";
import { bill, decision, facts, payment } from "./support/report-facts";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a shared report's link reads (docs/superpowers/specs/2026-10-10-shared-report-design.md S5, S14). No session: a
 * malformed link is never looked up; an unknown, stopped or not-yet-migrated one is no share. A live one is read inside
 * its own workspace's scope, with the readers the private report uses, and the workspace's id goes no further.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a5";
const SHARE = "5d0f3a2e-8c1b-4f7a-9e6d-0000000005e1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const { rpc, scopes, reads, tenant } = vi.hoisted(() => ({
  rpc: vi.fn(),
  scopes: [] as Array<{ orgId: string; userId?: string }>,
  reads: { report: vi.fn(), actuals: vi.fn(), baseline: vi.fn() },
  tenant: { reply: (_request: unknown): unknown => ({ body: [] }) },
}));
vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({ rpc }),
}));
vi.mock("@/lib/dal/scope", () => ({
  withOrg: async (orgId: string, fn: () => Promise<unknown>, options: { userId?: string } = {}) => {
    scopes.push({ orgId, ...options });
    const fake = fakeSupabase((request) => tenant.reply(request) as FakeReply);
    return runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  },
}));
vi.mock("@/lib/ledger", () => ({ ledgerPublicKeyPems: () => ({ "0123456789abcdef": "-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n" }) }));
vi.mock("@/lib/workspace-report-read", () => ({ readReportFacts: reads.report }));
vi.mock("@/lib/actual-payments", () => ({ readActualsFacts: reads.actuals }));
vi.mock("@/lib/report-baseline", () => ({ readBaseline: reads.baseline }));

import { readSharedReport } from "@/lib/platform/shared-report";

const FOUND = {
  shareId: SHARE,
  orgId: ORG,
  createdAt: "2026-10-10T08:00:00.000Z",
  showNames: false,
  showAmounts: true,
  showWorkspaceName: true,
  name: "Harbor Books",
  mode: "live",
  network: "arc-testnet",
};
const FACTS = facts({
  bills: [bill("inv-1", { payee: { id: "cp-1", name: "Northwind Cloud", mirror: false, sample: false }, status: "paid" })],
  decisions: [decision(7, "inv-1", { reasoning: "Northwind Cloud is paid monthly, unlike Orbit Payroll." })],
  payments: [payment("inv-1")],
});
const LINK = { seq: 7, body_hash: "b".repeat(64), signature: "s".repeat(128), prev_hash: "p".repeat(64), hash: "h".repeat(64), signing_key_id: "0123456789abcdef" };

function tenantReplies(request: RecordedRequest): FakeReply {
  if (request.path === "/rest/v1/counterparties") return { body: [{ name: "Northwind Cloud" }, { name: "Orbit Payroll" }] };
  if (request.path === "/rest/v1/ledger_entries") return { body: [LINK] };
  throw new Error(`unexpected request ${request.method} ${request.path}`);
}

beforeEach(() => {
  rpc.mockReset();
  scopes.length = 0;
  reads.report.mockReset().mockResolvedValue(FACTS);
  reads.actuals.mockReset().mockResolvedValue({ available: false });
  reads.baseline.mockReset().mockResolvedValue({ available: true, answer: null });
  tenant.reply = tenantReplies as (request: unknown) => unknown;
});

describe("readSharedReport", () => {
  it("never looks up a malformed link", async () => {
    for (const token of ["", "vxs_short", `vxr_${"a".repeat(43)}`, "../../etc"]) expect(await readSharedReport(token)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("looks a link up by the hash of its secret, and finds no share for an unknown or stopped one", async () => {
    const { token, secretHash } = generateReportShareToken();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await readSharedReport(token)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("report_share_by_token", { p_token_hash: secretHash });
    expect(scopes).toEqual([]);
  });

  it.each(["PGRST202", "42883"])("finds no share before migration 0095 runs (%s)", async (code) => {
    rpc.mockResolvedValueOnce({ data: null, error: { code, message: "Could not find the function public.report_share_by_token" } });
    expect(await readSharedReport(generateReportShareToken().token)).toBeNull();
  });

  it("throws on any other failure, for the page to say it could not load", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "08006", message: "connection failure" } });
    await expect(readSharedReport(generateReportShareToken().token)).rejects.toThrow("connection failure");
  });

  it("reads a live link inside its own workspace's scope, as no one, and builds it with the share's options", async () => {
    rpc.mockResolvedValueOnce({ data: FOUND, error: null });
    const now = new Date("2026-10-11T12:00:00.000Z");
    const shown = await readSharedReport(generateReportShareToken().token, now);
    expect(scopes).toEqual([{ orgId: ORG }]);
    expect(reads.report).toHaveBeenCalledWith(expect.anything(), "arc-testnet", { sandbox: false });
    expect(reads.actuals).toHaveBeenCalled();
    expect(reads.baseline).toHaveBeenCalled();
    expect(shown).toMatchObject({
      title: "Harbor Books",
      named: true,
      options: { names: "labels", amounts: "shown", title: "workspace" },
      computedAt: "2026-10-11T12:00:00.000Z",
      sharedAt: "2026-10-10T08:00:00.000Z",
      publicKeys: { "0123456789abcdef": expect.stringContaining("PUBLIC KEY") },
    });
    // Every name the workspace knows is hidden from the reasoning, its own bills' payees as labels.
    expect(shown!.decisions[0]).toMatchObject({
      seq: 7,
      supplier: "Supplier A",
      reasoning: "Supplier A is paid monthly, unlike [hidden].",
      link: { body_hash: LINK.body_hash, signature: LINK.signature, prev_hash: LINK.prev_hash, hash: LINK.hash, signing_key_id: LINK.signing_key_id },
    });
    const json = JSON.stringify(shown);
    expect(json).not.toContain(ORG);
    expect(json).not.toContain(SHARE);
  });

  it("reads the decisions' signed links by their entry numbers only", async () => {
    const asked: RecordedRequest[] = [];
    tenant.reply = ((request: RecordedRequest) => {
      asked.push(request);
      return tenantReplies(request);
    }) as (request: unknown) => unknown;
    rpc.mockResolvedValueOnce({ data: FOUND, error: null });
    await readSharedReport(generateReportShareToken().token);
    const ledger = asked.find((request) => request.path === "/rest/v1/ledger_entries")!;
    expect(ledger.params.get("seq")).toBe("in.(7)");
    expect(ledger.params.get("select")).toBe("seq,body_hash,signature,prev_hash,hash,signing_key_id");
  });

  it("names nothing when the share hides the name, and reads a sandbox's simulated payments", async () => {
    rpc.mockResolvedValueOnce({ data: { ...FOUND, name: null, showWorkspaceName: false, mode: "sandbox", network: "arc-mainnet" }, error: null });
    const shown = await readSharedReport(generateReportShareToken().token);
    expect(reads.report).toHaveBeenCalledWith(expect.anything(), "arc-mainnet", { sandbox: true });
    expect(shown).toMatchObject({ title: "A business on Vestiarion", named: false });
    expect(JSON.stringify(shown)).not.toContain("Harbor Books");
  });

  it("refuses an answer that is not a share", async () => {
    rpc.mockResolvedValueOnce({ data: { ...FOUND, orgId: "not-a-uuid" }, error: null });
    await expect(readSharedReport(generateReportShareToken().token)).rejects.toThrow();
    expect(scopes).toEqual([]);
  });
});
