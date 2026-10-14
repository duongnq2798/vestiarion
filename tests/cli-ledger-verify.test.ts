import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { exportFromRows, ledgerExportJsonChunks } from "@/lib/ledger-export";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";
import { signWebhook } from "@/lib/webhooks/sign";
import { harness } from "./support/cli-harness";
import { buildChain, continueChain } from "./support/ledger-chain";

vi.mock("server-only", () => ({}));

/**
 * `vestiarion ledger verify` checks an audit export with the SDK's verifier, and must answer as the standalone
 * public/tools/verify-ledger-export.mjs does on the same file and keys: the same lines, word for word, and the same
 * verdict. Its exit code is the CLI's own: 0 for VALID (the script's 0), 2 for BROKEN or NOT CHECKED (the script's 1
 * and 2). The exports are built as tests/ledger-export-verifier.test.ts builds them.
 */

const SCRIPT = path.join(process.cwd(), "public", "tools", "verify-ledger-export.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "cli-ledger-verify-"));
const signer = crypto.generateKeyPairSync("ed25519");
const stranger = crypto.generateKeyPairSync("ed25519");
const keyA = crypto.generateKeyPairSync("ed25519");
const keyB = crypto.generateKeyPairSync("ed25519");
const ecKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = ledgerKeyId(signer.publicKey);
const ring: LedgerKeyring = { active: signer.publicKey, retired: [] };
const rotatedRing: LedgerKeyring = { active: keyB.publicKey, retired: [keyA.publicKey] };

const INPUTS: LedgerEntryInput[] = [
  { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY 240", detail: { amount: 240, nested: { b: 2, a: [1, { y: 1, x: 2 }] } } },
  { actor: "agent", domain: "ap", action: "ap_hold", summary: "HOLD 1200", detail: { amount: 1200.5 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "done — ünïcode ✓", detail: { decisionCount: 2, empty: {}, list: [] } },
];

const pem = (key: crypto.KeyObject) => key.export({ type: "spki", format: "pem" }).toString();
let n = 0;
function file(name: string, text: string): string {
  const target = path.join(dir, `${++n}-${name}`);
  writeFileSync(target, text);
  return target;
}

function exportOf(rows: LedgerRow[], keyring: LedgerKeyring = ring, mutate?: (doc: Record<string, unknown>) => void): string {
  const doc = exportFromRows({ rows, keyring, workspace: { slug: "northstar", name: "Northstar" }, now: new Date("2026-09-30T00:00:00Z") });
  const parsed = JSON.parse([...ledgerExportJsonChunks(doc)].join(""));
  mutate?.(parsed);
  return file("export.json", JSON.stringify(parsed));
}

const intact = () => buildChain(INPUTS, signer.privateKey, KEY_ID);
const rotated = () => {
  const before = buildChain(INPUTS.slice(0, 2), keyA.privateKey, ledgerKeyId(keyA.publicKey));
  return [...before, ...continueChain(before, INPUTS.slice(2), keyB.privateKey, ledgerKeyId(keyB.publicKey))];
};
const entries = (doc: Record<string, unknown>) => doc.entries as Array<Record<string, unknown>>;

/** Each case: the export (or any file) and the arguments after it. */
const CASES: Array<[string, () => { target: string; pins?: string[] }]> = [
  ["an intact export", () => ({ target: exportOf(intact()) })],
  ["entries from before key ids", () => ({ target: exportOf(buildChain(INPUTS, signer.privateKey)) })],
  ["an empty chain", () => ({ target: exportOf([]) })],
  ["a changed detail", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[1].detail = { amount: 12000.5 })) })],
  ["a changed summary", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[0].summary = "PAY 2400")) })],
  ["a swapped signature", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[1].signature = entries(d)[0].signature)) })],
  ["a signature that is too short", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[1].signature = "abcd")) })],
  ["a removed entry", () => ({ target: exportOf(intact(), ring, (d) => void entries(d).splice(1, 1)) })],
  ["reordered entries", () => ({ target: exportOf(intact(), ring, (d) => void entries(d).reverse()) })],
  ["a rewritten hash", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[2].hash = "f".repeat(64))) })],
  ["a rewritten prev_hash", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[1].prev_hash = "a".repeat(64))) })],
  ["a head that names another entry", () => ({ target: exportOf(intact(), ring, (d) => void ((d.head as { hash: string }).hash = "e".repeat(64))) })],
  ["a head with no entries", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d).length = 0)) })],
  ["a null entry", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[0] = null as never)) })],
  ["a deleted signature", () => ({ target: exportOf(intact(), ring, (d) => void delete entries(d)[1].signature) })],
  ["a signature that is not hex", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[1].signature = "zz")) })],
  ["a seq that is a string", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[0].seq = "1")) })],
  ["a missing detail", () => ({ target: exportOf(intact(), ring, (d) => void delete entries(d)[2].detail) })],
  ["a signing_key_id that is a number", () => ({ target: exportOf(intact(), ring, (d) => void (entries(d)[0].signing_key_id = 7)) })],
  ["an entry signed by a key the file does not hold", () => ({ target: exportOf(buildChain(INPUTS, signer.privateKey, "0123456789abcdef")) })],
  ["a file whose keys cannot be read", () => ({ target: exportOf(intact(), ring, (d) => void ((d.keys as Array<Record<string, unknown>>)[0].publicKeyPem = "not a key")) })],
  ["a file with no keys", () => ({ target: exportOf(intact(), ring, (d) => void (d.keys = [])) })],
  ["a forged file, self-consistent", () => ({ target: exportOf(buildChain(INPUTS, stranger.privateKey, ledgerKeyId(stranger.publicKey)), { active: stranger.publicKey, retired: [] }) })],
  [
    "a forged file, checked against the pinned key",
    () => ({ target: exportOf(buildChain(INPUTS, stranger.privateKey, ledgerKeyId(stranger.publicKey)), { active: stranger.publicKey, retired: [] }), pins: [file("signer.pem", pem(signer.publicKey))] }),
  ],
  ["the pinned key's own file", () => ({ target: exportOf(intact()), pins: [file("signer.pem", pem(signer.publicKey))] })],
  ["a rotation, each key pinned", () => ({ target: exportOf(rotated(), rotatedRing), pins: [file("a.pem", pem(keyA.publicKey)), file("b.pem", pem(keyB.publicKey))] })],
  ["a rotation, both keys in one file", () => ({ target: exportOf(rotated(), rotatedRing), pins: [file("both.pem", `${pem(keyA.publicKey)}\n${pem(keyB.publicKey)}`)] })],
  ["a rotation, only the newer key pinned", () => ({ target: exportOf(rotated(), rotatedRing), pins: [file("b.pem", pem(keyB.publicKey))] })],
  // A key of another type than Ed25519 cannot have signed an entry: its signature does not verify, and the others' do.
  ["entries from before key ids, a pinned key that is not Ed25519", () => ({ target: exportOf(buildChain(INPUTS, signer.privateKey)), pins: [file("ec.pem", pem(ecKey.publicKey))] })],
  [
    "entries from before key ids, a pinned file with another kind of key beside the right one",
    () => ({ target: exportOf(buildChain(INPUTS, signer.privateKey)), pins: [file("mixed.pem", `${pem(ecKey.publicKey)}\n${pem(signer.publicKey)}`)] }),
  ],
  [
    "entries naming a key the file holds that is not Ed25519",
    () => ({
      target: exportOf(intact(), ring, (d) => {
        d.keys = [{ keyId: ledgerKeyId(ecKey.publicKey), publicKeyPem: pem(ecKey.publicKey) }];
        for (const entry of entries(d)) entry.signing_key_id = ledgerKeyId(ecKey.publicKey);
      }),
    }),
  ],
  ["a private key pinned", () => ({ target: exportOf(intact()), pins: [file("private.pem", signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString())] })],
  ["a pinned file with no PEM block", () => ({ target: exportOf(intact()), pins: [file("empty.pem", "not a key\n")] })],
  ["a pinned file that does not exist", () => ({ target: exportOf(intact()), pins: [path.join(dir, "missing.pem")] })],
  ["a file that is not an export", () => ({ target: file("other.json", JSON.stringify({ hello: "world" })) })],
  ["a file that is not JSON", () => ({ target: file("broken.json", "{ nope") })],
  ["a file that does not exist", () => ({ target: path.join(dir, "missing.json") })],
];

