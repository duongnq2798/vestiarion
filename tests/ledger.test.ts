import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyHashOf,
  canonicalJson,
  verifyChain,
  type LedgerEntryInput,
  type LedgerRow,
} from "@/lib/ledger";

const GENESIS = "0".repeat(64);

/**
 * Rebuilds, in TypeScript, exactly what `append_ledger_entry()` does in
 * Postgres: sign the body, then link it as sha256(prev || body || sig).
 * If the two ever drift, these tests keep passing while the real ledger
 * stops verifying — so `chain-parity.test.ts` pins the SQL side separately.
 */
function buildChain(
  inputs: LedgerEntryInput[],
  privateKey: crypto.KeyObject
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
    });
    prev = hash;
  });

  return rows;
}

const SAMPLE: LedgerEntryInput[] = [
  {
    actor: "agent",
    domain: "compliance",
    action: "screen_counterparty",
    summary: "Screened Zenith Trading LLC: high risk",
    detail: { riskLevel: "high", newPaymentLimit: 0 },
  },
  {
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: "PAY invoice from Vercel Inc for 2 USDC",
    detail: { amount: 2, decision: { action: "pay", confidence: 0.85 } },
  },
  {
    actor: "system",
    domain: "system",
    action: "cycle_complete",
    summary: "Agent cycle 1 complete: 2 decisions logged",
    detail: { day: 1, decisionCount: 2 },
  },
];

function keypair() {
  return crypto.generateKeyPairSync("ed25519");
}

describe("canonicalJson", () => {
  it("is insensitive to key insertion order at every depth", () => {
    const a = { z: 1, nested: { b: 2, a: [3, { y: 4, x: 5 }] } };
    const b = { nested: { a: [3, { x: 5, y: 4 }], b: 2 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined values rather than emitting invalid JSON", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("distinguishes null from the string \"null\"", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({ a: "null" }));
  });

  it("does not collide across differently-shaped details", () => {
    // The classic hash-chain failure: {a:"1,b:2"} and {a:1,b:2} flattening
    // to the same string. JSON.stringify on each value prevents it.
    expect(canonicalJson({ a: "1", b: "2" })).not.toBe(canonicalJson({ a: 1, b: 2 }));
  });
});

describe("bodyHashOf", () => {
  it("ignores property order in the entry and its detail", () => {
    const one = bodyHashOf({
      actor: "agent",
      domain: "ap",
      action: "ap_pay",
      summary: "s",
      detail: { b: 1, a: 2 },
    });
    const two = bodyHashOf({
      detail: { a: 2, b: 1 },
      summary: "s",
      action: "ap_pay",
      domain: "ap",
      actor: "agent",
    } as LedgerEntryInput);
    expect(one).toBe(two);
  });

  it("changes when any covered field changes", () => {
    const base: LedgerEntryInput = {
      actor: "agent",
      domain: "ap",
      action: "ap_pay",
      summary: "PAY 100 USDC",
      detail: { amount: 100 },
    };
    const hash = bodyHashOf(base);
    expect(bodyHashOf({ ...base, summary: "PAY 1000 USDC" })).not.toBe(hash);
    expect(bodyHashOf({ ...base, detail: { amount: 1000 } })).not.toBe(hash);
    expect(bodyHashOf({ ...base, actor: "human" })).not.toBe(hash);
  });
});

describe("verifyChain", () => {
  it("accepts an empty ledger", () => {
    const { publicKey } = keypair();
    expect(verifyChain([], publicKey)).toEqual({ valid: true, checkedEntries: 0 });
  });

  it("accepts a well-formed chain", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    expect(verifyChain(rows, publicKey)).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("detects a rewritten amount even when every hash is recomputed downstream", () => {
    // The attack a plain append-only table does not survive: an operator with
    // write access edits a payment and re-links the chain behind it. The
    // signature is what stops it, so this must fail on the signature, not on
    // a hash mismatch.
    const { publicKey } = keypair();
    const { privateKey: forgedKey } = keypair();
    const tampered = [...SAMPLE];
    tampered[1] = { ...tampered[1], detail: { amount: 20000 } };
    const rows = buildChain(tampered, forgedKey);

    const result = verifyChain(rows, publicKey);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/signature/);
  });

  it("detects content edited in place without rehashing", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[1].summary = "PAY invoice from Vercel Inc for 20000 USDC";

    const result = verifyChain(rows, publicKey);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/body hash/);
  });

  it("detects a deleted entry", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    const withGap = [rows[0], rows[2]];

    const result = verifyChain(withGap, publicKey);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/prev_hash/);
  });

  it("detects reordered entries", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    const swapped = [rows[1], rows[0], rows[2]];

    expect(verifyChain(swapped, publicKey).valid).toBe(false);
  });

  it("detects a chain that does not start at genesis", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[0].prev_hash = "f".repeat(64);

    const result = verifyChain(rows, publicKey);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("detects a forged link hash that keeps prev_hash consistent", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE.slice(0, 1), privateKey);
    rows[0].hash = "a".repeat(64);

    const result = verifyChain(rows, publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/chain hash/);
  });

  it("rejects a chain signed by a different key", () => {
    const { privateKey } = keypair();
    const { publicKey: otherPublic } = keypair();
    const rows = buildChain(SAMPLE, privateKey);

    const result = verifyChain(rows, otherPublic);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/);
  });

  it("reports the total height even when it breaks on the first entry", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[0].prev_hash = "f".repeat(64);
    expect(verifyChain(rows, publicKey).checkedEntries).toBe(3);
  });
});
