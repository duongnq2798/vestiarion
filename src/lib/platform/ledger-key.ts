import crypto from "node:crypto";
import { CYCLE_IN_PROGRESS_MS } from "../agent/balances";
import { currentOrgId, NoOrgScopeError } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { ledgerPublicKeyId, recordLedgerKeyRotation } from "../ledger";
import { ledgerKeyId } from "../ledger-keys";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";

/**
 * Rotating a workspace's ledger signing key
 * (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md §1). The
 * server action in `src/app/actions/ledger-key.ts` gates it on
 * `org.administer`; this module does the work.
 *
 * The old private key exists in plaintext only between `decryptSecret` and the
 * derivation of its public half, and the new one only between its generation
 * and `encryptSecret`. Neither is logged, returned, stored outside the sealed
 * envelope, or put in an error's message: every refusal is a `LedgerKeyError`
 * with a fixed message. After the swap the old private key exists nowhere
 * (K5); its public half stays on the row, so every entry it signed keeps
 * verifying.
 */

export type LedgerKeyErrorCode = "cycle_running" | "key_unreadable" | "conflict";

const MESSAGES: Record<LedgerKeyErrorCode, string> = {
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  key_unreadable: "The current signing key cannot be read, so it cannot be retired safely. Nothing was changed.",
  conflict: "The signing key changed a moment ago. Reload and check it before rotating again.",
};

export class LedgerKeyError extends Error {
  constructor(readonly code: LedgerKeyErrorCode) {
    super(MESSAGES[code]);
    this.name = "LedgerKeyError";
  }
}

const COLUMN = "ledger_signing_key_enc";

/** An item of `orgs.ledger_retired_keys` (0035): public material only. */
interface RetiredKey {
  id: string;
  publicKeyPem: string;
  retiredAt: string;
}

/** The organization in scope, or null outside every scope. */
function scopedOrgId(): string | null {
  try {
    return currentOrgId();
  } catch (error) {
    if (error instanceof NoOrgScopeError) return null;
    throw error;
  }
}

/**
 * Runs `fn` in the organization's scope: the one a server action already
 * entered (`inOrg`), or a new one for any other caller. Only for reads and
 * checks that do not depend on the signing key: after a swap the scope
 * already entered still holds the old one.
 */
function inScopeOf<T>(orgId: string, actorId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return scopedOrgId() === orgId ? fn() : withOrg(orgId, fn, { userId: actorId });
}

async function cycleRunning(now: Date): Promise<boolean> {
  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(now.getTime() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  return running.length > 0;
}

/**
 * The public half of the stored key and the master keys that opened it, or
 * `key_unreadable`. The reason is not passed on: a decryption or parse error
 * is not worth the risk of carrying key material into a message.
 */
function openCurrentKey(
  orgId: string,
  envelope: SecretEnvelope | null
): { publicKey: crypto.KeyObject; keys: MasterKey[] } {
  if (!envelope) throw new LedgerKeyError("key_unreadable");
  try {
    const keys = masterKeysFromEnv();
    const publicKey = crypto.createPublicKey(
      crypto.createPrivateKey(decryptSecret(envelope, { orgId, column: COLUMN }, keys))
    );
    return { publicKey, keys };
  } catch {
    throw new LedgerKeyError("key_unreadable");
  }
}

/**
 * Retires the workspace's signing key and puts a new one in its place, then
 * records that in the ledger, signed by the new key. Returns the two key ids
 * and nothing else.
 */
export async function rotateLedgerKey(input: {
  orgId: string;
  actorId: string;
  now?: Date;
}): Promise<{ from: string; to: string }> {
  const { orgId, actorId } = input;
  const now = input.now ?? new Date();

  // K4: a running cycle holds the old key in its scope.
  if (await inScopeOf(orgId, actorId, () => cycleRunning(now))) throw new LedgerKeyError("cycle_running");

  const row = unwrap(
    await platformDb().from("orgs").select("ledger_signing_key_enc, ledger_retired_keys").eq("id", orgId).single()
  ) as { ledger_signing_key_enc: SecretEnvelope | null; ledger_retired_keys: unknown };

  const current = openCurrentKey(orgId, row.ledger_signing_key_enc);
  const from = ledgerKeyId(current.publicKey);

  const next = crypto.generateKeyPairSync("ed25519");
  const to = ledgerKeyId(next.publicKey);
  const envelope = encryptSecret(
    next.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { orgId, column: COLUMN },
    current.keys
  );

  const retired: unknown[] = [
    ...(Array.isArray(row.ledger_retired_keys) ? row.ledger_retired_keys : []),
    {
      id: from,
      publicKeyPem: current.publicKey.export({ type: "spki", format: "pem" }).toString(),
      retiredAt: now.toISOString(),
    } satisfies RetiredKey,
  ];

  // K2: the swap and the retirement in one update, and only over the envelope
  // read above. A rotation that landed in between makes this match nothing.
  const written = unwrap(
    await platformDb()
      .from("orgs")
      .update({ ledger_signing_key_enc: envelope, ledger_retired_keys: retired })
      .eq("id", orgId)
      .eq("ledger_signing_key_enc->>iv", (row.ledger_signing_key_enc as SecretEnvelope).iv)
      .select("id")
  ) as Array<{ id: string }>;
  if (written.length === 0) throw new LedgerKeyError("conflict");

  // K3: a fresh scope, never the one a caller entered before the swap, which
  // still holds the old key. The rotation is done either way; a missed entry
  // is written by the automatic detection on the next append.
  try {
    await withOrg(orgId, () => recordLedgerKeyRotation(actorId), { userId: actorId });
  } catch (error) {
    console.error(
      "ledger key rotation: the rotation entry could not be written",
      orgId,
      error instanceof Error ? error.message : "unknown error"
    );
  }

  return { from, to };
}

/**
 * An item the keyring uses (the same test as `retiredKeyBundle` in
 * org-config.ts) with a readable time: the panel never lists a key that
 * verification skips.
 */
function wellFormed(item: unknown): item is RetiredKey {
  if (typeof item !== "object" || item === null) return false;
  const { id, publicKeyPem, retiredAt } = item as { id?: unknown; publicKeyPem?: unknown; retiredAt?: unknown };
  return (
    typeof id === "string" &&
    typeof publicKeyPem === "string" &&
    publicKeyPem.includes("-----BEGIN PUBLIC KEY-----") &&
    typeof retiredAt === "string" &&
    !Number.isNaN(Date.parse(retiredAt))
  );
}

/**
 * What the Settings panel shows: the id of the key that signs, and the
 * retired keys with when each was retired. Ids and times only.
 */
export async function ledgerKeyStatus(
  orgId: string
): Promise<{ current: string | null; retired: Array<{ id: string; retiredAt: string }> }> {
  const current = await inScopeOf(orgId, undefined, async () => ledgerPublicKeyId());
  const row = unwrap(
    await platformDb().from("orgs").select("ledger_retired_keys").eq("id", orgId).single()
  ) as { ledger_retired_keys: unknown };
  const retired = (Array.isArray(row.ledger_retired_keys) ? row.ledger_retired_keys : [])
    .filter(wellFormed)
    .map(({ id, retiredAt }) => ({ id, retiredAt }))
    .sort((a, b) => Date.parse(b.retiredAt) - Date.parse(a.retiredAt));
  return { current, retired };
}
