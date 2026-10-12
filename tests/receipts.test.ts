import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { matchTransfer, recordIncomingTransfers, type OpenReceivable } from "@/lib/agent/receipts";
import type { ChainProvider, InboundTransfer } from "@/lib/circle/types";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * Money in, matched to what was owed (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md):
 * each completed inbound transfer is recorded once, then matched to an open receivable of the same
 * currency and amount, its client's own address first; an ambiguous one waits for a person (R1). A
 * matched receivable becomes received, compare-and-set, and the ledger signs `ar_received`.
 */

const { ledgerMock, floatMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), floatMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/test-usdc", () => ({ floatAddress: floatMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const CLIENT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

const transfer = (over: Partial<InboundTransfer> = {}): InboundTransfer => ({
  circleTxId: "circle-1", txHash: "0xabc", from: CLIENT, amount: 12.5, token: "USDC", chain: "ARC-TESTNET", receivedAt: "2026-10-01T15:00:05Z", ...over,
});
const receivable = (over: Partial<OpenReceivable> = {}): OpenReceivable => ({
  id: "inv-1", counterpartyId: "cp-1", clientName: "Acme", amount: 12.5, currency: "USDC", dueDate: "2026-10-15T12:00:00Z", clientAddress: CLIENT,
  createdAt: "2026-10-01T09:00:00Z", hasPayLink: true, ...over,
});

describe("matchTransfer", () => {
  it("matches the client's own receivable by sender first, oldest due among them", () => {
    const open = [
      receivable({ id: "later", dueDate: "2026-10-20T12:00:00Z" }),
      receivable({ id: "other-client", clientAddress: OTHER, dueDate: "2026-10-01T12:00:00Z" }),
      receivable({ id: "sooner", dueDate: "2026-10-10T12:00:00Z" }),
    ];
    expect(matchTransfer(transfer(), open)).toEqual({ invoiceId: "sooner", matchedBy: "sender" });
  });

  it("matches the one receivable of that amount when the sender is not on file", () => {
    expect(matchTransfer(transfer({ from: OTHER }), [receivable({ clientAddress: null })])).toEqual({ invoiceId: "inv-1", matchedBy: "amount" });
  });

  it("leaves two receivables of the same amount, with no sender match, for a person (R1)", () => {
    expect(matchTransfer(transfer({ from: OTHER }), [receivable({ id: "a", clientAddress: null }), receivable({ id: "b", clientAddress: null })])).toBeNull();
  });

  it("never matches money that arrived before the receivable existed, such as a faucet drip", () => {
    expect(matchTransfer(transfer({ receivedAt: "2026-10-01T08:00:00Z" }), [receivable()])).toBeNull();
  });

  it("matches by amount alone only a receivable whose client was sent its pay link", () => {
    expect(matchTransfer(transfer({ from: OTHER }), [receivable({ clientAddress: null, hasPayLink: false })])).toBeNull();
    // The client's own address on file needs no link.
    expect(matchTransfer(transfer(), [receivable({ hasPayLink: false })])).toEqual({ invoiceId: "inv-1", matchedBy: "sender" });
  });

  it("never matches another amount or currency", () => {
    expect(matchTransfer(transfer({ amount: 12.49 }), [receivable()])).toBeNull();
    expect(matchTransfer(transfer({ token: "EURC" }), [receivable()])).toBeNull();
    expect(matchTransfer(transfer({ amount: 12.5000001 }), [receivable()])).toEqual({ invoiceId: "inv-1", matchedBy: "sender" });
  });
});

