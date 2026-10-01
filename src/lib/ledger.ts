import crypto from "node:crypto";
import { db, unwrap } from "./dal";
import { currentOrgConfig, currentSecretWarnings } from "./context";
import type { VestiarionConfig } from "./config";
import { dispatchWebhooksSoon } from "./webhooks/dispatch-soon";
import { canonicalJson } from "./canonical-json";
import {
  detectKeyRotation,
  ledgerKeyId,
  ledgerReadKeys,
  ledgerSigningKey,
  type KeyRotation,
  type LedgerKeyring,
  type LedgerReadKeys,
  type LocalLedgerKeyStore,
} from "./ledger-keys";

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
 * Each organization signs with its own key, stored encrypted on its `orgs`
 * row and decrypted into the configuration of its scope, where it is held
 * only in memory (spec §5.4). Verifying needs only the public half, which is
 * derived from that same stored key. In a real deployment the private key
 * belongs in a KMS, which would replace where `orgConfig` reads it from and
 * nothing else.
 */

// Shared with the receipt page's browser check, so the two can never hash an entry differently.
export { canonicalJson };

const GENESIS_HASH = "0".repeat(64);

/** Organizations sign only with their own persisted key (spec §5.4); a key file on this machine is nobody's. */
const NO_LOCAL_KEYS: LocalLedgerKeyStore = {
  read: () => null,
  create: () => {
    throw new Error("an organization's ledger key is created with the organization, never on demand");
  },
};

/**
 * The public half of whatever key this organization verifies against, or
 * `null` when it declares none.
 */
function ledgerReadKeyring(): LedgerReadKeys {
  return ledgerReadKeys(currentOrgConfig());
}

function ledgerPublicKey(): crypto.KeyObject | null {
  return ledgerReadKeyring().active;
}

/** Configuration problems the read path met, for the audit page to say in words. */
export function ledgerReadWarnings(): string[] {
  return [...currentSecretWarnings(), ...ledgerReadKeyring().warnings];
}

/** The id of the key this deployment verifies with, for display beside it. */
export function ledgerPublicKeyId(): string | null {
  const key = ledgerPublicKey();
  return key ? ledgerKeyId(key) : null;
}

export function ledgerPublicKeyPem(): string | null {
  const key = ledgerPublicKey();
  return key ? key.export({ type: "spki", format: "pem" }).toString() : null;
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
  /** Which key signed it; `null` for entries written before key identity. */
  signingKeyId: string | null;
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
  /**
   * Which key signed this entry, `null` for entries written before the column
   * existed. A label, not a claim: it is outside the body hash and outside the
   * chain hash, so it selects the key to check against and proves nothing by
   * itself. Verification stays sound because the signature must still verify
   * under whatever key the label names.
   */
  signing_key_id?: string | null;
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
    signingKeyId: row.signing_key_id ?? null,
  };
}

/** Signs and links one entry. The rotation check above this must not recurse into it. */
async function appendSigned(input: LedgerEntryInput, privateKey: crypto.KeyObject): Promise<LedgerEntry> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto
    .sign(null, Buffer.from(bodyHash, "hex"), privateKey)
    .toString("hex");

  const row = unwrap(
    await db()
      .rpc("append_ledger_entry", {
        p_actor: input.actor,
        p_domain: input.domain,
        p_action: input.action,
        p_summary: input.summary,
        p_detail: input.detail,
        p_body_hash: bodyHash,
        p_signature: signature,
        p_signing_key_id: ledgerKeyId(privateKey),
      })
      .single<LedgerRow>()
  );

  // The append queued this entry's webhook deliveries in the same transaction
  // (webhooks design W2); send them right after the response (W3).
  dispatchWebhooksSoon();
  return rowToEntry(row);
}

/**
 * The rotation the next entry would record, if any: the key that signed the
 * newest entry, against the one this scope's keyring holds as active. Shared
 * by the automatic check and by a rotation an owner makes.
 */
async function pendingKeyRotation(): Promise<KeyRotation | null> {
  const head = unwrap(
    await db()
      .from("ledger_entries")
      .select("signing_key_id, body_hash, signature")
      .order("seq", { ascending: false })
      .limit(1)
  ) as Array<{ signing_key_id: string | null; body_hash: string; signature: string }>;

  return detectKeyRotation(head[0] ?? null, ledgerVerificationKeyring());
}

