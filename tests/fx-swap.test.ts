import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { ChainProvider, SwapCallParams, SwapCallResult, SwapStep } from "@/lib/circle";
import { ARC_TESTNET_EURC } from "@/lib/fx/quote";
import { resumeOpenSwap, swapForPayment, swapStepKey } from "@/lib/fx/swap";
import type { SwapOffer } from "@/lib/fx/swap-service";
import answer from "./fixtures/stablecoin-swap-answer.json";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A swap made to pay a EURC invoice (docs/superpowers/specs/2026-10-01-eurc-swap-design.md S6, S7): the
 * service's transaction is recorded before anything is sent, sent under keys from the swap's id, and
 * closed with what the chain shows came in. A swap whose answer was lost is resumed with the same keys
 * and the same call, never made again.
 */

const { appendLedgerEntry } = vi.hoisted(() => ({ appendLedgerEntry: vi.fn(async () => ({})) }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005a9";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001ec";
// The captured answer's beneficiary: the wallet the swap pays back into.
const WALLET = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP_HASH = `0x${"5a".repeat(32)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const OFFER: SwapOffer = { usdcIn: 1, eurcEstimated: 0.822815, eurcMinimum: 0.798131, usdcPerEurc: 1.216081, costPercent: 0.06, provider: "lifi" };

beforeEach(() => {
  appendLedgerEntry.mockClear();
});

function database(options: { open?: Record<string, unknown> | null; insertError?: { code: string; message: string }; selectError?: { code: string; message: string } } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  if (options.open) rows.set(options.open.id as string, options.open);
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/fx_swaps") throw new Error(`unexpected request ${request.method} ${request.path}`);
    if (request.method === "GET") {
      if (options.selectError) return { status: 404, body: options.selectError };
      const open = [...rows.values()].find((row) => row.invoice_id === request.params.get("invoice_id")?.replace("eq.", "") && row.state === "submitted");
      return { body: open ?? null };
    }
    if (request.method === "POST") {
      if (options.insertError) return { status: 409, body: options.insertError };
      const row = request.body as Record<string, unknown>;
      rows.set(row.id as string, row);
      return { body: { id: row.id } };
    }
    if (request.method === "PATCH") {
      const id = request.params.get("id")?.replace("eq.", "") as string;
      rows.set(id, { ...rows.get(id), ...(request.body as Record<string, unknown>) });
      return { body: [] };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run, rows };
}

const step = (status: SwapStep["status"], txId: string, txHash: string | null = null): SwapStep => ({ status, txId, txHash, state: status === "confirmed" ? "COMPLETE" : status === "failed" ? "FAILED" : "SENT" });

function provider(result: (params: SwapCallParams) => SwapCallResult) {
  const swapForEurc = vi.fn(async (params: SwapCallParams) => result(params));
  return { provider: { mode: "live", swapForEurc } as unknown as ChainProvider, swapForEurc };
}

const confirmed = () => ({ approve: step("confirmed", "tx-approve", "0xa11"), execute: step("confirmed", "tx-swap", SWAP_HASH) });

/** Circle's Stablecoin Service, answering with the captured swap, and Arc testnet's RPC, with the swap's receipt. */
function network(options: { stopLimit?: string; noRoute?: boolean; received?: string } = {}) {
  const posted: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/stablecoinKits/swap")) {
      posted.push(JSON.parse(String(init?.body)));
      if (options.noRoute) return new Response(JSON.stringify({ code: 331001, message: "No route available" }), { status: 404 });
      return new Response(JSON.stringify({ ...answer, stopLimit: options.stopLimit ?? answer.stopLimit }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_getTransactionReceipt") {
      const to = `0x${WALLET.slice(2).padStart(64, "0")}`;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "0x1",
            blockNumber: "0x3dfa001",
            logs: [
              // The USDC that went in, and the EURC that came back to the wallet.
              { address: "0x3600000000000000000000000000000000000000", topics: [TRANSFER, to, `0x${ADAPTER.slice(2).padStart(64, "0")}`], data: `0x${(1_000_000).toString(16).padStart(64, "0")}` },
              { address: ARC_TESTNET_EURC.toLowerCase(), topics: [TRANSFER, `0x${ADAPTER.slice(2).padStart(64, "0")}`, to], data: `0x${BigInt(options.received ?? "822900").toString(16).padStart(64, "0")}` },
            ],
          },
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posted };
}

const deps = (p: ChainProvider, net: ReturnType<typeof network>) => ({ provider: p, operating: { id: "acct-op" }, operatingAddress: WALLET, fetch: net.fetch, retryDelayMs: 0 });
const input = { invoiceId: INVOICE, counterpartyName: "Atelier Lumière", offer: OFFER, short: 0.75, reasoning: "Pay now; the swap costs 0.06%." };

describe("swapForPayment", () => {
  it("records the swap before sending it, sends it under keys from its id, and closes it with what came in", async () => {
    const d = database();
    let rowWrittenFirst = false;
    const p = provider(() => {
      rowWrittenFirst = d.fake.requests.some((r) => r.method === "POST" && r.path === "/rest/v1/fx_swaps");
      return confirmed();
    });
    const net = network();
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, net)));

    expect(net.posted).toEqual([expect.objectContaining({ amount: "1000000", fromAddress: WALLET, toAddress: WALLET })]);
    const insert = d.fake.requests.find((r) => r.method === "POST")!;
    const row = insert.body as Record<string, unknown>;
    expect(row).toMatchObject({
      invoice_id: INVOICE,
      state: "submitted",
      usdc_in: 1,
      eurc_minimum: 0.798131,
      eurc_estimated: 0.822815,
      usdc_per_eurc: 1.216081,
      cost_percent: 0.06,
      provider: "lifi",
      adapter: ADAPTER,
    });
    expect(String(row.call_data).slice(0, 10)).toBe("0xaa3e079c");
    // Nothing is sent until the row that resumes it exists.
    expect(rowWrittenFirst).toBe(true);

    const swapId = row.id as string;
    expect(p.swapForEurc).toHaveBeenCalledWith({
      fromAccountId: "acct-op",
      adapter: ADAPTER,
      usdcIn: 1,
      callData: row.call_data,
      approveKey: swapStepKey(`${ORG}/swap/${INVOICE}/${swapId}/approve`),
      executeKey: swapStepKey(`${ORG}/swap/${INVOICE}/${swapId}/execute`),
    });
    expect(d.rows.get(swapId)).toMatchObject({
      state: "confirmed",
      approve_tx_id: "tx-approve",
      approve_tx_hash: "0xa11",
      swap_tx_id: "tx-swap",
      swap_tx_hash: SWAP_HASH,
      eurc_received: 0.8229,
    });
    expect(outcome).toEqual({ ok: true, swapId, usdcIn: 1, eurcMinimum: 0.798131, eurcReceived: 0.8229, swapTxHash: SWAP_HASH });

    expect(appendLedgerEntry).toHaveBeenCalledTimes(1);
    expect(appendLedgerEntry).toHaveBeenCalledWith({
      actor: "agent",
      domain: "treasury",
      action: "fx_swap",
      summary: "SWAP 1 USDC for 0.8229 EURC to pay Atelier Lumière's invoice",
      detail: {
        invoiceId: INVOICE,
        swapId,
        state: "confirmed",
        usdcIn: 1,
        eurcMinimum: 0.798131,
        eurcEstimated: 0.822815,
        eurcReceived: 0.8229,
        usdcPerEurc: 1.216081,
        costPercent: 0.06,
        provider: "lifi",
        adapter: ADAPTER,
        approveTxHash: "0xa11",
        swapTxHash: SWAP_HASH,
        failure: null,
        reasoning: input.reasoning,
        resumed: false,
      },
    });
  });

  it("sends nothing when the rate moved and the swap would no longer cover the EURC needed", async () => {
    const d = database();
    const p = provider(confirmed);
    const outcome = await d.run(() => swapForPayment({ ...input, short: 0.8 }, deps(p.provider, network())));
    expect(outcome).toEqual({ ok: false, pending: false, swapId: null, reason: "The rate moved: the swap would now give at least 0.798131 EURC, less than the 0.8 EURC needed." });
    expect(d.fake.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(p.swapForEurc).not.toHaveBeenCalled();
    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });

  it("sends nothing when the service gives no swap", async () => {
    const d = database();
    const p = provider(confirmed);
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, network({ noRoute: true }))));
    expect(outcome).toMatchObject({ ok: false, pending: false, swapId: null, reason: expect.stringContaining("No USDC→EURC route") });
    expect(p.swapForEurc).not.toHaveBeenCalled();
  });

  it("sends nothing when another swap for the invoice is in flight", async () => {
    const d = database({ insertError: { code: "23505", message: 'duplicate key value violates unique constraint "fx_swaps_one_submitted"' } });
    const p = provider(confirmed);
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, network())));
    expect(outcome).toEqual({ ok: false, pending: true, swapId: null, reason: "Another swap for this invoice is in flight." });
    expect(p.swapForEurc).not.toHaveBeenCalled();
  });

  it("closes a swap Circle failed as failed, and records it", async () => {
    const d = database();
    const p = provider(() => ({ approve: step("confirmed", "tx-approve", "0xa11"), execute: step("failed", "tx-swap") }));
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, network())));
    const swapId = (d.fake.requests.find((r) => r.method === "POST")!.body as { id: string }).id;
    expect(d.rows.get(swapId)).toMatchObject({ state: "failed", failure: "Circle did not complete the swap (FAILED)." });
    expect(outcome).toEqual({ ok: false, pending: false, swapId, reason: "Circle did not complete the swap (FAILED)." });
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "fx_swap", summary: "SWAP failed: 1 USDC for EURC to pay Atelier Lumière's invoice", detail: expect.objectContaining({ state: "failed", eurcReceived: null }) })
    );
  });

  it("closes a swap whose approval failed without sending the swap", async () => {
    const d = database();
    const p = provider(() => ({ approve: step("failed", "tx-approve"), execute: null }));
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, network())));
    expect(outcome).toMatchObject({ ok: false, pending: false, reason: "Circle did not complete the approval (FAILED)." });
  });

  it("leaves a swap Circle has not finished in flight, to be resumed", async () => {
    const d = database();
    const p = provider(() => ({ approve: step("confirmed", "tx-approve", "0xa11"), execute: step("pending", "tx-swap") }));
    const outcome = await d.run(() => swapForPayment(input, deps(p.provider, network())));
    const swapId = (d.fake.requests.find((r) => r.method === "POST")!.body as { id: string }).id;
    expect(d.rows.get(swapId)).toMatchObject({ state: "submitted", swap_tx_id: "tx-swap" });
    expect(outcome).toEqual({ ok: false, pending: true, swapId, reason: "A swap for this invoice is in flight at Circle." });
    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });
});

describe("resumeOpenSwap", () => {
  const OPEN = {
    id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000055aa", invoice_id: INVOICE, state: "submitted", usdc_in: "1", eurc_minimum: "0.798131", eurc_estimated: "0.822815",
    usdc_per_eurc: "1.216081", cost_percent: "0.06", provider: "lifi", adapter: ADAPTER, call_data: "0xaa3e079c00", deadline: "2026-10-01T12:10:00Z",
  };

  it("sends the open swap's calls again, under the same keys and with the same call, and closes it", async () => {
    const d = database({ open: OPEN });
    const p = provider(confirmed);
    const outcome = await d.run(() => resumeOpenSwap({ invoiceId: INVOICE, counterpartyName: "Atelier Lumière" }, deps(p.provider, network())));

    expect(p.swapForEurc).toHaveBeenCalledWith({
      fromAccountId: "acct-op",
      adapter: ADAPTER,
      usdcIn: 1,
      callData: "0xaa3e079c00",
      approveKey: swapStepKey(`${ORG}/swap/${INVOICE}/${OPEN.id}/approve`),
      executeKey: swapStepKey(`${ORG}/swap/${INVOICE}/${OPEN.id}/execute`),
    });
    expect(d.rows.get(OPEN.id)).toMatchObject({ state: "confirmed", eurc_received: 0.8229 });
    expect(outcome).toMatchObject({ ok: true, swapId: OPEN.id, eurcReceived: 0.8229 });
    expect(appendLedgerEntry).toHaveBeenCalledWith(expect.objectContaining({ action: "fx_swap", detail: expect.objectContaining({ resumed: true, reasoning: null }) }));
  });

  it("is nothing when the invoice has no swap in flight", async () => {
    const d = database();
    const p = provider(confirmed);
    expect(await d.run(() => resumeOpenSwap({ invoiceId: INVOICE, counterpartyName: "x" }, deps(p.provider, network())))).toBeNull();
    expect(p.swapForEurc).not.toHaveBeenCalled();
  });

  it("is nothing before the swaps table exists (0048 not applied)", async () => {
    const d = database({ selectError: { code: "PGRST205", message: "Could not find the table 'public.fx_swaps' in the schema cache" } });
    const p = provider(confirmed);
    expect(await d.run(() => resumeOpenSwap({ invoiceId: INVOICE, counterpartyName: "x" }, deps(p.provider, network())))).toBeNull();
  });
});
