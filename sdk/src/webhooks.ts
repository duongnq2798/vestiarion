import { canonicalJson } from "./canonical-json.js";
import type { LedgerEntry } from "./types.js";

/**
 * Checking what Vestiarion sends (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R7), with Web Crypto
 * alone:
 * - a webhook delivery's `Vestiarion-Signature`, as src/lib/webhooks/sign.ts signs it;
 * - a ledger entry's own Ed25519 signature and chain hash, as the receipt page checks them
 *   (src/lib/receipts/verify.ts).
 */

/** How far a delivery's timestamp may be from now, in seconds, as the server's own check allows. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** A ledger entry as a delivery carries it: `GET /api/v1/ledger`'s fields, without the row `id`. */
export type WebhookLedgerEntry = Omit<LedgerEntry, "id">;

export interface WebhookEvent {
  /** The delivery's id, the same on every retry of it: de-duplicate on it. */
  id: string;
  type: "ledger.appended" | "webhook.test";
  createdAt: string;
  workspace: { slug: string };
  /** The entry appended. `ledger.appended` only. */
  entry?: WebhookLedgerEntry;
}

export type WebhookVerificationReason = "missing" | "malformed" | "expired" | "mismatch";

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";

  constructor(
    readonly reason: WebhookVerificationReason,
    message: string
  ) {
    super(message);
  }
}

/** `ok: null` is not a failure: no key known here could check the entry. */
export type EntryCheck = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string };

const TIMESTAMP = /^\d{1,15}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex) ? hex : "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await subtle().digest("SHA-256", data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const binary = atob(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The event a delivery carries, once its `Vestiarion-Signature` proves Vestiarion sent this exact body, within
 * `toleranceSeconds` of `now`. Pass the raw request body as it arrived: a re-serialized copy differs byte for byte.
 * Throws a `WebhookVerificationError` otherwise; nothing is parsed before the signature checks out.
 */
export async function verifyWebhook(input: {
  secret: string;
  payload: string;
  signature: string | null | undefined;
  toleranceSeconds?: number;
  now?: Date;
}): Promise<WebhookEvent> {
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  // NaN in either would make every timestamp "within" the window, and turn replay protection off.
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError("toleranceSeconds must be a number of seconds, 0 or more.");
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date.");
  if (typeof input.payload !== "string") {
    throw new WebhookVerificationError("malformed", "payload must be the raw request body as a string, not a parsed object.");
  }
  if (!input.signature) throw new WebhookVerificationError("missing", "The delivery has no Vestiarion-Signature header.");

  let t: number | null = null;
  const candidates: string[] = [];
  for (const part of input.signature.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new WebhookVerificationError("malformed", "Vestiarion-Signature is not t=<seconds>,v1=<hex>.");
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === "t") {
      if (t !== null || !TIMESTAMP.test(value)) throw new WebhookVerificationError("malformed", "Vestiarion-Signature's timestamp is not valid.");
      t = Number(value);
    } else if (name === "v1") {
      if (!HEX_SHA256.test(value)) throw new WebhookVerificationError("malformed", "Vestiarion-Signature's v1 is not a hex HMAC-SHA256.");
      candidates.push(value);
    }
  }
  if (t === null || candidates.length === 0) throw new WebhookVerificationError("malformed", "Vestiarion-Signature needs a t and a v1.");
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - t) > tolerance) throw new WebhookVerificationError("expired", `The delivery was signed more than ${tolerance} s from now.`);

  const key = await subtle().importKey("raw", utf8(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = utf8(`${t}.${input.payload}`);
  let match = false;
  for (const candidate of candidates) {
    // Every candidate is checked, so the time taken does not tell which one matched.
    if (await subtle().verify("HMAC", key, hexToBytes(candidate), signed)) match = true;
  }
  if (!match) throw new WebhookVerificationError("mismatch", "The signature does not match this body and secret.");

  let event: unknown;
  try {
    event = JSON.parse(input.payload);
  } catch {
    throw new WebhookVerificationError("malformed", "The delivery's body is not JSON.");
  }
  if (typeof event !== "object" || event === null || typeof (event as { type?: unknown }).type !== "string") {
    throw new WebhookVerificationError("malformed", "The delivery's body is not a Vestiarion event.");
  }
  return event as WebhookEvent;
}

/** The keys an entry may be checked against: each filed under its true id, and only the one the entry names, if it names one. */
async function candidateKeys(entry: WebhookLedgerEntry, keys: string | Record<string, string>): Promise<Uint8Array<ArrayBuffer>[]> {
  const pems = typeof keys === "string" ? [[null, keys] as const] : Object.entries(keys);
  const filed = await Promise.all(
    pems.map(async ([id, pem]) => {
      const der = pemToDer(pem);
      const trueId = (await sha256Hex(der)).slice(0, 16);
      return { der, trueId, genuine: id === null || id === trueId };
    })
  );
  const genuine = filed.filter((key) => key.genuine);
  return (entry.signingKeyId ? genuine.filter((key) => key.trueId === entry.signingKeyId) : genuine).map((key) => key.der);
}

/**
 * Whether a ledger entry is authentic, as the receipt page checks one:
 * - its content matches `bodyHash`, SHA-256 of the canonical JSON of `{ actor, domain, action, summary, detail }`;
 * - `signature` is the workspace key's Ed25519 signature over the 32 bytes of `bodyHash`;
 * - `hash` is SHA-256 of `prevHash + bodyHash + signature`.
 *
 * `keys` is the PEM from the workspace's Audit page, or a map of key id to PEM. A key counts only under its true id, the
 * first 16 hex characters of SHA-256 of its SPKI encoding.
 */
export async function verifyLedgerEntry(entry: WebhookLedgerEntry, keys: string | Record<string, string>): Promise<EntryCheck> {
  const body = canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail });
  if ((await sha256Hex(utf8(body))) !== entry.bodyHash) return { ok: false, reason: "The entry's content does not match its body hash." };

  const candidates = await candidateKeys(entry, keys);
  if (candidates.length === 0) return { ok: null, reason: "The key that signed this entry is not known here." };
  let signed = false;
  try {
    for (const der of candidates) {
      const key = await subtle().importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
      if (await subtle().verify({ name: "Ed25519" }, key, hexToBytes(entry.signature), hexToBytes(entry.bodyHash))) {
        signed = true;
        break;
      }
    }
  } catch {
    return { ok: null, reason: "The Ed25519 signature could not be checked here." };
  }
  if (!signed) return { ok: false, reason: "The signature does not verify with the workspace's key." };

  if ((await sha256Hex(utf8(entry.prevHash + entry.bodyHash + entry.signature))) !== entry.hash) {
    return { ok: false, reason: "The entry's chain hash does not match." };
  }
  return { ok: true };
}
