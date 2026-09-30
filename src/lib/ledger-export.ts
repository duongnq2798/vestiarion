import type { KeyObject } from "node:crypto";
import { db, unwrap } from "./dal";
import {
  canonicalJson,
  ledgerVerificationKeyring,
  readLedgerRows,
  verifyChain,
  type LedgerRow,
  type VerificationResult,
} from "./ledger";
import { ledgerKeyId, type LedgerKeyring } from "./ledger-keys";

/**
 * The audit export (docs/superpowers/specs/2026-09-30-audit-export-design.md):
 * one workspace's whole chain, oldest first, with the public keys that vouch
 * for it and what this server's own verifier said. The JSON is what verifies —
 * `public/tools/verify-ledger-export.mjs` checks it with nothing of ours — and
 * the CSV is for reading in a spreadsheet.
 */

export const LEDGER_EXPORT_FORMAT = "vestiarion-ledger-export/1";

/** The fields a chain is built from, in the order an export writes them. */
export const LEDGER_EXPORT_FIELDS = [
  "seq",
  "id",
  "ts",
  "actor",
  "domain",
  "action",
  "summary",
  "detail",
  "body_hash",
  "signature",
  "prev_hash",
  "hash",
  "signing_key_id",
] as const;

type ExportField = (typeof LEDGER_EXPORT_FIELDS)[number];

export interface LedgerExportKey {
  id: string;
  status: "active" | "retired";
  publicKeyPem: string;
}

export interface LedgerExport {
  format: typeof LEDGER_EXPORT_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  head: { seq: number; hash: string } | null;
  keys: LedgerExportKey[];
  verification: VerificationResult;
  entries: Array<Record<ExportField, unknown>>;
}

const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

/** The public keys a workspace accepts, each once: the active one first, then the retired ones. */
export function exportKeys(keyring: LedgerKeyring): LedgerExportKey[] {
  const keys: LedgerExportKey[] = [];
  const seen = new Set<string>();
  const add = (key: KeyObject, status: LedgerExportKey["status"]) => {
    const id = ledgerKeyId(key);
    if (seen.has(id)) return;
    seen.add(id);
    keys.push({ id, status, publicKeyPem: pem(key) });
  };
  if (keyring.active) add(keyring.active, "active");
  for (const key of keyring.retired) add(key, "retired");
  return keys;
}

export function exportFromRows(input: {
  rows: LedgerRow[];
  keyring: LedgerKeyring;
  workspace: { slug: string; name: string };
  now: Date;
}): LedgerExport {
  const last = input.rows[input.rows.length - 1];
  return {
    format: LEDGER_EXPORT_FORMAT,
    exportedAt: input.now.toISOString(),
    workspace: { slug: input.workspace.slug, name: input.workspace.name },
    head: last ? { seq: last.seq, hash: last.hash } : null,
    keys: exportKeys(input.keyring),
    verification: verifyChain(input.rows, input.keyring),
    entries: input.rows.map((row) => {
      const entry = {} as Record<ExportField, unknown>;
      for (const field of LEDGER_EXPORT_FIELDS) entry[field] = (row as unknown as Record<string, unknown>)[field] ?? null;
      return entry;
    }),
  };
}

/** The export of the workspace in scope, read whole and verified here first. */
export async function buildLedgerExport(workspace: { slug: string; name: string }, now = new Date()): Promise<LedgerExport> {
  return exportFromRows({ rows: await readLedgerRows(), keyring: ledgerVerificationKeyring(), workspace, now });
}

/**
 * A brake on exports (audit-export E8): every export appends its own ledger
 * entry, and every append fans out a webhook delivery to every endpoint
 * (migration 0028), so looping on the download grows the ledger without
 * bound and floods integrators. `src/lib/rate-limit.ts` is in-memory per
 * instance, no brake at all on serverless, so the count is read from the
 * ledger itself — the one store every instance shares.
 */
export const EXPORT_LIMIT = { count: 5, windowMs: 10 * 60_000 };

/**
 * How many `ledger_exported` entries this person has caused in this
 * workspace within the window, capped at `EXPORT_LIMIT.count` — the caller
 * only needs to know whether the limit is reached, not the exact total.
 */
export async function recentExportsBy(userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - EXPORT_LIMIT.windowMs).toISOString();
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("id")
      .eq("action", "ledger_exported")
      .gt("ts", since)
      .eq("detail->>by", userId)
      .limit(EXPORT_LIMIT.count)
  ) as Array<{ id: string }>;
  return rows.length;
}

const CHUNK = 500;

/** The document as JSON text in chunks of entries, so a long chain is never one string (E4). */
export function* ledgerExportJsonChunks(doc: LedgerExport, entriesPerChunk = CHUNK): Generator<string> {
  const { entries, ...header } = doc;
  const head = JSON.stringify(header);
  yield `${head.slice(0, -1)},"entries":[`;
  for (let i = 0; i < entries.length; i += entriesPerChunk) {
    const part = entries.slice(i, i + entriesPerChunk).map((entry) => JSON.stringify(entry)).join(",");
    yield i === 0 ? part : `,${part}`;
  }
  yield "]}";
}

/**
 * A spreadsheet runs a cell that starts like a formula. A leading tab or
 * carriage return neutralises the cell outright, whatever follows it; a cell
 * that instead opens with `= + - @`, or opens with only whitespace and BOM
 * characters (some spreadsheet imports trim those before judging a cell a
 * formula) ahead of one of those four, is just as dangerous and is
 * neutralised too. Either way the `'` prefix goes at the very start of the
 * original text — the whitespace is never stripped, only looked past.
 */
const LEADING_WHITESPACE_OR_BOM = /^[\s﻿]*/;
const FORMULA_TRIGGER = /^[=+\-@]/;

function startsLikeFormula(text: string): boolean {
  if (text.startsWith("\t") || text.startsWith("\r")) return true;
  const afterLeading = text.slice(text.match(LEADING_WHITESPACE_OR_BOM)![0].length);
  return FORMULA_TRIGGER.test(afterLeading);
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : typeof value === "object" ? canonicalJson(value) : String(value);
  if (startsLikeFormula(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text.startsWith("'") ? `"${text.replace(/"/g, '""')}"` : text;
}

export function* ledgerExportCsvChunks(doc: LedgerExport, entriesPerChunk = CHUNK): Generator<string> {
  // A BOM first, so Excel on Windows — which guesses a CSV's encoding rather
  // than assuming UTF-8 — reads the accented and non-Latin text summaries can
  // carry correctly instead of as mojibake.
  yield `﻿${LEDGER_EXPORT_FIELDS.join(",")}\r\n`;
  for (let i = 0; i < doc.entries.length; i += entriesPerChunk) {
    yield doc.entries
      .slice(i, i + entriesPerChunk)
      .map((entry) => `${LEDGER_EXPORT_FIELDS.map((field) => csvCell(entry[field])).join(",")}\r\n`)
      .join("");
  }
}

export function exportFileName(slug: string, headSeq: number, format: "json" | "csv"): string {
  return `vestiarion-${slug}-ledger-${headSeq}.${format}`;
}
