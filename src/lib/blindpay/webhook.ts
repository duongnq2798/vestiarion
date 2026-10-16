import crypto from "node:crypto";

/**
 * BlindPay's webhook signature (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B9), in Svix's format: the
 * headers `svix-id`, `svix-timestamp` and `svix-signature`; the signed string `<id>.<timestamp>.<raw body>`; HMAC-SHA256
 * under the base64 key after `whsec_`, in base64; the header a space-separated list of `v1,<signature>`. Checked in
 * constant time, within five minutes of the timestamp, before the body is read for anything.
 */

const TOLERANCE_MS = 5 * 60_000;

export type SignatureCheck = { ok: true; id: string } | { ok: false; reason: "missing" | "stale" | "bad_secret" | "mismatch" };

export function verifyBlindpaySignature(
  headers: { get(name: string): string | null },
  rawBody: string,
  secret: string,
  nowMs: number = Date.now()
): SignatureCheck {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "missing" };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > TOLERANCE_MS) return { ok: false, reason: "stale" };
  if (!secret.startsWith("whsec_")) return { ok: false, reason: "bad_secret" };
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest();
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature) continue;
    const given = Buffer.from(signature, "base64");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true, id };
  }
  return { ok: false, reason: "mismatch" };
}
