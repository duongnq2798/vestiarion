import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyHashOf,
  canonicalJson,
  verifyChain,
  type LedgerEntryInput,
  type LedgerRow,
} from "@/lib/ledger";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";

const GENESIS = "0".repeat(64);

/** A keyring holding one current key and whatever retired ones are given. */
function ring(active: crypto.KeyObject | null, ...retired: crypto.KeyObject[]): LedgerKeyring {
  return { active, retired };
}

/**
 * Rebuilds, in TypeScript, exactly what `append_ledger_entry()` does in
 * Postgres: sign the body, then link it as sha256(prev || body || sig).
 *
 * KNOWN GAP. If the two ever drift, every test here keeps passing while the
 * real ledger stops verifying. This comment used to claim a `chain-parity.test.ts`
 * pinned the SQL side; no such file has ever existed, so nothing pins it. The
 * risk is live: migration 0014 changed that function. Closing this needs a real
 * Postgres in the suite — the linking is done by the database, so nothing short
 * of running it proves the two agree.
 */
function buildChain(
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
function continueChain(
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
    expect(verifyChain([], ring(publicKey))).toEqual({ valid: true, checkedEntries: 0 });
  });

  it("accepts a well-formed chain", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    expect(verifyChain(rows, ring(publicKey))).toEqual({ valid: true, checkedEntries: 3 });
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

    const result = verifyChain(rows, ring(publicKey));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/signature/);
  });

  it("detects content edited in place without rehashing", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[1].summary = "PAY invoice from Vercel Inc for 20000 USDC";

    const result = verifyChain(rows, ring(publicKey));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/body hash/);
  });

  it("detects a deleted entry", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    const withGap = [rows[0], rows[2]];

    const result = verifyChain(withGap, ring(publicKey));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/prev_hash/);
  });

  it("detects reordered entries", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    const swapped = [rows[1], rows[0], rows[2]];

    expect(verifyChain(swapped, ring(publicKey)).valid).toBe(false);
  });

  it("detects a chain that does not start at genesis", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[0].prev_hash = "f".repeat(64);

    const result = verifyChain(rows, ring(publicKey));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("detects a forged link hash that keeps prev_hash consistent", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE.slice(0, 1), privateKey);
    rows[0].hash = "a".repeat(64);

    const result = verifyChain(rows, ring(publicKey));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/chain hash/);
  });

  it("rejects a chain signed by a different key", () => {
    const { privateKey } = keypair();
    const { publicKey: otherPublic } = keypair();
    const rows = buildChain(SAMPLE, privateKey);

    const result = verifyChain(rows, ring(otherPublic));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/);
  });

  it("reports an unchecked chain, not a broken one, when no public key is configured", () => {
    // The contrast with the test above is the whole point. A chain signed by a
    // different key is evidence of a problem; a deployment that declares no key
    // has produced no evidence at all. Collapsing the second into `valid: false`
    // makes a missing env var read as a tampered audit trail — the worst false
    // alarm this system can raise.
    const { privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);

    const result = verifyChain(rows, ring(null));
    expect(result.valid).toBeNull();
    expect(result.brokenAt).toBeUndefined();
    expect(result.checkedEntries).toBe(3);
  });

  it("names both keys when an entry was signed by a different one", () => {
    // Without the label this is the most confusing failure the system can
    // produce: "signature does not verify" on an intact chain, because the
    // deployment was handed the wrong key. Saying which key signed and which
    // key is checking turns a suspected forgery into a configuration error.
    const signed = keypair();
    const verifying = keypair();
    const rows = buildChain(SAMPLE, signed.privateKey, ledgerKeyId(signed.publicKey));

    const result = verifyChain(rows, ring(verifying.publicKey));

    // `null`, not `false`, for the same reason a missing key is not a finding:
    // holding the wrong key produces no evidence about this chain either way.
    // Saying `false` here would accuse the ledger of forgery over a deployment
    // that was handed the wrong environment variable.
    expect(result.valid).toBeNull();
    expect(result.brokenAt).toBeUndefined();
    expect(result.reason).toContain(ledgerKeyId(signed.publicKey));
    expect(result.reason).toContain(ledgerKeyId(verifying.publicKey));
    expect(result.reason).not.toMatch(/signature does not verify/);
  });

  it("verifies an unlabelled entry against the configured key, as before", () => {
    // Every row written before this column existed is unlabelled. They must go
    // on verifying exactly as they did, or the migration breaks the history it
    // was added to protect.
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);

    expect(verifyChain(rows, ring(publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("accepts an entry labelled with the key that is checking it", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey, ledgerKeyId(publicKey));

    expect(verifyChain(rows, ring(publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("accepts entries labelled with a retired key that is still in the keyring", () => {
    // Rotation, from the verifier's side: the old key stops signing but stays
    // known, so everything it signed remains checkable. Without this, rotating
    // a key turns the whole history into an apparent forgery.
    const old = keypair();
    const current = keypair();
    const rows = buildChain(SAMPLE, old.privateKey, ledgerKeyId(old.publicKey));

    expect(verifyChain(rows, ring(current.publicKey, old.publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("accepts unlabelled entries signed by a retired key", () => {
    // Every row written before key identity existed is unlabelled, and after a
    // rotation those rows were signed by a key that is now retired. They must
    // still verify, or the first rotation breaks the entire pre-migration
    // history.
    const old = keypair();
    const current = keypair();
    const rows = buildChain(SAMPLE, old.privateKey);

    expect(verifyChain(rows, ring(current.publicKey, old.publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("verifies a chain that crosses a rotation", () => {
    const old = keypair();
    const current = keypair();
    const before = buildChain(SAMPLE.slice(0, 2), old.privateKey, ledgerKeyId(old.publicKey));
    const after = continueChain(before, SAMPLE.slice(2), current.privateKey, ledgerKeyId(current.publicKey));

    expect(verifyChain([...before, ...after], ring(current.publicKey, old.publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("names the unknown key and the known ones when a label matches nothing in the keyring", () => {
    const unknown = keypair();
    const current = keypair();
    const rows = buildChain(SAMPLE, unknown.privateKey, ledgerKeyId(unknown.publicKey));

    const result = verifyChain(rows, ring(current.publicKey));

    expect(result.valid).toBeNull();
    expect(result.reason).toContain(ledgerKeyId(unknown.publicKey));
    expect(result.reason).toContain(ledgerKeyId(current.publicKey));
    expect(result.reason).toMatch(/keyring/);
  });

  it("reports the total height even when it breaks on the first entry", () => {
    const { publicKey, privateKey } = keypair();
    const rows = buildChain(SAMPLE, privateKey);
    rows[0].prev_hash = "f".repeat(64);
    expect(verifyChain(rows, ring(publicKey)).checkedEntries).toBe(3);
  });
});
