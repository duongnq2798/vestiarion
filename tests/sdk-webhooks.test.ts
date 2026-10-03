import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@/lib/canonical-json";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { verifyEntry, type PublicLedgerRow } from "@/lib/receipts/verify";
import { signWebhook, verifyWebhookSignature } from "@/lib/webhooks/sign";
import { canonicalJson as sdkCanonicalJson } from "../sdk/src/canonical-json";
import { verifyLedgerEntry, verifyWebhook, WebhookVerificationError, type WebhookLedgerEntry } from "../sdk/src/webhooks";

/**
 * Webhook signatures and ledger entries, checked by the SDK exactly as the server signs them (TypeScript SDK design
 * R7): HMAC deliveries against src/lib/webhooks/sign.ts, entries against src/lib/ledger.ts, agreeing with the receipt
 * page's own verifier.
 */

vi.mock("server-only", () => ({}));

const SECRET = `whsec_${"s".repeat(43)}`;
const T = 1_790_000_000;
const at = (seconds: number) => new Date(seconds * 1000);
const BODY = JSON.stringify({ id: "3fa1e2b0", type: "ledger.appended", createdAt: "2026-10-03T11:09:31Z", workspace: { slug: "testnet-2" }, entry: { seq: 1137 } });
const reasonOf = (promise: Promise<unknown>) => promise.then(() => "verified", (error: unknown) => (error instanceof WebhookVerificationError ? error.reason : `threw ${String(error)}`));

describe("verifyWebhook", () => {
  it("returns the event a genuine delivery carries", async () => {
    const event = await verifyWebhook({ secret: SECRET, payload: BODY, signature: signWebhook(SECRET, BODY, T), now: at(T) });
    expect(event).toEqual(JSON.parse(BODY));
  });

  it.each([
    ["a tampered body", () => ({ payload: BODY.replace("1137", "1138"), signature: signWebhook(SECRET, BODY, T) }), "mismatch"],
    ["another secret", () => ({ payload: BODY, signature: signWebhook(`whsec_${"x".repeat(43)}`, BODY, T) }), "mismatch"],
    ["no header", () => ({ payload: BODY, signature: null }), "missing"],
    ["no v1", () => ({ payload: BODY, signature: `t=${T}` }), "malformed"],
    ["a v1 that is not hex", () => ({ payload: BODY, signature: `t=${T},v1=zz` }), "malformed"],
    ["two timestamps", () => ({ payload: BODY, signature: `${signWebhook(SECRET, BODY, T)},t=${T}` }), "malformed"],
    ["garbage", () => ({ payload: BODY, signature: "garbage" }), "malformed"],
  ])("refuses %s", async (_label, make, reason) => {
    expect(await reasonOf(verifyWebhook({ secret: SECRET, now: at(T), ...make() }))).toBe(reason);
  });

  it("accepts a signature exactly 300 s away and refuses one 301 s away, as the server does (Review focus 5)", async () => {
    const signature = signWebhook(SECRET, BODY, T);
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T + 300) }))).toBe("verified");
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T + 301) }))).toBe("expired");
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T - 301) }))).toBe("expired");
  });

  it.each([
    ["a tolerance that is not a number", { toleranceSeconds: Number.NaN }],
    ["a negative tolerance", { toleranceSeconds: -1 }],
    ["a now that is not a date", { now: new Date("not a date") }],
  ])("refuses %s rather than accept a delivery signed a day ago", async (_label, over) => {
    const dayOld = signWebhook(SECRET, BODY, T - 86_400);
    await expect(verifyWebhook({ secret: SECRET, payload: BODY, signature: dayOld, now: at(T), ...over })).rejects.toThrow(TypeError);
  });

  it("accepts any one of several v1 values, and ignores other schemes", async () => {
    const genuine = signWebhook(SECRET, BODY, T).split(",")[1];
    const signature = `t=${T},v0=abc,v1=${"0".repeat(64)},${genuine}`;
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T) }))).toBe("verified");
  });

  it("refuses a parsed object handed in as the payload, asking for the raw body (Review focus 4)", async () => {
    const parsed = JSON.parse(BODY) as unknown as string;
    const error = await verifyWebhook({ secret: SECRET, payload: parsed, signature: signWebhook(SECRET, BODY, T), now: at(T) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ reason: "malformed", message: expect.stringMatching(/raw request body/) });
  });

  it("refuses a genuinely signed body that is not JSON", async () => {
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: "not json", signature: signWebhook(SECRET, "not json", T), now: at(T) }))).toBe("malformed");
  });

  it.each([
    signWebhook(SECRET, BODY, T),
    signWebhook(SECRET, BODY, T - 400),
    `t=${T},v1=${"0".repeat(64)}`,
    `t=${T}`,
    "t=,v1=",
    `v1=${"0".repeat(64)},t=${T}`,
  ])("agrees with the server's own check on %s", async (signature) => {
    const server = verifyWebhookSignature(SECRET, BODY, signature, T);
    expect((await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T) }))) === "verified").toBe(server);
  });
});

