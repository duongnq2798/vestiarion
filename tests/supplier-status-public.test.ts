import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { generateSupplierStatusToken } from "@/lib/supplier-status/token";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a supplier's payment status link reads (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2-V4). No
 * session: a malformed link is never looked up; a stopped or unknown one is dead and names no one; an expired one says
 * only when it expired. A live one reads only its own supplier's payables, inside the workspace's scope, with each
 * payment's transaction, and writes nothing.
 */

const ORG = "6d0f3a2e-8c1b-4f7a-9e6d-00000000d0d0";
const SUPPLIER = "6d0f3a2e-8c1b-4f7a-9e6d-0000000000d1";
const LINK = "6d0f3a2e-8c1b-4f7a-9e6d-00000000011d";
const HELD = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001b1";
const PAID = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001b2";
const SENDING = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001b3";
const TX = "0x1adfad848f00fdadf7021ba1f1ac30505146c40c220eac8cbca36cfc479e3a7b";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const { rpc, scopes, tenant, shadow } = vi.hoisted(() => ({
  shadow: { on: false },
  rpc: vi.fn(),
  scopes: [] as string[],
  tenant: { reply: ((): unknown => ({ body: [] })) as (request: unknown) => unknown, requests: [] as unknown[] },
}));
vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({ rpc }),
}));
vi.mock("@/lib/dal/scope", () => ({
  withOrg: async (orgId: string, fn: () => Promise<unknown>) => {
    scopes.push(orgId);
    const fake = fakeSupabase((request) => {
      tenant.requests.push(request);
      return tenant.reply(request) as FakeReply;
    });
    return runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  },
}));

import { readSupplierStatus } from "@/lib/supplier-status/public";

const NOW = Date.parse("2026-10-18T09:00:00Z");
const LIVE = {
  expired: false,
  linkId: LINK,
  orgId: ORG,
  counterpartyId: SUPPLIER,
  expiresAt: "2026-11-17T09:00:00Z",
  orgName: "Pinecrest Studio",
  supplierName: "Cobalt Cloud",
  mode: "live",
  network: "arc-testnet",
};

function invoice(id: string, fields: Record<string, unknown>) {
  return { id, amount: "45", currency: "USDC", due_date: "2026-10-24", memo: null, po_reference: null, status: "pending", scheduled_for: null, settled_at: null, ...fields };
}

beforeEach(() => {
  shadow.on = false;
  rpc.mockReset();
  scopes.length = 0;
  tenant.requests = [];
  tenant.reply = (request) => {
    const r = request as RecordedRequest;
    if (r.path === "/rest/v1/shadow_modes") return { body: shadow.on ? [{ currency: "USD", started_at: "2026-10-08T00:00:00Z", started_by: null }] : [] };
    if (r.path === "/rest/v1/invoices" && r.params.get("status") === "eq.paid") {
      return { body: [invoice(PAID, { status: "paid", amount: "50", memo: "CC-2026-1024 production database backups", settled_at: "2026-10-17T21:44:13Z" })] };
    }
    if (r.path === "/rest/v1/invoices") {
      return {
        body: [
          invoice(HELD, { status: "held", amount: "140", memo: "CC-2026-1020 render farm", po_reference: "PO-CC-1020", due_date: "2026-10-22" }),
          invoice(SENDING, { status: "scheduled", amount: "45", scheduled_for: "2026-10-24T00:00:00Z" }),
        ],
      };
    }
    if (r.path === "/rest/v1/payment_intents") {
      return {
        body: [
          { source_id: PAID, status: "failed", tx_hash: null, created_at: "2026-10-17T21:40:00Z" },
          { source_id: PAID, status: "confirmed", tx_hash: TX, created_at: "2026-10-17T21:44:00Z" },
          { source_id: SENDING, status: "submitting", tx_hash: null, created_at: "2026-10-18T08:59:00Z" },
        ],
      };
    }
    throw new Error(`unexpected request ${r.method} ${r.path}`);
  };
});

describe("readSupplierStatus", () => {
  it("never looks up a malformed link", async () => {
    expect(await readSupplierStatus("vxc_not-this-kind")).toEqual({ state: "dead" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers dead for a stopped or unknown link, and only the day for an expired one", async () => {
    const { token } = generateSupplierStatusToken();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await readSupplierStatus(token, NOW)).toEqual({ state: "dead" });
    rpc.mockResolvedValueOnce({ data: { expired: true, expiresAt: "2026-10-10T00:00:00Z" }, error: null });
    expect(await readSupplierStatus(token, NOW)).toEqual({ state: "expired", expiresAt: "2026-10-10T00:00:00Z" });
    expect(scopes).toEqual([]);
  });

  it("answers dead before migration 0131 runs", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await readSupplierStatus(generateSupplierStatusToken().token, NOW)).toEqual({ state: "dead" });
  });

  it("looks a link up by its secret's hash and reads only that supplier's payables, in its workspace, writing nothing", async () => {
    const { token, secretHash } = generateSupplierStatusToken();
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    const read = await readSupplierStatus(token, NOW);
    expect(rpc).toHaveBeenCalledWith("supplier_status_by_token", { p_token_hash: secretHash });
    expect(scopes).toEqual([ORG]);

    const requests = tenant.requests as RecordedRequest[];
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const invoiceReads = requests.filter((request) => request.path === "/rest/v1/invoices");
    expect(invoiceReads).toHaveLength(2);
    for (const request of invoiceReads) {
      expect(request.params.get("counterparty_id")).toBe(`eq.${SUPPLIER}`);
      expect(request.params.get("direction")).toBe("eq.payable");
      expect(request.params.get("org_id")).toBe(`eq.${ORG}`);
    }
    // Rejected bills are never read as open.
    expect(invoiceReads[0].params.get("status")).not.toContain("rejected");
    const intents = requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(intents?.params.get("source_type")).toBe("eq.invoice");

    expect(read.state).toBe("live");
    if (read.state !== "live") return;
    expect(read.sandbox).toBe(false);
    expect(read.view.open.map((line) => [line.reference, line.words])).toEqual([
      // A payment being sent is on its way, though the bill still says scheduled.
      ["Bill due Oct 24, 2026", "Payment on its way"],
      ["CC-2026-1020 render farm", "Being reviewed"],
    ]);
    expect(read.view.paid).toEqual([
      expect.objectContaining({ reference: "CC-2026-1024 production database backups", words: "Paid on Oct 17, 2026", txUrl: `https://explorer.testnet.arc.io/tx/${TX}` }),
    ]);
    expect(read.view.stillToBePaid).toEqual(["185.00 USDC"]);
    expect(read.view.simulated).toBe(false);
    // Nothing of the workspace's ids reaches the page.
    expect(JSON.stringify(read.view)).not.toContain(ORG);
    expect(JSON.stringify(read.view)).not.toContain(SUPPLIER);
  });

  it("shows no bills for a workspace in shadow mode, whose testnet payments only mirror the bills it pays its own way (V8)", async () => {
    shadow.on = true;
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    expect(await readSupplierStatus(generateSupplierStatusToken().token, NOW)).toEqual({ state: "unavailable" });
    expect((tenant.requests as RecordedRequest[]).some((request) => request.path === "/rest/v1/invoices")).toBe(false);
  });

  it("says a sandbox pays nothing for real", async () => {
    rpc.mockResolvedValueOnce({ data: { ...LIVE, mode: "sandbox" }, error: null });
    const read = await readSupplierStatus(generateSupplierStatusToken().token, NOW);
    expect(read.state === "live" && read.sandbox && read.view.simulated).toBe(true);
  });
});
