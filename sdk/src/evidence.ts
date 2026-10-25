import { verifyLedgerEntry, type EntryCheck, type WebhookLedgerEntry } from "./webhooks.js";

/**
 * Checking a Vestiarion evidence document offline, with Web Crypto alone and no request
 * (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA13): a payment's evidence, the
 * payee lock's evidence, a receipt or a monthly close pack, from the API or downloaded from the workspace.
 */

export const EVIDENCE_FORMATS = [
  "vestiarion-evidence/1",
  "vestiarion-payee-lock-evidence/1",
  "vestiarion-receipt/1",
  "vestiarion-close-pack/1",
] as const;

export type EvidenceFormat = (typeof EVIDENCE_FORMATS)[number];

export interface EvidenceVerification {
  /** true: every cited entry is carried and verifies, and every link and copy holds; false: something does not; null: nothing failed, but some entry's key was not given. */
  ok: boolean | null;
  format: EvidenceFormat;
  /** Whose keys checked it: the ones passed, or the document's own. */
  keys: "given" | "document";
  entries: Array<{ seq: number; check: EntryCheck }>;
  counts: { cited: number; carried: number; verified: number; failed: number; unchecked: number };
  /** One plain sentence for each thing that is not as it should be. */
  problems: string[];
}

const NOT_A_DOCUMENT =
  "verifyEvidence takes a Vestiarion evidence document: an object whose format is vestiarion-evidence/1, vestiarion-payee-lock-evidence/1, vestiarion-receipt/1 or vestiarion-close-pack/1.";
const WHOLE_ANSWER = "Pass the document itself, the answer's data, not the whole answer.";
const NO_ENTRIES = "The document carries no list of entries to check.";
const BAD_KEYS = "keys must be the PEM public key from the workspace's Audit log page, or a map of key id to PEM.";
const DOCUMENT_KEYS = "Checked with the keys the document carries. Compare their ids with the workspace's Audit log to tie them to the workspace.";
const KEYS_UNREADABLE = "A key could not be read as a PEM public key.";
const NOT_AN_ENTRY = "The document's list of entries holds something that is not a ledger entry.";

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFormat(value: unknown): value is EvidenceFormat {
  return typeof value === "string" && (EVIDENCE_FORMATS as readonly string[]).includes(value);
}

