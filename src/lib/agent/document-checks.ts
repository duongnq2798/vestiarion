import crypto from "node:crypto";
import { missingDetails } from "../added-details";
import { currentOrgId } from "../context";
import { platformDb, platformStorage, unwrap, type OrgDb } from "../dal";
import {
  checkReasonOf,
  compareDocument,
  SKIPPED_REASONS,
  UNREADABLE_REASONS,
  type DocumentCheck,
  type DocumentComparison,
} from "../document-requests/check";
import { missingDocuments, readerNoteWords, sniffDocumentType, type MissingDocument } from "../document-requests/rules";
import { readDocumentRequestsSetting } from "../document-requests/setting";
import { extractInvoice } from "../invoice-document/extract";
import { oneParseAtATime, PdfWorkerRefusal, type PdfLimits } from "../invoice-document/pdf-worker";
import { DocumentReadError, MAX_DOCUMENT_BYTES, readPdfBounded, type ReadDocument } from "../invoice-document/read";
import { appendLedgerEntry } from "../ledger";
import { ID_CHUNK } from "../new-payee-facts";
import { takeDocumentReadToken } from "../rate-limit";
import type { DecisionMode } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * Checking a vendor's document against its bill (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md):
 * the cycle's `document_checks` stage, after `compliance` and before `follow_up` (DK2), and the AP stage's read of the
 * bills whose purchase order came from a vendor's document (DK8).
 *
 * The stage takes the answered requests not checked yet, oldest answer first, at most 5 a cycle, while vendor requests
 * are in shadow or on and the agent is not paused (DK1, DK2). For each: a bill that no longer waits for a document, or a
 * file already compared for it outside shadow, is skipped with no read; an image, a file over 4 MB as its row records it,
 * one not kept where its row says, gone from storage, whose hash is not the one received, a scan or a PDF that cannot be
 * read, is unreadable, and no model reads it (DK3). So is a PDF the pre-scan refuses (its streams would decode past
 * 16 MB, or cannot be measured), one the worker stops by the file's own doing, and one whose reads, on any request of
 * the workspace with that file, began twice and never finished. A stop that may not be the file's doing (the process's
 * memory, a timeout while another PDF was read in this process) records nothing: the next cycle reads it again, and the
 * read stays counted. The rest is read through `readPdfBounded` and, one read token each, `extractInvoice`, which shows
 * the model the document alone; code compares (`compareDocument`, DK4, DK5).
 *
 * 0144's check_document_request records each check once (DK12). With vendor requests on, a match for a bill that lacks
 * its purchase order adds it, compare-and-set on the bill still waiting with none and no payment, and the follow-up and
 * AP stages after it decide the bill again in this cycle, where `invoice.vendor_document` holds it for a person (DK7,
 * DK8). It never marks goods received (DK6), and writes nothing else on any bill. In shadow it writes nothing (DK10).
 * Each check is signed as `document_checked`, with the file's hash and the values compared: never the document's text,
 * the vendor's note or an email address. A document the model flagged carries its note, cleaned and quoted as the
 * reader's (`readerNote`, and after the sentence of `reason` and 0144's `check_reason`; DK4, amended 2026-10-26), in
 * shadow too, so a person can see what it saw. A mismatch also carries its sentence whole (`sentence`), which the summary
 * and the decision trail give where `reason` says it shortly to fit the note. A request a vendor answered before 0144
 * ran waits unchecked, like any new one, and the first cycle after it checks it. Before 0144, nothing (DK15).
 */

/** The most documents one cycle checks (DK2). */
export const DOCUMENT_CHECKS_PER_CYCLE = 5;

/** Postgres's or PostgREST's "no such table, column or function": migration 0144 has not run here yet (DK15). */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

/** A bill's purchase order came from this request's document, which code checked against the bill (DK7, DK8). */
export interface VendorDocument {
  requestId: string;
  /** Who sent the document: the vendor, through its link, or a member, who attached it. */
  source: "vendor" | "member";
  fileSha256: string | null;
}

