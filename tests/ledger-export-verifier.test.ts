// tests/ledger-export-verifier.test.ts
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { exportFromRows, ledgerExportJsonChunks } from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";

/**
 * `public/tools/verify-ledger-export.mjs` is a second implementation of the
 * chain rules on purpose (audit-export E1): someone who does not trust the app
 * cannot be asked to trust a verifier inside it. This test keeps the two in
 * step: for each case the script's exit code must match `verifyChain`'s
 * verdict on the same rows (0 ↔ true, 1 ↔ false, 2 ↔ null).
 */

const SCRIPT = path.join(process.cwd(), "public", "tools", "verify-ledger-export.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "ledger-export-"));
const signer = crypto.generateKeyPairSync("ed25519");
const stranger = crypto.generateKeyPairSync("ed25519");
const KEY_ID = ledgerKeyId(signer.publicKey);
const ring: LedgerKeyring = { active: signer.publicKey, retired: [] };

const INPUTS: LedgerEntryInput[] = [
  { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY 240", detail: { amount: 240, nested: { b: 2, a: [1, { y: 1, x: 2 }] } } },
  { actor: "agent", domain: "ap", action: "ap_hold", summary: "HOLD 1200", detail: { amount: 1200.5 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "done — ünïcode ✓", detail: { decisionCount: 2, empty: {}, list: [] } },
];

let n = 0;
function run(rows: LedgerRow[], extra: string[] = [], keyring: LedgerKeyring = ring, mutate?: (doc: Record<string, unknown>) => void) {
  const doc = exportFromRows({ rows, keyring, workspace: { slug: "northstar", name: "Northstar" }, now: new Date("2026-09-30T00:00:00Z") });
  const parsed = JSON.parse([...ledgerExportJsonChunks(doc)].join(""));
  mutate?.(parsed);
  const file = path.join(dir, `export-${++n}.json`);
  writeFileSync(file, JSON.stringify(parsed));
  const result = spawnSync(process.execPath, [SCRIPT, file, ...extra], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, first: result.stdout.split("\n")[0] };
}

const expected = (rows: LedgerRow[], keyring: LedgerKeyring = ring) => {
  const verdict = verifyChain(rows, keyring).valid;
  return verdict === true ? 0 : verdict === false ? 1 : 2;
};

const intact = () => buildChain(INPUTS, signer.privateKey, KEY_ID);

describe("verify-ledger-export.mjs", () => {
  it("answers VALID for an intact export, naming the key id and head hash to compare", () => {
    const rows = intact();
    const result = run(rows);
    expect(result.code).toBe(0);
    expect(result.code).toBe(expected(rows));
    expect(result.first).toMatch(/^VALID/);
    expect(result.out).toContain(KEY_ID);
    expect(result.out).toContain(rows[2].hash);
    expect(result.out).toMatch(/Audit page/);
  });

  it("verifies unlabelled entries written before key ids existed", () => {
    const rows = buildChain(INPUTS, signer.privateKey);
    expect(run(rows).code).toBe(expected(rows));
  });

  it.each([
    ["detail changed", (rows: LedgerRow[]) => { rows[1] = { ...rows[1], detail: { amount: 12000.5 } }; }],
    ["summary changed", (rows: LedgerRow[]) => { rows[0] = { ...rows[0], summary: "PAY 2400" }; }],
    ["signature swapped", (rows: LedgerRow[]) => { rows[1] = { ...rows[1], signature: rows[0].signature }; }],
    ["entry removed", (rows: LedgerRow[]) => { rows.splice(1, 1); }],
    ["entries reordered", (rows: LedgerRow[]) => { [rows[0], rows[1]] = [rows[1], rows[0]]; }],
    ["hash rewritten", (rows: LedgerRow[]) => { rows[2] = { ...rows[2], hash: "f".repeat(64) }; }],
  ])("answers BROKEN (exit 1) when the %s, as verifyChain does", (_name, tamper) => {
    const rows = intact();
    tamper(rows);
    const result = run(rows);
    expect(expected(rows)).toBe(1);
    expect(result.code).toBe(1);
    expect(result.first).toMatch(/^BROKEN/);
    const brokenAt = verifyChain(rows, ring).brokenAt;
    expect(result.out).toContain(`#${brokenAt}`);
  });

  it("answers NOT CHECKED (exit 2) for an entry signed by a key the file does not hold, as verifyChain does", () => {
    const rows = buildChain(INPUTS, signer.privateKey, "0123456789abcdef");
    const result = run(rows);
    expect(expected(rows)).toBe(2);
    expect(result.code).toBe(2);
    expect(result.first).toMatch(/^NOT CHECKED/);
  });

  it("with --public-key, rejects a file whose signatures and keys were both replaced", () => {
    // A forger re-signs a rewritten chain with their own key and puts that key in the file.
    const forged = buildChain(INPUTS, stranger.privateKey, ledgerKeyId(stranger.publicKey));
    const forgedRing: LedgerKeyring = { active: stranger.publicKey, retired: [] };
    expect(run(forged, [], forgedRing).code).toBe(0); // self-consistent: why the key id must be compared
    const pinned = path.join(dir, "signer.pem");
    writeFileSync(pinned, signer.publicKey.export({ type: "spki", format: "pem" }).toString());
    const result = run(forged, ["--public-key", pinned], forgedRing);
    expect(result.code).toBe(2);
    expect(result.first).toMatch(/^NOT CHECKED/);
  });

  it("with --public-key, accepts the file its key signed", () => {
    const pinned = path.join(dir, "signer-ok.pem");
    writeFileSync(pinned, signer.publicKey.export({ type: "spki", format: "pem" }).toString());
    expect(run(intact(), ["--public-key", pinned]).code).toBe(0);
  });

  it("answers BROKEN when the file's head does not name its last entry", () => {
    const result = run(intact(), [], ring, (doc) => {
      (doc.head as { hash: string }).hash = "e".repeat(64);
    });
    expect(result.code).toBe(1);
  });

  it("answers NOT CHECKED (exit 2) for a file that is not an export", () => {
    const file = path.join(dir, "not-an-export.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }));
    const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  it("verifies an empty chain as VALID with nothing to compare but the key", () => {
    expect(run([]).code).toBe(0);
  });
});
