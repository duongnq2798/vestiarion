import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_FORMATS, verifyEvidence, type EvidenceFormat, type EvidenceVerification } from "@vestiarion/sdk";
import { keyId, PEM_BLOCK, spkiPem } from "./ledger-export.js";

/**
 * Evidence files on disk (docs/superpowers/specs/2026-11-02-cli-evidence-close-pack-design.md): the names an export
 * saves them under, and checking one offline with the SDK's `verifyEvidence`, nothing added to it and nothing taken away.
 */

export type Document = Record<string, unknown> & { format: EvidenceFormat };
type Fields = Record<string, unknown>;

const CLOSE_PACK: EvidenceFormat = "vestiarion-close-pack/1";
const FORMAT_LIST = EVIDENCE_FORMATS.join(", ");

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Text that came from outside, such as a vendor's name, without the control characters a terminal acts on (CLI evidence CE8). */
export function plain(value: unknown): string {
  return text(value).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A slug cut as the server's file names cut it, so nothing from the document can reach a path (CE3). */
function safe(value: unknown, fallback: string): string {
  return text(value).replace(/[^a-z0-9-]/gi, "").slice(0, 40) || fallback;
}

/** The name the workspace's download gives the file; a receipt, which has no download, is named the same way (CE3). */
export function fileNameFor(document: Document): string {
  const workspace = isFields(document.workspace) ? document.workspace : {};
  const slug = safe(workspace.slug, "workspace");
  if (document.format === "vestiarion-evidence/1") {
    const subject = isFields(document.subject) ? document.subject : {};
    return `vestiarion-evidence-${safe(workspace.slug, "record")}-${safe(subject.kind, "record")}-${safe(text(subject.id).slice(0, 8), "record")}.json`;
  }
  if (document.format === "vestiarion-receipt/1") return `vestiarion-receipt-${slug}-${safe(text(document.invoiceId).slice(0, 8), "record")}.json`;
  if (document.format === "vestiarion-payee-lock-evidence/1") {
    const period = isFields(document.period) ? document.period : {};
    const day = (value: unknown, open: string) => (/^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : open);
    return `vestiarion-payee-lock-evidence-${slug}-${day(period.from, "all")}-${day(period.to, "now")}.json`;
  }
  const month = isFields(document.month) ? document.month : {};
  const key = /^\d{4}-\d{2}$/.test(text(month.key)) ? text(month.key) : "month";
  return `vestiarion-close-pack-${slug}-${key}${month.ended === false ? "-so-far" : ""}.json`;
}

/** "24.1 KB": a file's size, for a person. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The document's key ids, as it lists them. */
export function keyIdsOf(document: Fields): string[] {
  return (Array.isArray(document.keys) ? document.keys : []).filter(isFields).map((key) => plain(key.id)).filter(Boolean);
}

/** "2 payments, 2050.000000 USDC": a close pack's totals of one kind, per token. */
export function totalsLine(totals: unknown): string {
  const lines = (Array.isArray(totals) ? totals : []).filter(isFields).map((total) => {
    const payments = typeof total.payments === "number" ? total.payments : 0;
    return `${payments} payment${payments === 1 ? "" : "s"}, ${plain(total.amount)} ${plain(total.token)}`;
  });
  return lines.length > 0 ? lines.join("; ") : "none";
}

/** What a document is of, in a few words: the subject a check's first line names. */
export function describe(document: Document): string {
  const workspace = isFields(document.workspace) ? plain(document.workspace.slug) : "";
  const of = workspace ? ` (${workspace})` : "";
  if (document.format === "vestiarion-evidence/1") {
    const subject = isFields(document.subject) ? document.subject : {};
    const kind = subject.kind === "milestone" ? "milestone" : "bill";
    return `the evidence of ${kind} "${plain(subject.title)}"${of}`;
  }
  if (document.format === "vestiarion-receipt/1") return `the receipt of bill ${plain(document.invoiceId)}${of}`;
  if (document.format === "vestiarion-payee-lock-evidence/1") {
    const period = isFields(document.period) ? document.period : {};
    const from = plain(period.from);
    const to = plain(period.to);
    const span = !from && !to ? "all time" : `${from || "the first change"} to ${to || "now"}`;
    return `the payee lock's evidence for ${span}${of}`;
  }
  const month = isFields(document.month) ? document.month : {};
  return `the close pack of ${plain(month.label) || plain(month.key)}${month.ended === false ? " so far" : ""}${of}`;
}

export type Verdict = "valid" | "broken" | "not_checked";

export interface FileCheck {
  verdict: Verdict;
  /** What to print, the verdict first. */
  lines: string[];
  /** What `--json` prints. */
  answer: Record<string, unknown>;
}

/** A verdict reached before `verifyEvidence` could run: the file, or a key, could not be read. */
class NotChecked extends Error {}

function notChecked(reason: string): never {
  throw new NotChecked(reason);
}

/**
 * The file's document (CE6): UTF-8 with or without a byte-order mark, or UTF-16 with one, as Windows PowerShell 5.1's
 * `>` writes; and an API answer whose only field is `data` read as its data.
 */
function readDocument(cwd: string, file: string, expected: EvidenceFormat | undefined): { document: Document; unwrapped: boolean } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.resolve(cwd, file));
  } catch (error) {
    notChecked(`${file} could not be read (${(error as Error).message})`);
  }
  let source: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) source = bytes.subarray(2).toString("utf16le");
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) source = Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  else source = bytes.toString("utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    notChecked(`${file} could not be read as JSON (${(error as Error).message})`);
  }
  let unwrapped = false;
  if (isFields(parsed) && Object.keys(parsed).length === 1 && isFields(parsed.data)) {
    parsed = parsed.data;
    unwrapped = true;
  }
  const format = isFields(parsed) ? parsed.format : undefined;
  if (!(EVIDENCE_FORMATS as readonly unknown[]).includes(format)) {
    notChecked(`${file} is not a Vestiarion evidence file: its format is not one of ${FORMAT_LIST}`);
  }
  if (expected !== undefined && format !== expected) notChecked(`${file} is a ${String(format)} file, not a close pack (${expected})`);
  return { document: parsed as Document, unwrapped };
}