/**
 * The payables among `payableIds` whose purchase order a vendor's document wrote (DK8): the request whose
 * `po_written` 0144's check_document_request set, the newest when there are more. Read once per AP stage, before
 * anything is decided. None before migration 0144, which is safe: nothing can have been written then. Any other
 * failure throws, so the stage stops rather than pays past it.
 */
export async function vendorDocumentsOf(orgDb: Pick<OrgDb, "from">, payableIds: readonly string[]): Promise<Map<string, VendorDocument>> {
  const found = new Map<string, VendorDocument>();
  for (let start = 0; start < payableIds.length; start += ID_CHUNK) {
    const read = await orgDb
      .from("document_requests")
      .select("id, invoice_id, source, file_sha256")
      .in("invoice_id", payableIds.slice(start, start + ID_CHUNK))
      .eq("po_written", true)
      .order("checked_at", { ascending: false });
    if (read.error) {
      if (beforeMigration(read.error)) return new Map();
      throw new Error(`the bills' vendor documents could not be read: ${read.error.message}`);
    }
    for (const row of (read.data ?? []) as unknown as Array<{ id: string; invoice_id: string; source: string | null; file_sha256: string | null }>) {
      if (found.has(row.invoice_id)) continue;
      found.set(row.invoice_id, { requestId: row.id, source: row.source === "member" ? "member" : "vendor", fileSha256: row.file_sha256 });
    }
  }
  return found;
}

interface WaitingRow {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  po_reference: string | null;
  file_path: string | null;
  file_sha256: string | null;
  file_type: string | null;
  file_size: number | string | null;
  source?: string | null;
}

interface BillRow {
  id: string;
  direction: string;
  status: string;
  amount: string | number;
  currency: string | null;
  memo: string | null;
  po_reference: string | null;
  goods_received: boolean | null;
  counterparty_id: string;
  counterparties: { name: string; notice_email: string | null; address: string | null; purchase_order_required?: boolean | null } | null;
}

/** How a check ended, as 0144 records it and `document_checked` signs it. */
type Outcome = "matched" | "mismatched" | "unreadable" | "skipped";

/** What the stage found for one request, before 0144 records it. */
interface Finding {
  outcome: Outcome;
  reason: string | null;
  reader: DecisionMode | null;
  checks: DocumentCheck[];
  comparison: DocumentComparison | null;
  truncated: boolean;
}

const unreadable = (reason: string): Finding => ({ outcome: "unreadable", reason, reader: null, checks: [], comparison: null, truncated: false });
const skipped = (reason: string): Finding => ({ outcome: "skipped", reason, reader: null, checks: [], comparison: null, truncated: false });

/** A Storage error that says the file is not there, rather than that Storage could not be asked. */
function fileGone(error: { message?: string; statusCode?: string | number; status?: number }): boolean {
  return /not.?found/i.test(error.message ?? "") || String(error.statusCode ?? "") === "404" || error.status === 404;
}

/** Reads of a file begun that never finished, after which it is unreadable and not parsed again (DK3). */
export const UNFINISHED_PARSES = 2;

/** A read stopped for a reason that may not be the file's: nothing is recorded, and the next cycle reads it again. */
interface Retry {
  retry: true;
}

/**
 * The document's text and both readings (DK3, DK4), or why there are none: the file is read from where its row says it is
 * kept, under the request's own folder, and only when it is the file received. Null when no read token is left, so the
 * request waits for the next cycle. A Storage failure other than a missing file throws, so the next cycle tries again.
 */