function rotationEntry(rotation: KeyRotation, by?: string): LedgerEntryInput {
  return {
    actor: by ? "human" : "system",
    domain: "system",
    action: "ledger_key_rotated",
    summary: `Ledger signing key rotated: ${rotation.from} retired, ${rotation.to} now signs`,
    detail: by ? { from: rotation.from, to: rotation.to, by } : { from: rotation.from, to: rotation.to },
  };
}

/**
 * If the key that signed the newest entry is not the one about to sign, the
 * ledger records that itself — an entry signed by the new key, naming both —
 * before anything else is written under the new authority.
 */
async function recordKeyRotationIfAny(privateKey: crypto.KeyObject): Promise<void> {
  const rotation = await pendingKeyRotation();
  if (!rotation) return;
  await appendSigned(rotationEntry(rotation), privateKey);
}

/**
 * The entry for a rotation an owner made (`rotateLedgerKey`), naming who.
 * Called in a scope entered *after* the swap, so the key it signs with is the
 * new one and the old one is in the keyring as retired. `null` when there is
 * nothing to record: the head is signed by the current key already, or by a
 * key this keyring cannot vouch for.
 */
export async function recordLedgerKeyRotation(by: string): Promise<LedgerEntry | null> {
  const privateKey = ledgerSigningKey(currentOrgConfig(), NO_LOCAL_KEYS);
  const rotation = await pendingKeyRotation();
  if (!rotation) return null;
  return appendSigned(rotationEntry(rotation, by), privateKey);
}

/**
 * One rotation check per configuration per process, shared by concurrent
 * appends so two cycles starting together cannot both write the rotation
 * entry. A failed check is forgotten so the next append tries again rather
 * than skipping rotation for the life of the process. Two *processes* starting
 * together after a rotation can still each record it; both statements are
 * true, and the advisory lock inside append_ledger_entry keeps the chain
 * itself consistent.
 */
const rotationChecks = new WeakMap<VestiarionConfig, Promise<void>>();

function rotationRecorded(config: VestiarionConfig, privateKey: crypto.KeyObject): Promise<void> {
  let pending = rotationChecks.get(config);
  if (!pending) {
    pending = recordKeyRotationIfAny(privateKey).catch((err) => {
      rotationChecks.delete(config);
      throw err;
    });
    rotationChecks.set(config, pending);
  }
  return pending;
}

export async function appendLedgerEntry(input: LedgerEntryInput): Promise<LedgerEntry> {
  const config = currentOrgConfig();
  const privateKey = ledgerSigningKey(config, NO_LOCAL_KEYS);
  await rotationRecorded(config, privateKey);
  return appendSigned(input, privateKey);
}

export async function listLedgerEntries(limit = 200): Promise<LedgerEntry[]> {
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("*")
      .order("seq", { ascending: false })
      .limit(limit)
  ) as LedgerRow[];
  return rows.map(rowToEntry);
}

export async function listLedgerEntriesForTargets({
  invoiceIds = [],
  milestoneIds = [],
}: {
  invoiceIds?: string[];
  milestoneIds?: string[];
}): Promise<LedgerEntry[]> {
  if (invoiceIds.length === 0 && milestoneIds.length === 0) return [];
  const rows = unwrap(
    await db().rpc("ledger_entries_for_targets", {
      p_invoice_ids: invoiceIds,
      p_milestone_ids: milestoneIds,
    })
  ) as LedgerRow[];
  return rows.map(rowToEntry);
}

export async function listLedgerEntriesByDomain(domain: LedgerDomain, limit = 100): Promise<LedgerEntry[]> {
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("*")
      .eq("domain", domain)
      .order("seq", { ascending: false })
      .limit(limit)
  ) as LedgerRow[];
  return rows.map(rowToEntry);
}

export async function listLedgerEntriesAfter(sequence: number): Promise<LedgerEntry[]> {
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("*")
      .gt("seq", sequence)
      .order("seq", { ascending: false })
  ) as LedgerRow[];
  return rows.map(rowToEntry);
}

