import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { checkPayLink, createPayLink, PayLinkError, payLinkHash, previewPayLink } from "@/lib/platform/pay-links";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Pay links (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2): one per open receivable,
 * its token stored only as a hash; the public page's preview; and "I have paid", which only asks
 * Vestiarion to look sooner (R5), rate limited, with a cycle event once the receivable is received.
 */

const { ledgerMock, recordMock, withOrgMock, runSoonMock } = vi.hoisted(() => ({
  ledgerMock: vi.fn(),
  recordMock: vi.fn(),
  withOrgMock: vi.fn(),
  runSoonMock: vi.fn(),
}));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/receipts", () => ({ recordIncomingTransfers: recordMock }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: withOrgMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: runSoonMock }));
vi.mock("@/lib/circle", () => ({ getChainProvider: () => ({ mode: "live" }) }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const TOKEN = `vxr_${"A".repeat(43)}`;
const HASH = createHash("sha256").update("A".repeat(43), "utf8").digest("hex");

const PREVIEW = {
  orgId: ORG, invoiceId: INVOICE, createdBy: USER, orgName: "Mai Studio", clientName: "Acme", amount: 12.5, currency: "USDC",
  dueDate: "2026-10-15", memo: "October retainer", status: "open", payTo: "0x1111111111111111111111111111111111111111", chain: "ARC-TESTNET",
};

let fake: ReturnType<typeof fakeSupabase>;
const inOrg = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
const platform = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client }, fn);

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  recordMock.mockReset().mockResolvedValue({ recorded: 1, matched: 1, lines: [] });
  // The workspace's scope, over the same recorded client.
  withOrgMock.mockReset().mockImplementation(async (orgId: string, fn: () => Promise<unknown>) =>
    runWith(orgTestContext({ config, client: fake.client, orgId }), fn)
  );
  runSoonMock.mockReset();
});

describe("tokens", () => {
  it("are vxr_ and 43 base64url characters; only the secret's hash is looked up", () => {
    expect(payLinkHash(TOKEN)).toBe(HASH);
    for (const bad of ["", "vxr_short", `vxp_${"A".repeat(43)}`, `${TOKEN}x`]) expect(payLinkHash(bad)).toBeNull();
  });
});

describe("createPayLink", () => {
  const workspace = (invoice: unknown) => (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/invoices") return { body: invoice };
    if (r.path === "/rest/v1/receivable_links" && r.method === "POST") return { body: { id: "link-1" } };
    return { body: [] };
  };

  it("stores a new link's hash for an open receivable, replacing any earlier link, and records it", async () => {
    fake = fakeSupabase(workspace({ id: INVOICE, direction: "receivable", status: "pending" }));
    const { token } = await inOrg(() => createPayLink({ actorId: USER, invoiceId: INVOICE }));
    expect(token).toMatch(/^vxr_[A-Za-z0-9_-]{43}$/);
    const post = fake.requests.find((r) => r.path === "/rest/v1/receivable_links" && r.method === "POST")!;
    expect(post.params.get("on_conflict")).toBe("org_id,invoice_id");
    expect(post.body).toMatchObject({ org_id: ORG, invoice_id: INVOICE, token_hash: payLinkHash(token), created_by: USER, revoked_at: null });
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ actor: "human", domain: "ar", action: "pay_link_created", detail: { by: USER, invoiceId: INVOICE, linkId: "link-1" } }));
  });

  it("refuses a payable, a missing invoice, or a receivable already settled", async () => {
    fake = fakeSupabase(workspace({ id: INVOICE, direction: "payable", status: "pending" }));
    await expect(inOrg(() => createPayLink({ actorId: USER, invoiceId: INVOICE }))).rejects.toMatchObject({ code: "not_found" });
    fake = fakeSupabase(workspace(null));
    await expect(inOrg(() => createPayLink({ actorId: USER, invoiceId: INVOICE }))).rejects.toBeInstanceOf(PayLinkError);
    fake = fakeSupabase(workspace({ id: INVOICE, direction: "receivable", status: "received" }));
    await expect(inOrg(() => createPayLink({ actorId: USER, invoiceId: INVOICE }))).rejects.toMatchObject({ code: "closed" });
  });
});

describe("previewPayLink", () => {
  it("reads the page's facts by the token's hash", async () => {
    fake = fakeSupabase(() => ({ body: PREVIEW }));
    expect(await platform(() => previewPayLink(TOKEN))).toEqual(PREVIEW);
    expect(fake.requests[0].path).toBe("/rest/v1/rpc/pay_link_preview");
    expect(fake.requests[0].body).toEqual({ p_token_hash: HASH });
  });

  it("asks nothing for a malformed token, and finds nothing for an unknown one", async () => {
    fake = fakeSupabase(() => ({ body: null }));
    expect(await platform(() => previewPayLink("vxr_nope"))).toBeNull();
    expect(fake.requests).toEqual([]);
    expect(await platform(() => previewPayLink(TOKEN))).toBeNull();
  });
});

describe("checkPayLink", () => {
  it("looks for the payment in the workspace, and starts a cycle once the receivable is received", async () => {
    let reads = 0;
    fake = fakeSupabase((r) => {
      if (r.path === "/rest/v1/rpc/pay_link_preview") return { body: reads++ === 0 ? PREVIEW : { ...PREVIEW, status: "received" } };
      if (r.path === "/rest/v1/accounts") return { body: [{ id: "operating" }] };
      return { body: [] };
    });
    expect(await platform(() => checkPayLink(TOKEN, 1_000))).toBe("received");
    expect(withOrgMock).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(recordMock).toHaveBeenCalledWith(expect.anything(), { mode: "live" }, "operating");
    expect(runSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "payment_received" });
  });

  it("says not yet when nothing matched, and starts no cycle", async () => {
    fake = fakeSupabase((r) => (r.path === "/rest/v1/rpc/pay_link_preview" ? { body: PREVIEW } : r.path === "/rest/v1/accounts" ? { body: [{ id: "operating" }] } : { body: [] }));
    expect(await platform(() => checkPayLink(TOKEN, 100_000))).toBe("not_yet");
    expect(runSoonMock).not.toHaveBeenCalled();
  });

  it("answers received without looking again, and nothing for an unknown link", async () => {
    fake = fakeSupabase((r) => (r.path === "/rest/v1/rpc/pay_link_preview" ? { body: { ...PREVIEW, status: "received" } } : { body: [] }));
    expect(await platform(() => checkPayLink(TOKEN, 200_000))).toBe("received");
    expect(recordMock).not.toHaveBeenCalled();
    fake = fakeSupabase(() => ({ body: null }));
    expect(await platform(() => checkPayLink(TOKEN, 300_000))).toBe("invalid");
  });

  it("asks Circle at most a few times a minute per link", async () => {
    fake = fakeSupabase((r) => (r.path === "/rest/v1/rpc/pay_link_preview" ? { body: PREVIEW } : r.path === "/rest/v1/accounts" ? { body: [{ id: "operating" }] } : { body: [] }));
    const at = 10_000_000;
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await platform(() => checkPayLink(TOKEN, at)));
    expect(answers.filter((a) => a === "wait").length).toBeGreaterThan(0);
    expect(recordMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
