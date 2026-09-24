import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { supabase, unwrap } from "./supabase";

/**
 * The Vestiarion ledger: an append-only, hash-chained, Ed25519-signed record
 * of every decision the agent makes. This is the "continuous euthyna" the
 * hackathon brief describes — a reviewer can replay *why* the agent acted,
 * not just that a balance changed.
 *
 * Two independent guarantees, deliberately separated:
 *
 *   Authorship     the agent signs `body_hash`, the sha256 of the entry's
 *                  own content. It can do this without knowing where the
 *                  entry will land in the chain.
 *   Tamper-evidence the database, holding an advisory lock, links that
 *                  signed body into the chain as
 *                  sha256(prev_hash || body_hash || signature).
 *
 * Splitting them this way is what makes concurrent appends safe: there is no
 * read-then-write window in which two agent cycles could observe the same
 * `prev_hash` and fork the chain.
 *
 * The signing key lives on disk outside the repo (`data/`, gitignored). In a
 * real deployment it belongs in a KMS; the verification path is unchanged.
 */

const GENESIS_HASH = "0".repeat(64);

const keyDir = path.join(process.cwd(), "data");
const privKeyPath = path.join(keyDir, "ledger-signing-key.pem");
const pubKeyPath = path.join(keyDir, "ledger-signing-key.pub.pem");

function ensureKeypair() {
  if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
  if (fs.existsSync(privKeyPath) && fs.existsSync(pubKeyPath)) return;

  // LEDGER_SIGNING_KEY lets a serverless deployment carry the key in an env
  // var instead of the filesystem, which does not persist between invocations.
  const fromEnv = process.env.LEDGER_SIGNING_KEY;
  if (fromEnv) {
    const privateKey = crypto.createPrivateKey(fromEnv.replace(/\\n/g, "\n"));
    fs.writeFileSync(privKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(
      pubKeyPath,
      crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" })
    );
    return;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(pubKeyPath, publicKey.export({ type: "spki", format: "pem" }));
}

function loadKeys() {
  ensureKeypair();
  return {
    privateKey: crypto.createPrivateKey(fs.readFileSync(privKeyPath)),
    publicKey: crypto.createPublicKey(fs.readFileSync(pubKeyPath)),
  };
}

export function ledgerPublicKeyPem(): string {
  ensureKeypair();
  return fs.readFileSync(pubKeyPath, "utf8");
}

export type LedgerDomain =
  | "ap"
  | "ar"
  | "contractor"
  | "treasury"
  | "compliance"
  | "system";

export interface LedgerEntryInput {
  actor: "agent" | "human" | "system";
  domain: LedgerDomain;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface LedgerEntry extends LedgerEntryInput {
  seq: number;
  id: string;
  ts: string;
  bodyHash: string;
  signature: string;
  prevHash: string;
  hash: string;
}

export interface LedgerRow {
  seq: number;
  id: string;
  ts: string;
  actor: LedgerEntryInput["actor"];
  domain: LedgerDomain;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  body_hash: string;
  signature: string;
  prev_hash: string;
  hash: string;
}

/**
 * Stable JSON: keys sorted at every level, so the same logical entry always
 * hashes identically regardless of property insertion order. `JSON.stringify`
 * with a sorted key array only sorts the top level, which is the classic way
 * to get a hash chain that silently fails to reproduce.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function bodyHashOf(input: LedgerEntryInput): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        actor: input.actor,
        domain: input.domain,
        action: input.action,
        summary: input.summary,
        detail: input.detail,
      })
    )
    .digest("hex");
}

function rowToEntry(row: LedgerRow): LedgerEntry {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    domain: row.domain,
    action: row.action,
    summary: row.summary,
    detail: row.detail,
    bodyHash: row.body_hash,
    signature: row.signature,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export async function appendLedgerEntry(input: LedgerEntryInput): Promise<LedgerEntry> {
  const { privateKey } = loadKeys();
  const bodyHash = bodyHashOf(input);
  const signature = crypto
    .sign(null, Buffer.from(bodyHash, "hex"), privateKey)
    .toString("hex");

  const row = unwrap(
    await supabase()
      .rpc("append_ledger_entry", {
        p_actor: input.actor,
        p_domain: input.domain,
        p_action: input.action,
        p_summary: input.summary,
        p_detail: input.detail,
        p_body_hash: bodyHash,
        p_signature: signature,
      })
      .single<LedgerRow>()
  );

  return rowToEntry(row);
}

export async function listLedgerEntries(limit = 200): Promise<LedgerEntry[]> {
  const rows = unwrap(
    await supabase()
      .from("ledger_entries")
      .select("*")
      .order("seq", { ascending: false })
      .limit(limit)
  ) as LedgerRow[];
  return rows.map(rowToEntry);
}

export interface VerificationResult {
  valid: boolean;
  checkedEntries: number;
  brokenAt?: number;
  reason?: string;
}

/**
 * Replays a chain in memory: signature authorship, body integrity, and hash
 * continuity, in that order. Kept free of I/O so the same function verifies
 * the live ledger, an exported chain, and a deliberately tampered fixture in
 * the test suite — one implementation, no second verifier to drift.
 */
export function verifyChain(
  rows: LedgerRow[],
  publicKey: crypto.KeyObject
): VerificationResult {
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    const recomputedBody = bodyHashOf({
      actor: row.actor,
      domain: row.domain,
      action: row.action,
      summary: row.summary,
      detail: row.detail,
    });
    if (recomputedBody !== row.body_hash) {
      return {
        valid: false,
        checkedEntries: rows.length,
        brokenAt: row.seq,
        reason: "entry content does not match its recorded body hash",
      };
    }

    const signatureOk = crypto.verify(
      null,
      Buffer.from(row.body_hash, "hex"),
      publicKey,
      Buffer.from(row.signature, "hex")
    );
    if (!signatureOk) {
      return {
        valid: false,
        checkedEntries: rows.length,
        brokenAt: row.seq,
        reason: "signature does not verify against the ledger public key",
      };
    }

    if (row.prev_hash !== expectedPrev) {
      return {
        valid: false,
        checkedEntries: rows.length,
        brokenAt: row.seq,
        reason: "prev_hash does not match the preceding entry's hash",
      };
    }

    const recomputedHash = crypto
      .createHash("sha256")
      .update(row.prev_hash + row.body_hash + row.signature)
      .digest("hex");
    if (recomputedHash !== row.hash) {
      return {
        valid: false,
        checkedEntries: rows.length,
        brokenAt: row.seq,
        reason: "chain hash does not match prev_hash + body_hash + signature",
      };
    }

    expectedPrev = row.hash;
  }

  return { valid: true, checkedEntries: rows.length };
}

/** Verifies the ledger as stored in Postgres, oldest entry first. */
export async function verifyLedger(): Promise<VerificationResult> {
  const { publicKey } = loadKeys();
  const rows = unwrap(
    await supabase().from("ledger_entries").select("*").order("seq", { ascending: true })
  ) as LedgerRow[];
  return verifyChain(rows, publicKey);
}