export async function listLedgerEntryPage({
  before,
  domain,
  limit = 100,
}: {
  before?: number;
  domain?: LedgerDomain;
  limit?: number;
} = {}): Promise<LedgerEntry[]> {
  let query = db()
    .from("ledger_entries")
    .select("*")
    .order("seq", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (before != null) query = query.lt("seq", before);
  if (domain) query = query.eq("domain", domain);
  const rows = unwrap(await query) as LedgerRow[];
  return rows.map(rowToEntry);
}

export async function ledgerEntryCount(): Promise<number> {
  const result = await db().from("ledger_entries").select("*", { count: "exact", head: true });
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

export interface VerificationResult {
  /**
   * `true` verified, `false` broken, and `null` *not checked* — which is a
   * third answer, not a soft failure. A deployment holding no public key has
   * produced no evidence either way, and reporting that as `false` would make a
   * missing environment variable indistinguishable from a tampered chain.
   */
  valid: boolean | null;
  checkedEntries: number;
  brokenAt?: number;
  reason?: string;
  /** Configuration problems found on the way to this verdict; not about the chain. */
  warnings?: string[];
}

/**
 * Replays a chain in memory: signature authorship, body integrity, and hash
 * continuity, in that order. Kept free of I/O so the same function verifies
 * the live ledger, an exported chain, and a deliberately tampered fixture in
 * the test suite — one implementation, no second verifier to drift.
 */
export function verifyChain(
  rows: LedgerRow[],
  keyring: LedgerKeyring
): VerificationResult {
  const result = verifyRows(rows, keyring);
  // The chain being fine and the configuration being broken are two different
  // facts; neither is allowed to hide the other.
  return keyring.warnings?.length ? { ...result, warnings: keyring.warnings } : result;
}

function verifyRows(rows: LedgerRow[], keyring: LedgerKeyring): VerificationResult {
  const known = new Map<string, crypto.KeyObject>();
  if (keyring.active) known.set(ledgerKeyId(keyring.active), keyring.active);
  for (const key of keyring.retired) known.set(ledgerKeyId(key), key);

  if (known.size === 0) {
    // When a broken key is the reason there is none, say which key is broken.
    // "No key configured" would send an operator to add one that is already
    // there, pasted wrong.
    const because = keyring.warnings?.length
      ? keyring.warnings.join("; ")
      : "no ledger public key is configured";
    return {
      valid: null,
      checkedEntries: rows.length,
      reason: `${because}, so authorship was not checked`,
    };
  }

  const knownIds = [...known.keys()].join(", ");
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

    // Which keys may vouch for this entry. A labelled row names one, and a
    // label the keyring does not know is reported as exactly that, before the
    // signature is tried: without this, an intact chain and a missing retired
    // key produce the identical "signature does not verify" — the one message
    // a reader is most likely to take as forgery. An unlabelled row predates
    // key identity, so any key this business has ever declared may have
    // signed it.
    let candidates: crypto.KeyObject[];
    if (row.signing_key_id) {
      const key = known.get(row.signing_key_id);
      if (!key) {
        return {
          valid: null,
          checkedEntries: rows.length,
          reason:
            `entry #${row.seq} was signed by key ${row.signing_key_id}, which is not in this ` +
            `deployment's keyring (${knownIds}), so its authorship was not checked`,
        };
      }
      candidates = [key];
    } else {
      candidates = [...known.values()];
    }

    const bodyHash = Buffer.from(row.body_hash, "hex");
    const signature = Buffer.from(row.signature, "hex");
    const signatureOk = candidates.some((key) => crypto.verify(null, bodyHash, key, signature));
    if (!signatureOk) {
      return {
        valid: false,
        checkedEntries: rows.length,
        brokenAt: row.seq,
        reason: "signature does not verify against any key in the ledger keyring",
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

/**
 * The keys this organization accepts signatures from: the active slot from
 * its own configuration, exactly as `ledgerPublicKey()` reads it, plus
 * whatever it has retired.
 */
export function ledgerVerificationKeyring(): LedgerKeyring {
  return ledgerReadKeyring();
}

/** PostgREST's `max_rows` on Supabase: the most rows one request answers with. */
export const LEDGER_PAGE_SIZE = 1000;

/**
 * Every entry of the organization in scope, oldest first. Read by `seq` in
 * pages, because one request stops at the project's row cap and a chain past
 * it would otherwise verify, or export, only its first page (audit-export E3).
 */
export async function readLedgerRows(): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let after = 0;
  for (;;) {
    const page = unwrap(
      await db()
        .from("ledger_entries")
        .select("*")
        .gt("seq", after)
        .order("seq", { ascending: true })
        .limit(LEDGER_PAGE_SIZE)
    ) as LedgerRow[];
    rows.push(...page);
    if (page.length < LEDGER_PAGE_SIZE) return rows;
    after = page[page.length - 1].seq;
  }
}

/** Verifies the ledger as stored in Postgres, oldest entry first. */
export async function verifyLedger(): Promise<VerificationResult> {
  return verifyChain(await readLedgerRows(), ledgerVerificationKeyring());
}
