import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { readReceipt } from "@/lib/platform/receipts";
import { forgetMinedReceipts } from "@/lib/receipts/onchain";
import { receiptTokenHash } from "@/lib/receipts/token";
import type { PublicLedgerRow } from "@/lib/receipts/verify";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * What the public page reads for a receipt link (docs/superpowers/specs/2026-10-01-payment-receipts-design.md
 * P5): the receipt's facts and signed entry, and three checks made on the server — signed by the workspace,
 * recorded when it was paid, and on chain. A dead link reads as nothing.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const KEY_ID = ledgerKeyId(publicKey);
const KEYS = { [KEY_ID]: publicKey.export({ type: "spki", format: "pem" }).toString() };
const TOKEN = `vxr_${"A".repeat(43)}`;
const PAYEE = "0x221b000000000000000000000000000000001bc3";
const MINT = `0x${"3".repeat(64)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function signed(seq: number, action: string, summary: string, detail: Record<string, unknown>, prev = "0".repeat(64)): PublicLedgerRow {
  const body = { actor: "agent" as const, domain: "ap" as const, action, summary, detail };
  const bodyHash = bodyHashOf(body);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  return { seq, ...body, body_hash: bodyHash, signature, prev_hash: prev, hash: sha256(prev + bodyHash + signature), signing_key_id: KEY_ID };
}

const FACTS = { amount: 2, token: "USDC", paidAt: "2026-10-01T08:28:26.857Z", payee: PAYEE, chain: "ARB-SEPOLIA", txHash: MINT, route: "gateway", feeUsdc: 0.107811 };
const DECISION = signed(580, "ap_pay", "PAY invoice from STM for 2 USDC", { invoiceId: "inv-1", execution: { mintTxHash: MINT } });
const RECEIPT = signed(612, "receipt_shared", "Receipt: 2 USDC paid on Arbitrum Sepolia", { receipt: FACTS, records: { seq: 580, hash: DECISION.hash } }, DECISION.hash);

const MINTED = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    status: "0x1",
    blockNumber: "0x12c00b97",
    logs: [
      {
        address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${"0".repeat(64)}`, `0x${PAYEE.slice(2).padStart(64, "0")}`],
        data: `0x${(2_000_000).toString(16).padStart(64, "0")}`,
      },
    ],
  },
};

function read(found: unknown, chain: unknown = MINTED, token = TOKEN) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/payment_receipt_by_token") return { body: found };
    throw new Error(`unexpected ${request.path}`);
  });
  const chainFetch = vi.fn(async () => new Response(JSON.stringify(chain), { status: 200 }));
  const result = runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
    readReceipt(token, { fetch: chainFetch as unknown as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" })
  );
  return { result, fake, chainFetch };
}

describe("readReceipt", () => {
  beforeEach(() => {
    forgetMinedReceipts();
  });

  it("reads a live link by its hash, and checks the receipt is signed, was recorded when paid, and is on chain", async () => {
    const { result, fake } = read({ publicKeys: KEYS, entry: RECEIPT, records: DECISION });
    expect(await result).toEqual({
      facts: FACTS,
      entry: RECEIPT,
      publicKeys: KEYS,
      records: { seq: 580, signingKeyId: KEY_ID },
      checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "matches", block: 314575767 } },
    });
    expect(fake.requests[0].body).toEqual({ p_token_hash: receiptTokenHash(TOKEN) });
  });

  it("never shows the entry it names, only that it records the payment", async () => {
    const view = await read({ publicKeys: KEYS, entry: RECEIPT, records: DECISION }).result;
    expect(JSON.stringify(view)).not.toContain("STM");
    expect(JSON.stringify(view)).not.toContain("inv-1");
  });

  it("reads nothing for a dead link, and never asks for a malformed one", async () => {
    expect(await read(null).result).toBeNull();
    const malformed = read({ publicKeys: KEYS, entry: RECEIPT, records: DECISION }, MINTED, "vxp_nope");
    expect(await malformed.result).toBeNull();
    expect(malformed.fake.requests).toEqual([]);
  });

  it("says a receipt whose statement was changed is not signed", async () => {
    const changed = { ...RECEIPT, detail: { ...RECEIPT.detail, receipt: { ...FACTS, amount: 20 } } };
    const view = await read({ publicKeys: KEYS, entry: changed, records: DECISION }).result;
    expect(view?.checks.signed).toEqual({ ok: false, reason: "The entry's content does not match its body hash." });
  });

  it("says the payment was not recorded when the entry it names is missing, another, or records another transaction", async () => {
    expect((await read({ publicKeys: KEYS, entry: RECEIPT, records: null }).result)?.checks.recorded).toEqual({ ok: false, reason: "The entry this receipt names is not in the workspace's ledger." });
    const other = signed(580, "ap_pay", "PAY invoice", { invoiceId: "inv-1", execution: { mintTxHash: `0x${"9".repeat(64)}` } });
    expect((await read({ publicKeys: KEYS, entry: RECEIPT, records: other }).result)?.checks.recorded).toEqual({ ok: false, reason: "The entry this receipt names does not record its transaction." });
  });

  it("says the payment was not recorded by an entry written after the receipt, or one that records no payment (receipts review #8)", async () => {
    const later = signed(700, "ap_pay", "PAY invoice", { invoiceId: "inv-1", execution: { mintTxHash: MINT } });
    const afterIt = signed(612, "receipt_shared", "Receipt: 2 USDC paid on Arbitrum Sepolia", { receipt: FACTS, records: { seq: 700, hash: later.hash } }, DECISION.hash);
    expect((await read({ publicKeys: KEYS, entry: afterIt, records: later }).result)?.checks.recorded).toEqual({ ok: false, reason: "The entry this receipt names was not written before it." });
    const note = signed(580, "create_invoice", "Added payable invoice", { invoiceId: "inv-1", note: MINT });
    const namingNote = signed(612, "receipt_shared", "Receipt: 2 USDC paid on Arbitrum Sepolia", { receipt: FACTS, records: { seq: 580, hash: note.hash } }, DECISION.hash);
    expect((await read({ publicKeys: KEYS, entry: namingNote, records: note }).result)?.checks.recorded).toEqual({ ok: false, reason: "The entry this receipt names does not record a payment." });
  });

  it("says when the chain could not be read, and still shows the receipt", async () => {
    const view = await read({ publicKeys: KEYS, entry: RECEIPT, records: DECISION }, { jsonrpc: "2.0", id: 1, error: { code: -32000 } }).result;
    expect(view?.checks.onChain).toEqual({ state: "unreadable" });
    expect(view?.checks.signed).toEqual({ ok: true });
  });

  it("reads nothing for an entry that is not a receipt", async () => {
    expect(await read({ publicKeys: KEYS, entry: DECISION, records: null }).result).toBeNull();
  });
});
