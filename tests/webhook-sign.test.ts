import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  generateWebhookSecret, SIGNATURE_TOLERANCE_S, signWebhook, verifyWebhookSignature,
} from "@/lib/webhooks/sign";

/**
 * Webhook signing (webhooks design W4): `Vestiarion-Signature` is
 * `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, and a
 * receiver rejects a timestamp more than 5 minutes away from its clock.
 */

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64url");
const BODY = JSON.stringify({ id: "3f1c", type: "ledger.appended", entry: { seq: 257, summary: "café ✓" } });
const T = 1_790_000_000;

describe("generateWebhookSecret", () => {
  it("is whsec_ followed by 32 random bytes in base64url", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7));
    let asked = 0;
    const secret = generateWebhookSecret((n) => {
      asked = n;
      return bytes;
    });
    expect(asked).toBe(32);
    expect(secret).toBe("whsec_" + bytes.toString("base64url"));
  });

  it("draws fresh randomness by default", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice("whsec_".length), "base64url")).toHaveLength(32);
  });
});

describe("signWebhook", () => {
  it("matches HMAC-SHA256 over '<t>.<raw body>', keyed with the whole secret", () => {
    const expected = crypto.createHmac("sha256", SECRET).update(`${T}.${BODY}`, "utf8").digest("hex");
    expect(signWebhook(SECRET, BODY, T)).toBe(`t=${T},v1=${expected}`);
  });

  it("changes with the body, the timestamp and the secret", () => {
    const base = signWebhook(SECRET, BODY, T);
    expect(signWebhook(SECRET, BODY + " ", T)).not.toBe(base);
    expect(signWebhook(SECRET, BODY, T + 1)).not.toBe(base);
    expect(signWebhook(SECRET + "x", BODY, T)).not.toBe(base);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a timestamp of %s", (t) => {
    expect(() => signWebhook(SECRET, BODY, t)).toThrow(/timestamp/);
  });
});

describe("verifyWebhookSignature", () => {
  const header = signWebhook(SECRET, BODY, T);

  it("accepts its own signature, and the tolerance is 5 minutes", () => {
    expect(SIGNATURE_TOLERANCE_S).toBe(300);
    expect(verifyWebhookSignature(SECRET, BODY, header, T)).toBe(true);
  });

  it("accepts a timestamp exactly at the tolerance, in either direction", () => {
    expect(verifyWebhookSignature(SECRET, BODY, header, T + 300)).toBe(true);
    expect(verifyWebhookSignature(SECRET, BODY, header, T - 300)).toBe(true);
  });

  it("refuses a timestamp beyond the tolerance, in either direction", () => {
    expect(verifyWebhookSignature(SECRET, BODY, header, T + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, header, T - 301)).toBe(false);
  });

  it("honours a custom tolerance", () => {
    expect(verifyWebhookSignature(SECRET, BODY, header, T + 30, 10)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, header, T + 10, 10)).toBe(true);
  });

  it("refuses a wrong secret", () => {
    expect(verifyWebhookSignature(generateWebhookSecret(), BODY, header, T)).toBe(false);
  });

  it("refuses a changed body", () => {
    expect(verifyWebhookSignature(SECRET, BODY.replace("257", "258"), header, T)).toBe(false);
  });

  it("refuses a timestamp moved without re-signing", () => {
    const moved = header.replace(`t=${T}`, `t=${T + 60}`);
    expect(verifyWebhookSignature(SECRET, BODY, moved, T + 60)).toBe(false);
  });

  const v1 = header.split("v1=")[1];
  it.each([
    ["empty", ""],
    ["without a timestamp", `v1=${v1}`],
    ["without a signature", `t=${T}`],
    ["with a non-numeric timestamp", `t=abc,v1=${v1}`],
    ["with a fractional timestamp", `t=${T}.5,v1=${v1}`],
    ["with two timestamps", `t=${T},t=${T},v1=${v1}`],
    ["with a short signature", `t=${T},v1=${v1.slice(2)}`],
    ["with a non-hex signature", `t=${T},v1=${"z".repeat(64)}`],
    ["with upper-case hex", `t=${T},v1=${v1.toUpperCase()}`],
    ["with a part that has no '='", `t=${T},v1=${v1},junk`],
    ["with spaces", `t=${T}, v1=${v1}`],
  ])("refuses a header %s", (_label, value) => {
    expect(verifyWebhookSignature(SECRET, BODY, value, T)).toBe(false);
  });

  it("accepts the header when one of several v1 values matches, and ignores other schemes", () => {
    const other = "0".repeat(64);
    expect(verifyWebhookSignature(SECRET, BODY, `t=${T},v1=${other},v1=${v1},v0=abc`, T)).toBe(true);
  });

  it("never throws on input that is not a string", () => {
    const anyVerify = verifyWebhookSignature as (...args: unknown[]) => boolean;
    expect(anyVerify(SECRET, BODY, undefined, T)).toBe(false);
    expect(anyVerify(undefined, BODY, header, T)).toBe(false);
    expect(anyVerify(SECRET, null, header, T)).toBe(false);
    expect(anyVerify(SECRET, BODY, header, Number.NaN)).toBe(false);
  });

  it("compares the signature in constant time", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    try {
      expect(verifyWebhookSignature(SECRET, BODY, header, T)).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