/** An entry signed exactly as src/lib/ledger.ts signs one, and the chain hash the database links it with. */
function signedEntry(detail: Record<string, unknown> = { invoiceId: "1f96fd0b", amount: 0.1, nested: { b: 1, a: [true, null, "x"] } }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const body = { actor: "agent" as const, domain: "ap" as const, action: "ap_pay", summary: "PAY invoice from API Test Vendor for 0.1 USDC", detail };
  const bodyHash = bodyHashOf(body);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const prevHash = "0".repeat(64);
  const hash = crypto.createHash("sha256").update(prevHash + bodyHash + signature).digest("hex");
  const entry: WebhookLedgerEntry = { seq: 1137, ts: "2026-10-03T11:09:31Z", ...body, bodyHash, prevHash, hash, signature, signingKeyId: ledgerKeyId(privateKey) };
  return { entry, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const asRow = (entry: WebhookLedgerEntry): PublicLedgerRow => ({
  seq: entry.seq, actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail as Record<string, unknown>,
  body_hash: entry.bodyHash, signature: entry.signature, prev_hash: entry.prevHash, hash: entry.hash, signing_key_id: entry.signingKeyId,
});

describe("verifyLedgerEntry", () => {
  it("writes canonical JSON exactly as the ledger does", () => {
    for (const value of [{ b: 1, a: [true, null, { d: "é", c: 0.1 }] }, [], "x", null, 12.5, { u: undefined, k: 1 }]) {
      expect(sdkCanonicalJson(value)).toBe(canonicalJson(value));
    }
  });

  it("verifies an entry signed as the ledger signs, with its PEM or with a map of key id to PEM", async () => {
    const { entry, pem } = signedEntry();
    expect(await verifyLedgerEntry(entry, pem)).toEqual({ ok: true });
    expect(await verifyLedgerEntry(entry, { [entry.signingKeyId as string]: pem })).toEqual({ ok: true });
  });

  it("checks an entry with no key id against every genuine key given", async () => {
    const { entry, pem } = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, signingKeyId: null }, pem)).toEqual({ ok: true });
  });

  it("refuses a tampered detail and a broken chain hash, and has no verdict without the signing key", async () => {
    const { entry, pem } = signedEntry();
    const other = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, detail: { ...entry.detail, amount: 1000 } }, pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/body hash/) });
    expect(await verifyLedgerEntry({ ...entry, hash: "f".repeat(64) }, pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain hash/) });
    expect(await verifyLedgerEntry(entry, other.pem)).toMatchObject({ ok: null });
    // A key filed under an id that is not its own is not used.
    expect(await verifyLedgerEntry(entry, { [entry.signingKeyId as string]: other.pem })).toMatchObject({ ok: null });
  });

  it("refuses a signature by another key when the entry names no key", async () => {
    const { entry } = signedEntry();
    const other = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, signingKeyId: null }, other.pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it("agrees with the receipt page's verifier on every case", async () => {
    const { entry, pem } = signedEntry();
    const other = signedEntry();
    const cases: Array<[WebhookLedgerEntry, Record<string, string>]> = [
      [entry, { [entry.signingKeyId as string]: pem }],
      [{ ...entry, detail: { tampered: true } }, { [entry.signingKeyId as string]: pem }],
      [{ ...entry, hash: "f".repeat(64) }, { [entry.signingKeyId as string]: pem }],
      [entry, { [other.entry.signingKeyId as string]: other.pem }],
      [{ ...entry, signingKeyId: null }, { [other.entry.signingKeyId as string]: other.pem }],
    ];
    for (const [checked, keys] of cases) {
      expect(await verifyLedgerEntry(checked, keys)).toEqual(await verifyEntry(asRow(checked), keys));
    }
  });
});