async function readKept(
  row: WaitingRow,
  input: { orgId: string; today: string; allowRead: () => boolean; pdfLimits?: Partial<PdfLimits> }
): Promise<Finding | Retry | { text: string; truncated: boolean; extracted: Awaited<ReturnType<typeof extractInvoice>> } | null> {
  // The kind and the size the row records, before anything is downloaded: an image of 10 MB is never fetched.
  if (row.file_type !== "application/pdf") return unreadable(UNREADABLE_REASONS.image);
  if (Number(row.file_size) > MAX_DOCUMENT_BYTES) return unreadable(UNREADABLE_REASONS.too_large);
  const kept = `${input.orgId}/document-requests/${row.id}/${row.file_sha256}`;
  if (!row.file_sha256 || row.file_path !== kept) return unreadable(UNREADABLE_REASONS.changed);

  const download = await platformStorage().download(kept);
  if (download.error || !download.data) {
    if (download.error && !fileGone(download.error as Parameters<typeof fileGone>[0])) throw new Error(`a document could not be read from storage: ${download.error.message}`);
    return unreadable(UNREADABLE_REASONS.gone);
  }
  const bytes = new Uint8Array(await download.data.arrayBuffer());
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return unreadable(UNREADABLE_REASONS.too_large);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.file_sha256) return unreadable(UNREADABLE_REASONS.changed);
  // By its first bytes, never its name: only a PDF reaches the PDF reader.
  const kind = sniffDocumentType(bytes);
  if (kind === "image/png" || kind === "image/jpeg") return unreadable(UNREADABLE_REASONS.image);
  if (kind !== "application/pdf") return unreadable(UNREADABLE_REASONS.unreadable);

  const parsed = await oneParseAtATime(() => parseCounted(row, bytes, input));
  if (!("document" in parsed)) return parsed;
  const document = parsed.document;
  // One read token per model read (DK2): with none left, the rest wait for the next cycle.
  if (!input.allowRead()) return null;
  return { text: document.text, truncated: document.truncated, extracted: await extractInvoice(document.text, input.today) };
}

/**
 * The file parsed, counted (DK3), in one turn of `oneParseAtATime`: one parse at a time in this process, whichever
 * workspace's cycle asks, so a run that dies mid-parse leaves one read unfinished, the one that was running.
 *
 * Each read is counted before pdf.js parses (0144's start_document_parse), which answers how many reads of the same file,
 * on any request of the workspace, began and never finished. A parse that ends, whatever it found, clears them all
 * (finish_document_parse); so does a reader that could not start, which throws, and the next cycle tries again. A stop
 * that may not be the file's doing (`PdfWorkerRefusal` with `retry`) is not cleared: like a run that never came back, it
 * counts. After two, the file is unreadable with no third parse, however often it is sent or attached again. Before
 * 0144's functions, it parses with nothing counted.
 */
async function parseCounted(
  row: WaitingRow,
  bytes: Uint8Array,
  input: { orgId: string; pdfLimits?: Partial<PdfLimits> }
): Promise<Finding | Retry | { document: ReadDocument }> {
  const parse = { p_org_id: input.orgId, p_id: row.id };
  const started = await platformDb().rpc("start_document_parse", parse);
  if (started.error && !beforeMigration(started.error)) throw new Error(`a document's read could not be counted: ${started.error.message}`);
  const counted = !started.error;
  // Checked elsewhere since this cycle read it: its record answers so, and nothing is signed.
  if (counted && started.data === null) return skipped(SKIPPED_REASONS.not_waiting);
  if (counted && Number(started.data) >= UNFINISHED_PARSES) return unreadable(UNREADABLE_REASONS.unreadable);
  let ended = true;
  try {
    return { document: await readPdfBounded(bytes, input.pdfLimits) };
  } catch (error) {
    if (error instanceof PdfWorkerRefusal && error.retry) {
      ended = false;
      return { retry: true };
    }
    if (!(error instanceof DocumentReadError)) throw error;
    return unreadable(error.code === "scan" ? UNREADABLE_REASONS.scan : error.code === "too_large" ? UNREADABLE_REASONS.too_large : UNREADABLE_REASONS.unreadable);
  } finally {
    // The parse ended, whatever it found. Best effort: a count left behind costs the file one of its two tries.
    if (counted && ended) {
      const finished = await platformDb().rpc("finish_document_parse", parse);
      if (finished.error) console.error(`[document_checks] a document's read could not be marked finished: ${finished.error.message}`);
    }
  }
}