const VERDICT_OF_SCRIPT: Record<number, string> = { 0: "valid", 1: "broken", 2: "not_checked" };

/** The script's exit codes over the cases above, as they ran. */
const scriptCodes = new Set<number | null>();

describe("vestiarion ledger verify, beside the standalone verifier", () => {
  it.each(CASES)(
    "answers as verify-ledger-export.mjs for %s",
    async (_name, make) => {
      const { target, pins = [] } = make();
      const pinArgs = pins.flatMap((pin) => ["--public-key", pin]);
      const script = spawnSync(process.execPath, [SCRIPT, target, ...pinArgs], { encoding: "utf8" });
      expect(script.stderr).toBe("");
      scriptCodes.add(script.status);

      const text = harness();
      const code = await text.run("ledger", "verify", target, ...pinArgs);
      expect(text.stdout).toBe(script.stdout);
      expect(text.stderr).toBe("");
      expect(code).toBe(script.status === 0 ? 0 : 2);

      const json = harness();
      await json.run("ledger", "verify", target, ...pinArgs, "--json");
      expect(JSON.parse(json.stdout)).toEqual({ verdict: VERDICT_OF_SCRIPT[script.status ?? -1], lines: script.stdout.trimEnd().split("\n") });
    },
    30_000
  );

  it("covers every verdict the script gives", () => {
    expect([...scriptCodes].sort()).toEqual([0, 1, 2]);
  });

  it("needs no key and sends nothing", async () => {
    const h = harness({ routes: {} });
    expect(await h.run("ledger", "verify", exportOf(intact()))).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("asks for the file it checks (exit 1)", async () => {
    const h = harness();
    expect(await h.run("ledger", "verify")).toBe(1);
    expect(h.stderr).toContain("takes <export.json>");
  });
});

describe("vestiarion webhooks verify", () => {
  const SECRET = `whsec_${"s".repeat(43)}`;
  const BODY = JSON.stringify({ id: "3fa1e2b0", type: "ledger.appended", createdAt: "2026-10-03T11:09:31Z", workspace: { slug: "testnet-2" }, entry: { seq: 1137 } });
  const now = () => Math.floor(Date.now() / 1000);
  const body = file("delivery.json", BODY);

  it("accepts a genuine delivery (exit 0) and never prints the secret", async () => {
    const h = harness();
    expect(await h.run("webhooks", "verify", "--secret", SECRET, "--signature", signWebhook(SECRET, BODY, now()), "--body", body)).toBe(0);
    expect(h.stdout).toMatch(/^VALID: ledger\.appended delivery 3fa1e2b0 for workspace testnet-2, signed at /);
    expect(h.stdout + h.stderr).not.toContain(SECRET);
    const json = harness({ env: { VESTIARION_WEBHOOK_SECRET: SECRET } });
    expect(await json.run("webhooks", "verify", "--signature", signWebhook(SECRET, BODY, now()), "--body", body, "--json")).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ valid: true, event: JSON.parse(BODY) });
  });

  it("reads the body from stdin with --body -", async () => {
    const h = harness({ stdin: BODY });
    expect(await h.run("webhooks", "verify", "--secret", SECRET, "--signature", signWebhook(SECRET, BODY, now()), "--body", "-")).toBe(0);
  });

  it.each([
    ["another secret", () => ["--secret", `whsec_${"x".repeat(43)}`, "--signature", signWebhook(SECRET, BODY, now()), "--body", body], "mismatch"],
    ["a changed body", () => ["--secret", SECRET, "--signature", signWebhook(SECRET, BODY, now()), "--body", file("changed.json", `${BODY}\n`)], "mismatch"],
    ["an old signature", () => ["--secret", SECRET, "--signature", signWebhook(SECRET, BODY, now() - 3600), "--body", body], "expired"],
    ["a malformed header", () => ["--secret", SECRET, "--signature", "garbage", "--body", body], "malformed"],
  ])("refuses %s (exit 2), naming the reason", async (_name, args, reason) => {
    const h = harness();
    expect(await h.run("webhooks", "verify", ...args())).toBe(2);
    expect(h.stdout).toContain(`INVALID (${reason})`);
    expect(h.stdout + h.stderr).not.toContain(SECRET);
  });

  it("accepts an old signature within a --tolerance given", async () => {
    const h = harness();
    expect(await h.run("webhooks", "verify", "--secret", SECRET, "--signature", signWebhook(SECRET, BODY, now() - 3600), "--body", body, "--tolerance", "7200")).toBe(0);
  });

  it("asks for the secret, the signature and the body (exit 1)", async () => {
    const noSecret = harness();
    expect(await noSecret.run("webhooks", "verify", "--signature", "t=1,v1=00", "--body", body)).toBe(1);
    expect(noSecret.stderr).toContain("VESTIARION_WEBHOOK_SECRET");
    const noBody = harness();
    expect(await noBody.run("webhooks", "verify", "--secret", SECRET, "--signature", "t=1,v1=00")).toBe(1);
    const missingFile = harness();
    expect(await missingFile.run("webhooks", "verify", "--secret", SECRET, "--signature", "t=1,v1=00", "--body", path.join(dir, "nope.json"))).toBe(1);
  });
});