/**
 * The keys from each `--public-key` file, filed under their ids (CE6). A private key and a key that is not Ed25519 are
 * refused: Node derives a public key from a private one, and only an Ed25519 key can have signed an entry.
 */
function readKeys(cwd: string, files: string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(path.resolve(cwd, file), "utf8");
    } catch (error) {
      notChecked(`${file} could not be read (${(error as Error).message})`);
    }
    const blocks = source.match(PEM_BLOCK);
    if (!blocks || blocks.length === 0) notChecked(`${file} holds no PEM key block`);
    for (const block of blocks) {
      if (block.includes("PRIVATE KEY")) notChecked(`${file} holds a private key; pass the public key instead`);
      let key: ReturnType<typeof createPublicKey>;
      try {
        key = createPublicKey(block);
      } catch (error) {
        notChecked(`a public key in ${file} could not be read (${(error as Error).message})`);
      }
      if (key.asymmetricKeyType !== "ed25519") notChecked(`${file} holds a ${key.asymmetricKeyType ?? "non-Ed25519"} key; the ledger's keys are Ed25519`);
      keys[keyId(key)] = spkiPem(key);
    }
  }
  return keys;
}

const WORDS: Record<Verdict, string> = { valid: "VALID", broken: "BROKEN", not_checked: "NOT CHECKED" };
const LIMITS =
  "Not checked offline: whether the words follow from the entries, whether the file carries every entry of its period, and anything on chain.";

/**
 * Checks one evidence file offline (CE6, CE7). Paths are read from `cwd` and named as given. `expected` pins the format,
 * as `close-pack verify` does.
 */
export async function checkEvidenceFile(cwd: string, file: string, pins: string[], expected?: EvidenceFormat): Promise<FileCheck> {
  let document: Document;
  let unwrapped: boolean;
  let keys: Record<string, string> | undefined;
  try {
    ({ document, unwrapped } = readDocument(cwd, file, expected));
    if (pins.length > 0) keys = readKeys(cwd, pins);
  } catch (error) {
    if (!(error instanceof NotChecked)) throw error;
    return { verdict: "not_checked", lines: [`NOT CHECKED: ${error.message}`], answer: { verdict: "not_checked", file, reason: error.message } };
  }

  let result: EvidenceVerification;
  try {
    result = await verifyEvidence(document, keys ? { keys, format: document.format } : { format: document.format });
  } catch (error) {
    // verifyEvidence throws a TypeError for what is not a document of its format; the file has been read as one, so this is rare.
    const reason = `${file} could not be checked (${(error as Error).message})`;
    return { verdict: "not_checked", lines: [`NOT CHECKED: ${reason}`], answer: { verdict: "not_checked", file, reason } };
  }

  const verdict: Verdict = result.ok === true ? "valid" : result.ok === false ? "broken" : "not_checked";
  const keyIds = keys ? Object.keys(keys) : keyIdsOf(document);
  const keySource = keys ? "--public-key" : "file";
  const { counts } = result;
  const lines = [
    `${WORDS[verdict]}: ${describe(document)}`,
    `Entries: ${counts.carried} carried, ${counts.verified} verified, ${counts.failed} failed, ${counts.unchecked} not checked; ${counts.cited} cited`,
    `Key id${keyIds.length === 1 ? "" : "s"}: ${keyIds.join(", ") || "none"} (${keys ? "from --public-key" : "from the file itself"})`,
  ];
  if (unwrapped) lines.push("The file is an API answer: its data was checked.");
  if (document.format === CLOSE_PACK) {
    const totals = isFields(document.totals) ? document.totals : {};
    lines.push(`Payments on chain: ${totalsLine(totals.onChain)}`);
    const head = isFields(document.ledgerHead) ? document.ledgerHead : null;
    lines.push(
      head
        ? `Ledger head when read: #${plain(String(head.seq))} ${plain(head.hash)}. To show the pack leaves no entry out, compare its entries' seq and hash with an audit export checked by \`vestiarion ledger verify\`.`
        : "Ledger head when read: none, the ledger was empty."
    );
  }
  for (const problem of result.problems) lines.push(`- ${plain(problem)}`);
  lines.push(LIMITS);
  return { verdict, lines, answer: { verdict, file, unwrapped, keySource, keyIds, ...result } };
}

/** Where a file goes, from `--out` or the download's name, relative to `cwd`; `-` is stdout. */
export function outputPath(cwd: string, out: string | undefined, document?: Document): string {
  if (out === "-") return "-";
  if (out !== undefined) return path.resolve(cwd, out);
  return path.join(cwd, fileNameFor(document as Document));
}
