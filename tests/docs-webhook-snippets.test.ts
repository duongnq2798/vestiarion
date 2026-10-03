import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSource } from "@/lib/docs/content";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { signWebhook } from "@/lib/webhooks/sign";

/**
 * The two verification snippets on /docs/webhooks/verify, run as a reader
 * would run them, against the repository's own signing code. The page says
 * they were; this keeps it true when the page or the signing code changes.
 */

const SNIPPETS = [...readSource("webhooks/verify").matchAll(/^```js\n([\s\S]*?)^```$/gm)].map((match) => match[1]);

/** Runs a snippet as CommonJS with only `node:crypto` to require, and returns the function it defines. */
function load<T>(source: string, name: string): T {
  const require = (id: string) => {
    if (id !== "node:crypto") throw new Error(`the snippet requires ${id}`);
    return crypto;
  };
  return new Function("require", `${source}\nreturn ${name};`)(require) as T;
}

describe("the webhook verification snippets", () => {
  it("are the page's two JavaScript blocks", () => {
    expect(SNIPPETS).toHaveLength(2);
  });

  it("verify a genuine delivery signature, and reject a tampered body and a stale timestamp", () => {
    const verify = load<(secret: string, rawBody: string, header: string, toleranceS?: number) => boolean>(SNIPPETS[0], "verifyVestiarionSignature");
    const secret = "whsec_" + crypto.randomBytes(32).toString("base64url");
    const body = JSON.stringify({ id: "3fa1e2b0", type: "ledger.appended", workspace: { slug: "acme" }, entry: { seq: 82, summary: "café ✓" } });
    const now = Math.floor(Date.now() / 1000);

    expect(verify(secret, body, signWebhook(secret, body, now))).toBe(true);
    expect(verify(secret, body.replace("82", "83"), signWebhook(secret, body, now))).toBe(false);
    expect(verify(secret, body, signWebhook(secret, body, now - 301))).toBe(false);
    expect(verify("whsec_other", body, signWebhook(secret, body, now))).toBe(false);
  });

  it("verify a ledger entry signed as the ledger signs it, and reject a tampered detail and the wrong key", () => {
    const verify = load<(entry: { bodyHash: string; signature: string }, publicKeyPem: string) => boolean>(SNIPPETS[1], "verifyLedgerEntrySignature");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const other = crypto.generateKeyPairSync("ed25519").publicKey;
    const input = { actor: "agent", domain: "treasury", action: "sweep_to_usyc", summary: "Treasury: sweep_to_usyc 60.71 USDC", detail: { decision: { action: "sweep_to_usyc", amount: 60.71 }, executed: true } } as Parameters<typeof bodyHashOf>[0];
    const bodyHash = bodyHashOf(input);
    const entry = {
      ...input,
      bodyHash,
      signature: crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex"),
      signingKeyId: ledgerKeyId(publicKey),
    };
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(verify(entry, pem)).toBe(true);
    const tampered = { ...entry, detail: { amount: 1 } };
    expect(verify({ ...tampered, bodyHash: bodyHashOf(tampered) }, pem)).toBe(false);
    expect(verify(entry, other.export({ type: "spki", format: "pem" }).toString())).toBe(false);
  });
});
