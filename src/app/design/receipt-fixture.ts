import crypto from "node:crypto";
import { bodyHashOf, type LedgerEntryInput } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import type { ReceiptView } from "@/lib/platform/receipts";
import type { PublicLedgerRow } from "@/lib/receipts/verify";

/**
 * A shared receipt for /design (payment receipts P5), signed for real with a key made for the page, so the
 * browser's own check passes as it would on a real receipt. Made-up payment; nothing is read or saved.
 */
export function designReceipt(): ReceiptView {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = ledgerKeyId(publicKey);
  const sign = (seq: number, input: LedgerEntryInput, prev: string): PublicLedgerRow => {
    const bodyHash = bodyHashOf(input);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
    const hash = crypto.createHash("sha256").update(prev + bodyHash + signature).digest("hex");
    return { seq, ...input, body_hash: bodyHash, signature, prev_hash: prev, hash, signing_key_id: keyId };
  };
  const facts = {
    amount: 2,
    token: "USDC" as const,
    paidAt: "2026-10-01T08:28:26.857Z",
    payee: "0x221b5bD2f0B8E4a8C7a1E5B3c9D0e6F7a8B91bc3",
    chain: "ARB-SEPOLIA",
    txHash: "0x207f716e0e3200304c0b86047d7e8a01384aa336733436e9b796e25d820997a9",
    route: "gateway" as const,
    feeUsdc: 0.107811,
  };
  const entry = sign(
    612,
    { actor: "human", domain: "ap", action: "receipt_shared", summary: "Receipt: 2 USDC paid on Arbitrum Sepolia", detail: { receipt: facts, records: { seq: 580, hash: "9".repeat(64) } } },
    "8".repeat(64)
  );
  return {
    facts,
    entry,
    publicKeys: { [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString() },
    records: { seq: 580, signingKeyId: keyId },
    checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "matches", block: 314579095 } },
  };
}
