import { canonicalJson } from "../canonical-json";

/**
 * The receipt's verifier (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5, R5). Written
 * against Web Crypto alone, so the same code checks an entry on the server and again in the reader's
 * browser: one implementation, nothing to drift. It replays what the ledger does (`src/lib/ledger.ts`):
 *
 *   body_hash  sha256(canonicalJson({ actor, domain, action, summary, detail }))
 *   signature  Ed25519 over the 32 bytes of body_hash, by the key `signing_key_id` names
 *   hash       sha256(prev_hash || body_hash || signature), the hex strings joined
 *
 * A key is filed under its id, the first 16 hex characters of the SHA-256 of its SPKI encoding, and the
 * id is recomputed here: a label never vouches for a key it does not name.
 */

/** A ledger row as the receipt page shows it: the whole signed body and its chain fields. */
export interface PublicLedgerRow {
  seq: number;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  body_hash: string;
  signature: string;
  prev_hash: string;
  hash: string;
  signing_key_id: string | null;
}

/**
 * An entry's signed link alone, without its body: what a page may publish of an entry whose content stays private (the
 * landing's latest decision, docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R3).
 */
export type SignedLink = Pick<PublicLedgerRow, "body_hash" | "signature" | "prev_hash" | "hash" | "signing_key_id">;

/** `ok: null` is not a failure: it means the check could not be made here. */
export type EntryCheck = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string };

const UNKNOWN_KEY = "The key that signed this entry is not known here.";

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex) ? hex : "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(await subtle().digest("SHA-256", input));
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The keys an entry may be checked against: the one its label names, if that key really has that id; any key for an unlabelled entry. */
async function candidateKeys(row: Pick<PublicLedgerRow, "signing_key_id">, keys: Record<string, string>): Promise<Uint8Array<ArrayBuffer>[]> {
  const filed = await Promise.all(
    Object.entries(keys).map(async ([id, pem]) => {
      const der = pemToDer(pem);
      return { id, der, trueId: (await sha256Hex(der)).slice(0, 16) };
    })
  );
  const genuine = filed.filter((key) => key.id === key.trueId);
  return (row.signing_key_id ? genuine.filter((key) => key.id === row.signing_key_id) : genuine).map((key) => key.der);
}

export async function verifyEntry(row: PublicLedgerRow, keys: Record<string, string>): Promise<EntryCheck> {
  const body = canonicalJson({ actor: row.actor, domain: row.domain, action: row.action, summary: row.summary, detail: row.detail });
  if ((await sha256Hex(body)) !== row.body_hash) return { ok: false, reason: "The entry's content does not match its body hash." };
  return verifySignedLink(row, keys);
}

/**
 * The half of `verifyEntry` that needs no body: the Ed25519 signature over the body hash, by the key the entry names,
 * and the chain hash that links it to the entry before it. It cannot say what the body held, only that this hash was
 * signed and sits in the chain.
 */
export async function verifySignedLink(row: SignedLink, keys: Record<string, string>): Promise<EntryCheck> {
  const candidates = await candidateKeys(row, keys);
  if (candidates.length === 0) return { ok: null, reason: UNKNOWN_KEY };
  let signed = false;
  try {
    for (const der of candidates) {
      const key = await subtle().importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
      if (await subtle().verify({ name: "Ed25519" }, key, hexToBytes(row.signature), hexToBytes(row.body_hash))) {
        signed = true;
        break;
      }
    }
  } catch {
    // Web Crypto here cannot use the key as Ed25519 (an older browser, or a key that is not one): no evidence either way.
    return { ok: null, reason: "The Ed25519 signature could not be checked here." };
  }
  if (!signed) return { ok: false, reason: "The signature does not verify with the workspace's key." };

  if ((await sha256Hex(row.prev_hash + row.body_hash + row.signature)) !== row.hash) return { ok: false, reason: "The entry's chain hash does not match." };
  return { ok: true };
}

/** Whether `row` is the entry a receipt names (`hash`) and its detail records one of the payment's transactions. */
export function recordsTransaction(row: PublicLedgerRow, hash: string, txHashes: string[]): boolean {
  if (row.hash !== hash) return false;
  const detail = JSON.stringify(row.detail).toLowerCase();
  return txHashes.some((tx) => detail.includes(tx.toLowerCase()));
}
