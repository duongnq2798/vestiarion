import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyLedgerEntry, type WebhookLedgerEntry } from "@vestiarion/sdk";

/**
 * Checks an audit export (format vestiarion-ledger-export/1) offline, entry by entry with the SDK's
 * `verifyLedgerEntry`, then the links between entries and the head. It gives the answer, and the words, of the
 * standalone public/tools/verify-ledger-export.mjs on the same file and keys: tests/cli-ledger-verify.test.ts runs
 * both on the same exports.
 */

export type Verdict = "valid" | "broken" | "not_checked";

export interface ExportCheck {
  verdict: Verdict;
  /** What to print, the verdict first. */
  lines: string[];
}

const FORMAT = "vestiarion-ledger-export/1";
const GENESIS = "0".repeat(64);
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const REQUIRED_STRING_FIELDS = ["actor", "domain", "action", "summary", "body_hash", "signature", "prev_hash", "hash"];
const HEX_PAIRS = /^([0-9a-f]{2})*$/i;

/** A verdict reached before the end: thrown to leave the checks, caught once. */
class Verdicted {
  constructor(readonly check: ExportCheck) {}
}

function stop(verdict: Verdict, line: string): never {
  throw new Verdicted({ verdict, lines: [line] });
}

/** First 16 hex characters of SHA-256 over the key's SPKI DER form. */
function keyId(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

const spkiPem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

type ExportEntry = Record<string, unknown>;

function entryLabel(entry: unknown, position: number): string {
  return entry && typeof entry === "object" && Number.isSafeInteger((entry as ExportEntry).seq) ? `#${(entry as ExportEntry).seq}` : `number ${position}`;
}

/** Every field the checks read, checked for its shape first: an export is data from outside, never crashed on. */
function validateEntryShape(entry: unknown, position: number): asserts entry is ExportEntry {
  const invalid = (field: string) => stop("broken", `BROKEN at entry ${entryLabel(entry, position)}: it is missing or has an invalid ${field}`);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid("entry");
  const e = entry as ExportEntry;
  if (!Number.isSafeInteger(e.seq)) invalid("seq");
  for (const field of REQUIRED_STRING_FIELDS) if (typeof e[field] !== "string") invalid(field);
  if (!Object.prototype.hasOwnProperty.call(e, "detail")) invalid("detail");
  if (e.signing_key_id !== undefined && e.signing_key_id !== null && typeof e.signing_key_id !== "string") invalid("signing_key_id");
  for (const field of ["body_hash", "signature"]) {
    if (!HEX_PAIRS.test(e[field] as string)) stop("broken", `BROKEN at entry ${entryLabel(entry, position)}: its ${field} is not hex`);
  }
}

/** An export's entry as the SDK takes one: the API's field names. */
function asSdkEntry(entry: ExportEntry): WebhookLedgerEntry {
  return {
    seq: entry.seq as number,
    ts: entry.ts as string,
    actor: entry.actor as string,
    domain: entry.domain as string,
    action: entry.action as string,
    summary: entry.summary as string,
    detail: entry.detail as Record<string, unknown>,
    bodyHash: entry.body_hash as string,
    signature: entry.signature as string,
    prevHash: entry.prev_hash as string,
    hash: entry.hash as string,
    signingKeyId: (entry.signing_key_id as string | null | undefined) ?? null,
  };
}

/** The trusted keys by id: each `--public-key` file's PEM blocks, or else the keys the file carries. */
function trustedKeys(doc: { keys: unknown[] }, pinPaths: string[]): Map<string, string> {
  const known = new Map<string, string>();
  try {
    if (pinPaths.length > 0) {
      for (const pinPath of pinPaths) {
        const blocks = readFileSync(pinPath, "utf8").match(PEM_BLOCK);
        if (!blocks || blocks.length === 0) stop("not_checked", `NOT CHECKED: ${pinPath} holds no PEM key block`);
        for (const block of blocks) {
          // Node derives a public key from a private one, which would make a private key pasted by mistake look as if it worked.
          if (block.includes("PRIVATE KEY")) stop("not_checked", `NOT CHECKED: ${pinPath} holds a private key; pass the public key instead`);
          const key = createPublicKey(block);
          known.set(keyId(key), spkiPem(key));
        }
      }
    } else {
      for (const entry of doc.keys) {
        const key = createPublicKey((entry as { publicKeyPem: string }).publicKeyPem);
        known.set(keyId(key), spkiPem(key));
      }
    }
  } catch (error) {
    if (error instanceof Verdicted) throw error;
    stop("not_checked", `NOT CHECKED: a public key could not be read (${(error as Error).message})`);
  }
  return known;
}

async function check(file: string, pinPaths: string[]): Promise<ExportCheck> {
  let doc: { format?: unknown; entries: unknown[]; keys: unknown[]; head?: { seq?: unknown; hash?: unknown } | null; workspace?: { slug?: string } };
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    stop("not_checked", `NOT CHECKED: ${file} could not be read as JSON (${(error as Error).message})`);
  }
  if (doc?.format !== FORMAT || !Array.isArray(doc.entries) || !Array.isArray(doc.keys)) {
    stop("not_checked", `NOT CHECKED: ${file} is not a Vestiarion ledger export (format ${FORMAT})`);
  }

  const known = trustedKeys(doc, pinPaths);
  if (known.size === 0) stop("not_checked", "NOT CHECKED: no public key to check the signatures with");
  const trusted = [...known.keys()].join(", ");
  // The SDK checks Ed25519 keys alone, and gives up on an entry at a key of another type. Such a key cannot have signed
  // an entry, so, as the script finds, a signature it would have to verify does not verify.
  const keys = Object.fromEntries([...known].filter(([, pem]) => createPublicKey(pem).asymmetricKeyType === "ed25519"));

  let last: ExportEntry | undefined;
  try {
    if (doc.entries.length === 0 && doc.head != null) stop("broken", "BROKEN: the file names a head but holds no entries");
    let expectedPrev = GENESIS;
    for (const [index, entry] of doc.entries.entries()) {
      validateEntryShape(entry, index + 1);
      const at = `entry ${entryLabel(entry, index + 1)}`;
      // The SDK checks, in order: the body hash, that a trusted key is the one named, the signature, the chain hash.
      // The link to the entry before is this export's to check, between the signature and the chain hash.
      const result = await verifyLedgerEntry(asSdkEntry(entry), keys);
      const linkBroken = entry.prev_hash !== expectedPrev;
      if (result.ok === null) {
        if (/not known/.test(result.reason)) {
          const named = typeof entry.signing_key_id === "string" && entry.signing_key_id !== "" ? entry.signing_key_id : null;
          if (named === null ? known.size > 0 : known.has(named)) {
            stop("broken", `BROKEN at ${at}: its signature does not verify against the trusted keys (${trusted})`);
          }
          stop("not_checked", `NOT CHECKED: ${at} was signed by key ${entry.signing_key_id}, which is not among the trusted keys (${trusted})`);
        }
        stop("not_checked", `NOT CHECKED: the file could not be checked (${result.reason})`);
      }
      if (result.ok === false) {
        if (/body hash/.test(result.reason)) stop("broken", `BROKEN at ${at}: its content does not match its recorded body hash`);
        if (/signature/.test(result.reason)) stop("broken", `BROKEN at ${at}: its signature does not verify against the trusted keys (${trusted})`);
        if (linkBroken) stop("broken", `BROKEN at ${at}: prev_hash does not match the preceding entry's hash`);
        if (/chain hash/.test(result.reason)) stop("broken", `BROKEN at ${at}: its hash does not match prev_hash + body_hash + signature`);
        stop("broken", `BROKEN at ${at}: ${result.reason}`);
      }
      if (linkBroken) stop("broken", `BROKEN at ${at}: prev_hash does not match the preceding entry's hash`);
      expectedPrev = entry.hash as string;
    }
    last = doc.entries[doc.entries.length - 1] as ExportEntry | undefined;
    if (last && (doc.head?.seq !== last.seq || doc.head?.hash !== last.hash)) {
      stop("broken", `BROKEN: the file's head does not name its last entry (#${last.seq})`);
    }
  } catch (error) {
    if (error instanceof Verdicted) throw error;
    stop("not_checked", `NOT CHECKED: the file could not be checked (${(error as Error).message})`);
  }

  return {
    verdict: "valid",
    lines: [
      `VALID: ${doc.entries.length} entries of ${doc.workspace?.slug ?? "this workspace"}, each signed and linked from genesis`,
      `Head: ${last ? `#${last.seq} ${last.hash}` : "none (empty chain)"}`,
      `Trusted key id${known.size === 1 ? "" : "s"}: ${trusted}${pinPaths.length > 0 ? " (from --public-key)" : " (from the file itself)"}`,
      pinPaths.length > 0
        ? "The signatures were checked against the key(s) you supplied."
        : "The file vouches for itself: compare this key id and head hash with the workspace's Audit page before relying on it.",
    ],
  };
}

export async function checkLedgerExport(file: string, pinPaths: string[] = []): Promise<ExportCheck> {
  try {
    return await check(file, pinPaths);
  } catch (error) {
    if (error instanceof Verdicted) return error.check;
    throw error;
  }
}
