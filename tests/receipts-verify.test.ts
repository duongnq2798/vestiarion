import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { bodyHashOf, canonicalJson } from "@/lib/ledger";
import { canonicalJson as sharedCanonicalJson } from "@/lib/canonical-json";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { recordsTransaction, verifyEntry, type PublicLedgerRow } from "@/lib/receipts/verify";

/**
 * The receipt's verifier (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5, R5): one
 * implementation over Web Crypto, run by the server and again by the reader's browser. Here it runs under
 * Node's Web Crypto against entries signed the way the ledger signs them.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = ledgerKeyId(publicKey);
const other = crypto.generateKeyPairSync("ed25519");
const OTHER_PEM = other.publicKey.export({ type: "spki", format: "pem" }).toString();

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function signed(detail: Record<string, unknown>, options: { key?: crypto.KeyObject; keyId?: string | null; prev?: string } = {}): PublicLedgerRow {
  const body = { actor: "human" as const, domain: "ap" as const, action: "receipt_shared", summary: "Receipt: 2 USDC paid on Arbitrum Sepolia", detail };
  const bodyHash = bodyHashOf(body);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), options.key ?? privateKey).toString("hex");
  const prev = options.prev ?? "7".repeat(64);
  return { seq: 612, ...body, body_hash: bodyHash, signature, prev_hash: prev, hash: sha256(prev + bodyHash + signature), signing_key_id: options.keyId === undefined ? KEY_ID : options.keyId };
}

const DETAIL = { receipt: { amount: 2, token: "USDC", txHash: `0x${"3".repeat(64)}` }, records: { seq: 580, hash: "h".repeat(64) } };

describe("verifyEntry", () => {
  it("verifies an entry's body hash, its Ed25519 signature with the key it names, and its chain hash", async () => {
    expect(await verifyEntry(signed(DETAIL), { [KEY_ID]: PEM })).toEqual({ ok: true });
  });

  it("verifies an entry from before key labels with any key it is given", async () => {
    expect(await verifyEntry(signed(DETAIL, { keyId: null }), { other: OTHER_PEM, [KEY_ID]: PEM })).toEqual({ ok: true });
  });

  it("finds a body changed after signing", async () => {
    const row = signed(DETAIL);
    expect(await verifyEntry({ ...row, detail: { ...DETAIL, receipt: { ...DETAIL.receipt, amount: 20 } } }, { [KEY_ID]: PEM })).toEqual({
      ok: false,
      reason: "The entry's content does not match its body hash.",
    });
  });

  it("finds a signature made by another key", async () => {
    const forged = signed(DETAIL, { key: other.privateKey });
    expect(await verifyEntry(forged, { [KEY_ID]: PEM })).toEqual({ ok: false, reason: "The signature does not verify with the workspace's key." });
  });

  it("finds a chain hash that does not follow from the entry", async () => {
    expect(await verifyEntry({ ...signed(DETAIL), hash: "0".repeat(64) }, { [KEY_ID]: PEM })).toEqual({ ok: false, reason: "The entry's chain hash does not match." });
  });

  it("does not take a key whose id is not the one it is filed under", async () => {
    // A label is only a pointer: the key it points at must be the key the label names.
    expect(await verifyEntry(signed(DETAIL), { [KEY_ID]: OTHER_PEM })).toEqual({ ok: null, reason: "The key that signed this entry is not known here." });
  });

  it("says it could not check, not that it failed, when the signing key is not known", async () => {
    expect(await verifyEntry(signed(DETAIL), { other: OTHER_PEM })).toEqual({ ok: null, reason: "The key that signed this entry is not known here." });
  });
});

describe("recordsTransaction", () => {
  const row = signed({ invoiceId: "inv-1", execution: { mintTxHash: `0x${"AB".repeat(32)}` } });
  it("is true for the entry the receipt names, when its detail contains one of the transactions", () => {
    expect(recordsTransaction(row, row.hash, [`0x${"ab".repeat(32)}`])).toBe(true);
  });
  it("is false for another entry, or one that records neither transaction", () => {
    expect(recordsTransaction(row, "0".repeat(64), [`0x${"ab".repeat(32)}`])).toBe(false);
    expect(recordsTransaction(row, row.hash, [`0x${"cd".repeat(32)}`])).toBe(false);
  });
});

describe("canonical JSON", () => {
  it("is one implementation, shared by the ledger and the browser", () => {
    expect(canonicalJson).toBe(sharedCanonicalJson);
  });
});