/** "invoice INV-2207", or "their invoice" for a bill with no number. */
function invoiceWords(bill: BillRow | undefined): string {
  return bill?.memo?.trim() ? `invoice ${bill.memo.trim()}` : "their invoice";
}

/** What the vendor, the amount and the purchase order did, in a few words: "vendor, amount and purchase order PO-1042 match". */
function matchedWords(comparison: DocumentComparison): string {
  return comparison.poCompared && comparison.poReference ? `vendor, amount and purchase order ${comparison.poReference} match` : "vendor and amount match";
}

const withoutPeriod = (sentence: string) => sentence.replace(/\.$/, "");
/** A skip's reason after its "It was not checked: ". */
const skipWords = (reason: string) => withoutPeriod(reason.replace(/^It was not checked: /, ""));

/** The entry's summary and the cycle's line, for one recorded check. */
function wordsFor(finding: Finding, written: boolean, shadow: boolean, vendor: string, bill: BillRow | undefined): { summary: string; line: string } {
  const invoice = invoiceWords(bill);
  const reason = finding.reason ?? "";
  switch (finding.outcome) {
    case "matched": {
      const words = matchedWords(finding.comparison as DocumentComparison);
      if (written) {
        return {
          summary: `Checked ${vendor}'s document for ${invoice}: ${words}; added the purchase order, for a person to approve`,
          line: `Checked ${vendor}'s document: ${words}; added the purchase order, and a person approves the payment`,
        };
      }
      if (shadow) {
        return {
          summary: `Checked ${vendor}'s document for ${invoice}: it matches; vendor requests are in shadow, so the bill was left as it is`,
          line: `Checked ${vendor}'s document: it matches; vendor requests are in shadow, so the bill was left as it is`,
        };
      }
      return { summary: `Checked ${vendor}'s document for ${invoice}: ${words}`, line: `Checked ${vendor}'s document: ${words}` };
    }
    case "mismatched": {
      // The whole sentence, naming the purchase orders the reason may say shortly to fit the note in 300 characters, then
      // the whole note: neither the summary nor the line is held to 300.
      const comparison = finding.comparison;
      const said = comparison?.sentence
        ? `${comparison.sentence}${comparison.readerNote ? ` ${readerNoteWords(comparison.readerNote)}` : ""}`
        : reason;
      return { summary: `Checked ${vendor}'s document for ${invoice}: ${withoutPeriod(said)}`, line: `Checked ${vendor}'s document: ${withoutPeriod(said)}` };
    }
    case "unreadable":
      return { summary: `Could not check ${vendor}'s document for ${invoice}: ${reason}`, line: `Could not check ${vendor}'s document: ${reason}` };
    case "skipped":
      return { summary: `Did not check ${vendor}'s document for ${invoice}: ${skipWords(reason)}`, line: `Did not check ${vendor}'s document: ${skipWords(reason)}` };
  }
}

/**
 * The stage: see the module comment. `allowRead` stands in for the workspace's read tokens in tests, `pdfLimits` for the
 * PDF reader's limits, and `now` for the clock.
 */