const isSeq = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const fieldsOf = (value: unknown): Fields[] => (Array.isArray(value) ? value.filter(isFields) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The key id an entry, or a copy of its link, names: snake_case in an entry, camelCase in a close pack row's record. */
function keyIdOf(fields: Fields): string | null {
  const id = fields.signing_key_id ?? fields.signingKeyId;
  return typeof id === "string" ? id : null;
}

/** An entry as the document carries it (snake_case, as `GET /api/v1/ledger`'s rows are not), in `verifyLedgerEntry`'s fields. */
function ledgerEntry(entry: Fields & { seq: number }): WebhookLedgerEntry {
  // The signed body goes to the hash as it is: whatever the file holds there is what must match the body hash.
  const body = { actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail } as Pick<WebhookLedgerEntry, "actor" | "domain" | "action" | "summary" | "detail">;
  return {
    seq: entry.seq,
    ts: text(entry.ts),
    ...body,
    bodyHash: text(entry.body_hash ?? entry.bodyHash),
    signature: text(entry.signature),
    prevHash: text(entry.prev_hash ?? entry.prevHash),
    hash: text(entry.hash),
    signingKeyId: keyIdOf(entry),
  };
}

/** Every entry a fact of the document cites, by seq: what the document must carry. */
function citedBy(format: EvidenceFormat, document: Fields): Set<number> {
  const cited = new Set<number>();
  const cite = (...values: unknown[]) => {
    for (const value of values) {
      if (Array.isArray(value)) value.forEach((item) => cite(item));
      else if (isSeq(value)) cited.add(value);
    }
  };
  if (format === "vestiarion-evidence/1") {
    for (const step of fieldsOf(document.steps)) for (const fact of fieldsOf(step.facts)) cite(fact.entries);
  } else if (format === "vestiarion-payee-lock-evidence/1") {
    for (const change of fieldsOf(document.changes)) {
      for (const part of [change.change, change.confirmation, change.firstPayment]) if (isFields(part)) cite(part.entry);
      for (const hold of fieldsOf(change.holds)) cite(hold.entry);
    }
    if (isFields(document.lock)) for (const change of fieldsOf(document.lock.changes)) cite(change.entry);
  } else if (format === "vestiarion-receipt/1") {
    if (isFields(document.records)) cite(document.records.seq);
    cite(document.invoiceEntry);
    if (isFields(document.shared)) {
      cite(document.shared.entry);
      for (const change of fieldsOf(document.shared.changes)) cite(change.entry);
    }
  } else {
    for (const row of fieldsOf(document.rows)) {
      cite(row.entries);
      if (isFields(row.record)) cite(row.record.seq);
    }
    for (const move of fieldsOf(document.escrow)) cite(move.entry);
  }
  return cited;
}

/** A copy of an entry's signed link that the document states beside it must be the entry's own. */
function copyProblems(format: EvidenceFormat, document: Fields, bySeq: ReadonlyMap<number, Fields>): string[] {
  const problems: string[] = [];
  if (format === "vestiarion-close-pack/1") {
    for (const row of fieldsOf(document.rows)) {
      const record = row.record;
      if (!isFields(record) || !isSeq(record.seq)) continue;
      const entry = bySeq.get(record.seq);
      if (!entry) continue; // Named once already: cited but not in the document.
      if (record.hash !== entry.hash || record.signature !== entry.signature || keyIdOf(record) !== keyIdOf(entry)) {
        problems.push(`The row for payment ${text(row.paymentId)} names entry #${record.seq} with another hash or signature than the entry carries.`);
      }
    }
  }
  if (format === "vestiarion-receipt/1" && isFields(document.records) && isSeq(document.records.seq)) {
    const entry = bySeq.get(document.records.seq);
    if (entry && document.records.hash !== entry.hash) problems.push(`The receipt names entry #${document.records.seq} with another hash than the entry carries.`);
  }
  return problems;
}

/** The keys to check with: the ones given, or the document's own list of `{ id, publicKeyPem }`, each filed under the id it states. */
function keysFor(document: Fields, given: unknown): { keys: string | Record<string, string>; whose: "given" | "document" } {
  if (given !== undefined) {
    const valid = typeof given === "string" || (isFields(given) && Object.values(given).every((pem) => typeof pem === "string"));
    if (!valid) throw new TypeError(BAD_KEYS);
    return { keys: given as string | Record<string, string>, whose: "given" };
  }
  const keys: Record<string, string> = {};
  for (const key of fieldsOf(document.keys)) if (typeof key.id === "string" && typeof key.publicKeyPem === "string") keys[key.id] = key.publicKeyPem;
  return { keys, whose: "document" };
}

/**
 * Whether an evidence document holds, offline:
 * - every entry it carries verifies with `verifyLedgerEntry` (body hash, Ed25519 signature by a key filed under its
 *   true id, chain hash); the document's own `check` fields are never read;
 * - every entry a fact cites is carried;
 * - two carried entries whose `seq` follow each other link: the later one's `prev_hash` is the earlier one's `hash`;
 * - a close pack row's `record` and a receipt's `records` name their entry by its own hash (and signature).
 *
 * `keys` is the PEM from the workspace's Audit log page, or a map of key id to PEM after a rotation. Without it, the
 * document's own keys are used and the answer says so: that proves the entries were not changed after those keys signed
 * them, not that the keys are the workspace's.
 *
 * It cannot say that the facts' words follow from the entries, that the document carries every entry of its period, or
 * anything on chain.
 */
export async function verifyEvidence(document: unknown, options?: { keys?: string | Record<string, string> }): Promise<EvidenceVerification> {
  if (!isFields(document)) throw new TypeError(NOT_A_DOCUMENT);
  const format = document.format;
  if (!isFormat(format)) {
    if (document.format === undefined && isFields(document.data) && isFormat(document.data.format)) throw new TypeError(WHOLE_ANSWER);
    throw new TypeError(NOT_A_DOCUMENT);
  }
  if (!Array.isArray(document.entries)) throw new TypeError(NO_ENTRIES);
  const { keys, whose } = keysFor(document, options?.keys);

  // `open` holds what leaves the answer open rather than false: whose keys, and entries no key given could check.
  const open: string[] = whose === "document" ? [DOCUMENT_KEYS] : [];
  const problems: string[] = [];
  const entries: EvidenceVerification["entries"] = [];
  const counts = { cited: 0, carried: document.entries.length, verified: 0, failed: 0, unchecked: 0 };
  const bySeq = new Map<number, Fields & { seq: number }>();
  const twice = new Set<number>();
  let notEntries = 0;

  for (const item of document.entries as unknown[]) {
    if (!isFields(item) || !isSeq(item.seq)) {
      notEntries += 1;
      continue;
    }
    const entry = item as Fields & { seq: number };
    if (bySeq.has(entry.seq)) twice.add(entry.seq);
    else bySeq.set(entry.seq, entry);
    const check = await verifyLedgerEntry(ledgerEntry(entry), keys).catch((): EntryCheck => ({ ok: null, reason: KEYS_UNREADABLE }));
    entries.push({ seq: entry.seq, check });
    if (check.ok === true) counts.verified += 1;
    else if (check.ok === false) {
      counts.failed += 1;
      problems.push(`Entry #${entry.seq} does not verify: ${check.reason}`);
    } else {
      counts.unchecked += 1;
      open.push(`Entry #${entry.seq} could not be checked: ${check.reason}`);
    }
  }
  counts.failed += notEntries;
  if (notEntries > 0) problems.push(NOT_AN_ENTRY);
  for (const seq of twice) problems.push(`Entry #${seq} is in the document twice.`);

  const cited = citedBy(format, document);
  counts.cited = cited.size;
  for (const seq of [...cited].sort((a, b) => a - b)) if (!bySeq.has(seq)) problems.push(`Entry #${seq} is cited but not in the document.`);

  // The chain is read by seq, so nothing of the workspace can sit between two entries whose seq follow each other.
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < ordered.length; i += 1) {
    const before = ordered[i - 1];
    const after = ordered[i];
    if (after.seq !== before.seq + 1) continue;
    if ((after.prev_hash ?? after.prevHash) !== before.hash) problems.push(`Entry #${after.seq} does not follow entry #${before.seq}: its prev_hash is not that entry's hash.`);
  }

  problems.push(...copyProblems(format, document, bySeq));

  const ok = problems.length > 0 ? false : counts.unchecked > 0 ? null : true;
  // The note on whose keys comes first, then each entry no key could check, then what does not hold.
  return { ok, format, keys: whose, entries, counts, problems: [...open, ...problems] };
}
