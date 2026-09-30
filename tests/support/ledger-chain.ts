import crypto from "node:crypto";
import { bodyHashOf, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";

export const GENESIS = "0".repeat(64);

/**
 * Rebuilds, in TypeScript, exactly what `append_ledger_entry()` does in
 * Postgres: sign the body, then link it as sha256(prev || body || sig).
 *
 * If the two ever drift, every test here keeps passing while the real ledger
 * stops verifying. `ledger-parity.test.ts` is what catches that: it runs the
 * real migrations on a real Postgres in this process and hands rows linked by
 * `append_ledger_entry()` itself to `verifyChain()`. This comment once claimed
 * such a file existed when it did not; it exists now, and it is the only test
 * that exercises the SQL side.
 */
export function buildChain(
  inputs: LedgerEntryInput[],
  privateKey: crypto.KeyObject,
  /**
   * The key label rows carry. `undefined` reproduces an entry written before
   * `signing_key_id` existed, which is what every row already in a real ledger
   * looks like.
   */
  signingKeyId?: string
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let prev = GENESIS;

  inputs.forEach((input, i) => {
    const bodyHash = bodyHashOf(input);
    const signature = crypto
      .sign(null, Buffer.from(bodyHash, "hex"), privateKey)
      .toString("hex");
    const hash = crypto
      .createHash("sha256")
      .update(prev + bodyHash + signature)
      .digest("hex");

    rows.push({
      seq: i + 1,
      id: crypto.randomUUID(),
      ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      actor: input.actor,
      domain: input.domain,
      action: input.action,
      summary: input.summary,
      detail: input.detail,
      body_hash: bodyHash,
      signature,
      prev_hash: prev,
      hash,
      signing_key_id: signingKeyId ?? null,
    });
    prev = hash;
  });

  return rows;
}

/** Appends further signed rows after an existing chain, as a rotation would. */
export function continueChain(
  existing: LedgerRow[],
  inputs: LedgerEntryInput[],
  privateKey: crypto.KeyObject,
  signingKeyId?: string
): LedgerRow[] {
  const head = existing[existing.length - 1];
  const rows = buildChain(inputs, privateKey, signingKeyId);
  let prev = head.hash;
  return rows.map((row, i) => {
    const hash = crypto.createHash("sha256").update(prev + row.body_hash + row.signature).digest("hex");
    const linked = { ...row, seq: head.seq + i + 1, prev_hash: prev, hash };
    prev = hash;
    return linked;
  });
}