export async function checkReceivedDocuments(
  orgDb: OrgDb,
  options: { now?: number; allowRead?: () => boolean; pdfLimits?: Partial<PdfLimits> } = {}
): Promise<CycleLogLine[]> {
  const { setting, ready } = await readDocumentRequestsSetting(orgDb);
  // Off, documents wait unchecked; they are checked once it is shadow or on again, while their bill still waits (DK1).
  if (!ready || setting === "off") return [];
  if (await agentPaused()) return [];
  const orgId = currentOrgId();
  const shadow = setting === "shadow";
  const now = options.now ?? Date.now();
  const allowRead = options.allowRead ?? (() => takeDocumentReadToken(orgId, now));
  const today = new Date(now).toISOString().slice(0, 10);

  const waitingRead = await orgDb
    .from("document_requests")
    .select("id, invoice_id, counterparty_id, po_reference, file_path, file_sha256, file_type, file_size, source")
    .eq("status", "answered")
    .is("checked_at", null)
    .order("answered_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(DOCUMENT_CHECKS_PER_CYCLE);
  if (waitingRead.error) {
    if (beforeMigration(waitingRead.error)) return [];
    throw new Error(`the documents waiting to be checked could not be read: ${waitingRead.error.message}`);
  }
  const waiting = (waitingRead.data ?? []) as unknown as WaitingRow[];
  if (waiting.length === 0) return [];

  const invoiceIds = [...new Set(waiting.map((row) => row.invoice_id))];
  const bills = new Map(
    (
      unwrap(
        await orgDb
          .from("invoices")
          .select("id, direction, status, amount, currency, memo, po_reference, goods_received, counterparty_id, counterparties(name, notice_email, address, purchase_order_required)")
          .in("id", invoiceIds)
      ) as unknown as BillRow[]
    ).map((row) => [row.id, row])
  );
  // The files each bill had compared outside shadow, matched or mismatched (DK10, DK12): the same file is not read
  // again. One skipped or unreadable was never compared, so the same bytes sent or attached again are read.
  const checkedRead = await orgDb
    .from("document_requests")
    .select("id, invoice_id, file_sha256, check_shadow, check_outcome")
    .in("invoice_id", invoiceIds)
    .not("checked_at", "is", null);
  if (checkedRead.error) {
    if (beforeMigration(checkedRead.error)) return [];
    throw new Error(`the documents already checked could not be read: ${checkedRead.error.message}`);
  }
  const checkedFiles = new Map<string, Set<string>>();
  const markChecked = (invoiceId: string, fileSha: string | null) => {
    if (!fileSha) return;
    const files = checkedFiles.get(invoiceId) ?? new Set<string>();
    files.add(fileSha);
    checkedFiles.set(invoiceId, files);
  };
  const compared = (outcome: string | null | undefined) => outcome === "matched" || outcome === "mismatched";
  for (const row of (checkedRead.data ?? []) as unknown as Array<{ invoice_id: string; file_sha256: string | null; check_shadow: boolean | null; check_outcome: string | null }>) {
    if (row.check_shadow !== true && compared(row.check_outcome)) markChecked(row.invoice_id, row.file_sha256);
  }

  const lines: CycleLogLine[] = [];
  for (const row of waiting) {
    const bill = bills.get(row.invoice_id);
    const vendor = bill?.counterparties?.name ?? "The vendor";
    const lacks: MissingDocument[] =
      bill && bill.direction === "payable" && bill.status === "awaiting_info"
        ? missingDocuments(
            missingDetails({
              poReference: bill.po_reference,
              goodsReceived: bill.goods_received === true,
              purchaseOrderRequired: bill.counterparties?.purchase_order_required !== false,
            })
          )
        : [];

    let finding: Finding;
    if (!bill || lacks.length === 0) finding = skipped(SKIPPED_REASONS.not_waiting);
    else if (row.file_sha256 && checkedFiles.get(row.invoice_id)?.has(row.file_sha256)) finding = skipped(SKIPPED_REASONS.same_file);
    else {
      const read = await readKept(row, { orgId, today, allowRead, pdfLimits: options.pdfLimits });
      if (read === null) break;
      if ("retry" in read) {
        lines.push({ domain: "ap", message: `Stopped reading ${vendor}'s document before it finished; the next cycle reads it again` });
        continue;
      }
      if ("outcome" in read) finding = read;
      else {
        const counterparty = bill.counterparties;
        const comparison = compareDocument(
          {
            vendorName: counterparty?.name ?? "",
            billingEmail: counterparty?.notice_email ?? null,
            amount: bill.amount,
            currency: bill.currency === "EURC" ? "EURC" : "USDC",
            memo: bill.memo,
            poReference: bill.po_reference,
            purchaseOrderRequired: counterparty?.purchase_order_required !== false,
            addressOnFile: counterparty?.address ?? null,
          },
          { text: read.text, raw: read.extracted.raw, reference: read.extracted.reference, typedPo: row.po_reference }
        );
        finding = {
          outcome: comparison.outcome,
          reason: comparison.reason,
          reader: read.extracted.reader,
          checks: comparison.checks,
          comparison,
          truncated: read.truncated,
        };
      }
    }

    // With vendor requests on, a match adds the purchase order the bill lacks, as the document writes it (DK7).
    const documentPo = finding.comparison?.poReference ?? null;
    const writePo = !shadow && finding.outcome === "matched" && lacks.includes("purchase_order") && documentPo !== null;
    const record = (outcome: Outcome, reason: string | null, write: boolean) =>
      platformDb().rpc("check_document_request", {
        p_org_id: orgId,
        p_id: row.id,
        p_file_sha256: row.file_sha256,
        p_outcome: outcome,
        p_reason: reason === null ? null : checkReasonOf(reason),
        p_shadow: shadow,
        p_document_po: documentPo,
        p_write_po: write,
      });
    let done = await record(finding.outcome, finding.reason, writePo);
    // The bill changed between its read and the write: nothing was written, and the check is recorded as skipped.
    if (!done.error && done.data === "bill_moved") {
      finding = { ...finding, outcome: "skipped", reason: SKIPPED_REASONS.bill_moved };
      done = await record("skipped", SKIPPED_REASONS.bill_moved, false);
    }
    if (done.error) {
      if (beforeMigration(done.error)) return lines;
      throw new Error(`a document's check could not be recorded: ${done.error.message}`);
    }
    // Another cycle or instance checked it first: it signs nothing.
    if (done.data !== "written" && done.data !== "checked") continue;
    const written = done.data === "written";
    if (!shadow && compared(finding.outcome)) markChecked(row.invoice_id, row.file_sha256);
    if (written && bill) bill.po_reference = documentPo;

    const words = wordsFor(finding, written, shadow, vendor, bill);
    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: "document_checked",
      summary: words.summary,
      // The values compared and the file's hash: never the document's text, the vendor's note, an email address or a
      // link. The model's note, cleaned (`readerNoteOf`: no link, email address or token), only when it flagged the
      // document. No `observed`: the follow-up keeps reading the bill's facts from its last decision.
      detail: {
        invoiceId: row.invoice_id,
        counterpartyId: row.counterparty_id,
        requestId: row.id,
        source: row.source === "member" ? "member" : "vendor",
        fileSha256: row.file_sha256,
        fileType: row.file_type,
        fileSize: row.file_size === null ? null : Number(row.file_size),
        // What the bill lacked when checked; nothing for a bill that no longer waits.
        missing: lacks,
        outcome: finding.outcome,
        reason: finding.reason,
        // A mismatch's sentence whole, which the reason may say shortly to fit the reader's note.
        ...(finding.outcome === "mismatched" && finding.comparison?.sentence ? { sentence: finding.comparison.sentence } : {}),
        reader: finding.reader,
        checks: finding.checks,
        ...(documentPo ? { poReference: documentPo } : {}),
        poWritten: written,
        ...(finding.comparison?.readerFlagged
          ? { readerFlagged: true, ...(finding.comparison.readerNote ? { readerNote: finding.comparison.readerNote } : {}) }
          : {}),
        ...(finding.truncated ? { truncated: true } : {}),
        ...(shadow ? { shadow: true } : {}),
      },
    });
    lines.push({ domain: "ap", message: words.line });
  }
  return lines;
}