describe("recordIncomingTransfers", () => {
  let fake: ReturnType<typeof fakeSupabase>;
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const provider = (transfers: InboundTransfer[]) =>
    ({ mode: "live", network: ARC_TESTNET, listInboundTransfers: vi.fn().mockResolvedValue(transfers) }) as unknown as ChainProvider;

  const UNMATCHED = [{ id: "row-1", circle_tx_id: "circle-1", tx_hash: "0xabc", from_address: CLIENT, amount: "12.500000", token: "USDC", received_at: "2026-10-01T15:00:05Z" }];
  const OPEN = [{
    id: "inv-1", counterparty_id: "cp-1", amount: "12.500000", currency: "USDC", due_date: "2026-10-15T12:00:00Z", created_at: "2026-10-01T09:00:00Z",
    counterparties: { name: "Acme", address: CLIENT },
  }];

  function workspace(
    over: { latest?: unknown[]; unmatched?: unknown[]; open?: unknown[]; invoicePatch?: unknown[]; grants?: unknown[]; allocations?: FakeReply; applied?: FakeReply; claim?: FakeReply } = {}
  ) {
    return (r: RecordedRequest): FakeReply => {
      if (r.path === "/rest/v1/receivable_allocations" && r.method === "GET") return over.allocations ?? { body: [] };
      if (r.path === "/rest/v1/receivable_allocations" && r.method === "POST") {
        return over.applied ?? { status: 201, body: { id: "alloc-1", created_at: "2026-10-01T15:01:00Z", reverses: null, reason: null, payment_seq: 1, ...(r.body as object) } };
      }
      if (r.path === "/rest/v1/incoming_transfers" && r.method === "PATCH" && over.claim && r.params.get("select")) return over.claim;
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("action") === "eq.test_usdc_added") return { body: over.grants ?? [] };
      if (r.path === "/rest/v1/incoming_transfers" && r.method === "GET") {
        return r.params.has("invoice_id") ? { body: over.unmatched ?? UNMATCHED } : { body: over.latest ?? [] };
      }
      // As PostgREST answers a write that asks for nothing back (return=minimal): no body at all. A fake that
      // answered [] here hid a production failure ("Supabase returned no data", 2026-10-02).
      if (r.path === "/rest/v1/incoming_transfers" && r.method === "POST") return { status: 201, body: null };
      if (r.path === "/rest/v1/incoming_transfers" && r.method === "PATCH") {
        return r.params.get("select") ? { body: [{ id: "row-1" }] } : { status: 200, body: null };
      }
      if (r.path === "/rest/v1/invoices" && r.method === "GET") return { body: over.open ?? OPEN };
      if (r.path === "/rest/v1/receivable_links" && r.method === "GET") return { body: [{ invoice_id: "inv-1" }] };
      if (r.path === "/rest/v1/invoices" && r.method === "PATCH") return { body: over.invoicePatch ?? [{ id: "inv-1" }] };
      return { body: [] };
    };
  }
  const patches = (path: string) => fake.requests.filter((r) => r.path === path && r.method === "PATCH");

  beforeEach(() => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
    floatMock.mockReset().mockResolvedValue(null);
    fake = fakeSupabase(workspace());
  });

  it("does nothing for a provider with no real wallet (R4)", async () => {
    const simulated = { mode: "simulate", network: ARC_TESTNET } as unknown as ChainProvider;
    expect(await run(() => recordIncomingTransfers(db(), simulated, "operating"))).toEqual({ recorded: 0, matched: 0, lines: [] });
    expect(fake.requests).toEqual([]);
  });

  it("reads Circle since a day before the latest transfer recorded, or 30 days back", async () => {
    const live = provider([]);
    await run(() => recordIncomingTransfers(db(), live, "operating", Date.parse("2026-10-01T16:00:00Z")));
    expect(live.listInboundTransfers).toHaveBeenCalledWith("operating", "2026-09-01T16:00:00.000Z");
    fake = fakeSupabase(workspace({ latest: [{ received_at: "2026-10-01T10:00:00Z" }] }));
    const again = provider([]);
    await run(() => recordIncomingTransfers(db(), again, "operating", Date.parse("2026-10-01T16:00:00Z")));
    expect(again.listInboundTransfers).toHaveBeenCalledWith("operating", "2026-09-30T10:00:00.000Z");
  });

  it("records each transfer once, ignoring one already recorded (R3)", async () => {
    await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
    const post = fake.requests.find((r) => r.path === "/rest/v1/incoming_transfers" && r.method === "POST")!;
    expect(post.params.get("on_conflict")).toBe("org_id,circle_tx_id");
    expect(post.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(post.body).toEqual([
      { org_id: ORG, circle_tx_id: "circle-1", tx_hash: "0xabc", from_address: CLIENT, amount: 12.5, token: "USDC", chain: "ARC-TESTNET", received_at: "2026-10-01T15:00:05Z" },
    ]);
  });

  it("settles the matched receivable as received, claims the transfer, and signs ar_received", async () => {
    const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
    const [claim] = patches("/rest/v1/incoming_transfers");
    expect(claim.body).toEqual({ invoice_id: "inv-1", matched_by: "sender" });
    expect(claim.params.get("invoice_id")).toBe("is.null");
    const [settle] = patches("/rest/v1/invoices");
    expect(settle.body).toEqual({ status: "received", settled_at: "2026-10-01T15:00:05Z", tx_ref: "0xabc", decided_at: expect.any(String) });
    expect(settle.params.get("status")).toBe("in.(pending,matched)");
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent",
        domain: "ar",
        action: "ar_received",
        detail: { invoiceId: "inv-1", counterpartyId: "cp-1", amount: 12.5, currency: "USDC", txHash: "0xabc", from: CLIENT, circleTxId: "circle-1", matchedBy: "sender", receivedAt: "2026-10-01T15:00:05Z" },
      })
    );
    expect(result).toEqual({ recorded: 1, matched: 1, lines: [{ domain: "ar", message: "Received 12.5 USDC from Acme on Arc testnet (matched by sender)" }] });
  });

  it("names the network a payment was received on: Arc mainnet for a provider there (mainnet copy C1)", async () => {
    const mainnet = { mode: "live", network: ARC_MAINNET, listInboundTransfers: vi.fn().mockResolvedValue([transfer()]) } as unknown as ChainProvider;
    const result = await run(() => recordIncomingTransfers(db(), mainnet, "operating"));
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ar_received", summary: "Received 12.5 USDC from Acme on Arc mainnet" }));
    expect(result.lines).toEqual([{ domain: "ar", message: "Received 12.5 USDC from Acme on Arc mainnet (matched by sender)" }]);
  });

  it("puts the transfer back when the receivable was settled meanwhile", async () => {
    fake = fakeSupabase(workspace({ invoicePatch: [] }));
    const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
    const claims = patches("/rest/v1/incoming_transfers");
    expect(claims).toHaveLength(2);
    expect(claims[1].body).toEqual({ invoice_id: null, matched_by: null });
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(result.matched).toBe(0);
  });

  it("never matches money from Vestiarion's test USDC float to a receivable, whatever its amount (test USDC T6)", async () => {
    const FLOAT = "0xf10a7000000000000000000000000000000000f1";
    // The one open receivable of that amount was sent its pay link: an amount alone would match it.
    expect(matchTransfer(transfer({ from: FLOAT }), [receivable({ clientAddress: null })])).toEqual({ invoiceId: "inv-1", matchedBy: "amount" });
    fake = fakeSupabase(
      workspace({
        unmatched: [{ ...UNMATCHED[0], from_address: FLOAT }],
        open: [{ ...OPEN[0], counterparties: { name: "Acme", address: null } }],
        grants: [{ detail: { from: "0xF10A7000000000000000000000000000000000F1" } }],
      })
    );
    const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ from: FLOAT })]), "operating"));
    expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
    expect(patches("/rest/v1/invoices")).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recorded: 1, matched: 0 });
  });

  it("never matches money from the float's own address, before any entry names it (test USDC review fix E)", async () => {
    const FLOAT = "0xf10a7000000000000000000000000000000000f1";
    floatMock.mockResolvedValue("0xF10A7000000000000000000000000000000000F1");
    fake = fakeSupabase(
      workspace({ unmatched: [{ ...UNMATCHED[0], from_address: FLOAT }], open: [{ ...OPEN[0], counterparties: { name: "Acme", address: null } }], grants: [] })
    );
    const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ from: FLOAT })]), "operating"));
    expect(floatMock).toHaveBeenCalledTimes(1);
    expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
    expect(patches("/rest/v1/invoices")).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recorded: 1, matched: 0 });
  });

  it("asks for the float's address only when a transfer waits to be matched", async () => {
    fake = fakeSupabase(workspace({ unmatched: [] }));
    await run(() => recordIncomingTransfers(db(), provider([]), "operating"));
    expect(floatMock).not.toHaveBeenCalled();
  });

  it("leaves an ambiguous transfer unmatched", async () => {
    const two = [OPEN[0], { ...OPEN[0], id: "inv-2", counterparties: { name: "Beta", address: null } }].map((row) => ({ ...row, counterparties: { ...row.counterparties, address: null } }));
    fake = fakeSupabase(workspace({ open: two }));
    const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ from: OTHER })]), "operating"));
    expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
    expect(result).toMatchObject({ recorded: 1, matched: 0 });
  });

  describe("beside payments a person applied (allocations L3)", () => {
    const MISSING = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.receivable_allocations' in the schema cache" } };
    const allocation = (over: Record<string, unknown> = {}) => ({
      id: "earlier",
      kind: "payment",
      invoice_id: "inv-1",
      transfer_id: "row-0",
      amount: "5.000000",
      currency: "USDC",
      reverses: null,
      reason: null,
      basis: "person",
      payment_seq: 1,
      created_by: "person-1",
      created_at: "2026-10-01T10:00:00Z",
      ...over,
    });
    const posts = () => fake.requests.filter((r) => r.path === "/rest/v1/receivable_allocations" && r.method === "POST");

    it("matches whole as before when migration 0103 has not run", async () => {
      fake = fakeSupabase(workspace({ allocations: MISSING }));
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
      expect(patches("/rest/v1/incoming_transfers")[0].body).toEqual({ invoice_id: "inv-1", matched_by: "sender" });
      expect(result.matched).toBe(1);
    });

    it("leaves a transfer a person applied to them", async () => {
      fake = fakeSupabase(workspace({ allocations: { body: [allocation({ transfer_id: "row-1" })] } }));
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
      expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
      expect(posts()).toHaveLength(0);
      expect(result.matched).toBe(0);
    });

    it("never matches a part-paid receivable by its full amount", async () => {
      fake = fakeSupabase(workspace({ allocations: { body: [allocation()] } }));
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
      expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
      expect(posts()).toHaveLength(0);
      expect(result.matched).toBe(0);
    });

    it("applies a transfer that is exactly what is still owed, from the client's address, and signs it", async () => {
      fake = fakeSupabase(workspace({ allocations: { body: [allocation()] }, unmatched: [{ ...UNMATCHED[0], amount: "7.500000" }] }));
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ amount: 7.5 })]), "operating"));
      expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
      expect(posts()[0].body).toEqual({ org_id: ORG, kind: "payment", invoice_id: "inv-1", transfer_id: "row-1", amount: 7.5, currency: "USDC", basis: "sender", created_by: null });
      expect(ledgerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "agent",
          domain: "ar",
          action: "ar_payment_applied",
          summary: "Received 7.5 USDC from Acme on Arc testnet, what was still owed, and applied it",
          detail: expect.objectContaining({ by: null, allocationId: "alloc-1", invoiceId: "inv-1", transferId: "row-1", amount: 7.5, basis: "sender", outstandingAfter: 0, txHash: "0xabc" }),
        })
      );
      expect(result).toEqual({ recorded: 1, matched: 1, lines: [{ domain: "ar", message: "Received 7.5 USDC from Acme on Arc testnet, what was still owed (matched by sender)" }] });
    });

    it("leaves it to the person when the database refuses the application", async () => {
      fake = fakeSupabase(
        workspace({
          allocations: { body: [allocation()] },
          unmatched: [{ ...UNMATCHED[0], amount: "7.500000" }],
          applied: { status: 400, body: { code: "P0001", message: "allocation_exceeds_receivable: more than the receivable owes" } },
        })
      );
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ amount: 7.5 })]), "operating"));
      expect(ledgerMock).not.toHaveBeenCalled();
      expect(result.matched).toBe(0);
    });

    it("leaves a whole match the database refuses, because a person applied a payment a moment before", async () => {
      fake = fakeSupabase(workspace({ claim: { status: 400, body: { code: "P0001", message: "receivable_partly_paid: payments are applied to this receivable" } } }));
      const result = await run(() => recordIncomingTransfers(db(), provider([transfer()]), "operating"));
      expect(patches("/rest/v1/invoices")).toHaveLength(0);
      expect(ledgerMock).not.toHaveBeenCalled();
      expect(result.matched).toBe(0);
    });

    // A part-paid receivable's pay link asks for what is still owed: an open receivable of that same amount makes a
    // transfer from an unknown address ambiguous, either way round (R1).
    describe("an amount alone, beside an open receivable of the same amount", () => {
      const BEACON = { ...OPEN[0], id: "inv-2", counterparty_id: "cp-2", amount: "7.500000", counterparties: { name: "Beacon", address: null } };
      const both = (links: string[], from: string = OTHER) => {
        const base = workspace({ allocations: { body: [allocation()] }, unmatched: [{ ...UNMATCHED[0], from_address: from, amount: "7.500000" }], open: [OPEN[0], BEACON] });
        return (r: RecordedRequest): FakeReply =>
          r.path === "/rest/v1/receivable_links" && r.method === "GET" ? { body: links.map((id) => ({ invoice_id: id })) } : base(r);
      };

      it("leaves it for a person when both clients were sent their pay link", async () => {
        fake = fakeSupabase(both(["inv-1", "inv-2"]));
        const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ from: OTHER, amount: 7.5 })]), "operating"));
        expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
        expect(posts()).toHaveLength(0);
        expect(result.matched).toBe(0);
      });

      it("leaves it for a person when only the part-paid one was sent its pay link", async () => {
        fake = fakeSupabase(both(["inv-1"]));
        const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ from: OTHER, amount: 7.5 })]), "operating"));
        expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
        expect(posts()).toHaveLength(0);
        expect(result.matched).toBe(0);
      });

      it("still applies the rest from the client's own address", async () => {
        fake = fakeSupabase(both(["inv-1", "inv-2"], CLIENT));
        const result = await run(() => recordIncomingTransfers(db(), provider([transfer({ amount: 7.5 })]), "operating"));
        expect(patches("/rest/v1/incoming_transfers")).toHaveLength(0);
        expect(posts()[0].body).toMatchObject({ invoice_id: "inv-1", basis: "sender" });
        expect(result.matched).toBe(1);
      });
    });
  });
});
