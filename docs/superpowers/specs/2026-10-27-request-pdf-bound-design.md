# Read unmeasurable PDFs in the bounded reader

Date: 2026-10-27. Status: accepted. Updates docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md
(DK3's paragraph on `readDocument`, its out-of-scope notes and its pre-scan tests).

## Why

Every PDF someone sends in to be read goes through `readDocument` (`src/lib/invoice-document/read.ts`): From a
document, invoices by email, the Chrome extension, Telegram and Slack (all through `readInvoiceDraft` or
`readInvoiceDocument`), and the payee link's optional file (`submitPayeeInvoice`). Inbound email is open to any sender
to the workspace's address; the payee link needs a live link that asks for an invoice.

DK3 gave `readDocument` the pre-scan in a lenient mode: it refused a file only when it measured its streams past 16 MB
decoded, and left everything it could not measure to pdf.js, on the thread that asked, with no time or memory bound.
What it could not measure was easy to reach:
- any stream whose filter chain names LZW, run-length, Brotli or an image codec, even after a FlateDecode stage, so a
  Flate bomb before an LZW stage was never measured;
- a filter kept in an object the scan cannot find;
- one `/Encrypt` key in the trailer, in any stream's dictionary (which pdf.js ignores), or in a fake
  `trailer << /Encrypt 1 0 R >>` inside a comment or stream data, since the word `trailer` is matched anywhere in the
  file;
- more than 10,000 streams, or more than 64 MB of scan work.

The lenient scan skipped a stream whose filter it could not measure and measured the others, but stopped at an
`/Encrypt` key before measuring anything, and at too many streams or too much work wherever it was. Unless another of
its streams measured past the budget, each such file reached pdf.js on the request thread. pdf.js decodes each stream
into an ArrayBuffer outside any heap limit (a 0.5 MB deflated PDF took a process from 107 MB to 1.25 GB), and a request
function may also be running a cycle it started after its answer (`runCycleSoon`), so one such file could end the
instance with payments in flight. The cycle's own path (`readPdfBounded`) already refuses or bounds all of these.

## What

**RB1. The strict pre-scan decides where a sent PDF is read.** `pdfText` runs `prescanPdf` (now one mode, RB6) and
branches on why it refused:
- `decoded_limit`: refused as before, "This PDF could not be read. Paste the invoice's text instead.", before pdf.js or
  any worker sees it, whatever else in the file the pre-scan cannot measure (RB6);
- nothing (every stream measured, under budget): parsed on the thread that asks, as before (`countedParse` around
  unpdf's `extractText`). Every PDF fixture and caller test reads this way, unchanged, and read.ts keeps its static
  unpdf import, which is what carries unpdf into each function that reads PDFs (`serverExternalPackages`);
- `unbounded_filter`, `encrypted` or `too_complex`: read in a worker (RB2).

**RB2. A file the pre-scan cannot measure is read in the worker.** `pdfPagesInWorker` with `REQUEST_PDF_LIMITS`
(`src/lib/invoice-document/pdf-worker.ts`): the cycle's `PDF_LIMITS` (15 s, 50 pages, a heap of 256 MB old and 32 MB
young) with half its memory budget, 256 MB of the process's resident memory rather than 512. Where a request's worker
and a cycle's share a process, the request's stops first, so a stranger's file does not spend one of a vendor
document's two tries (DK3's `UNFINISHED_PARSES`). Its pages are merged and cut as `readPdfBounded` merges them
(`mergedPages`, `truncated` when pages were left unread past 20,000 characters), so the text is the one pdf.js gives on
the thread. The call is:
- not wrapped in `countedParse`, which counts a parse that holds this thread: a worker never holds it, and counting it
  would make the worker's own timeout look like another read's (RB4);
- not queued behind the cycle's parses (`oneParseAtATime`): a person never waits behind up to five 15 s cycle reads;
- never retried by itself: the person who sent it decides (RB3).

Such a file now meets the worker's limits where it had none: one of more than 50 pages, or that pdf.js cannot read
within 15 s, is not read. Encrypted invoices that open without a password (owner-password restrictions only, common
from invoicing tools) are read to the same text as before, a little slower, since a worker starts for each.

**RB3. What a sent file's worker read says.**
- A timeout while another PDF was read in this process (`PdfWorkerRefusal` `timeout` with `retry`, RB4) may not be the
  file's: a plain `Error`, so each caller answers as it does any failure that is not the file's: "The invoice could not
  be read. Try again in a moment." (From a document, Telegram, Slack), "The invoice could not be read. Forward it again
  in a moment." (email), "That did not work. Try again in a moment." (the payee link), and the extension API's
  `internal` error.
- Any other stop is the file's: too many pages, its own time alone, its own heap or the process's memory budget, a
  parse error, a worker that stopped once running. It is the existing `DocumentReadError("unsupported")` with "This
  PDF could not be read. Paste the invoice's text instead.", which each caller already words for its screen. A memory
  stop is final here, unlike the cycle's retry: a person sending a bomb again gets the same stop.
- A worker that could not start or load unpdf is the plain `Error` `pdfPagesInWorker` threw, rethrown as it is.
Only the on-thread parse's own errors are turned into `DocumentReadError` there, as before.

**RB4. A worker's timeout counts every other PDF read in the process.** `pdf-worker.ts` counts PDF reads running and
begun in the process: parses on this thread (`countedParse`) and every worker, the cycle's and a request's. A worker's
timeout is tried again (`retry`) when another read was running when it started, is still running, or began meanwhile;
its own read is never counted against it. So a cycle worker that times out while a request's worker ran is read again
next cycle, still counted (DK3), and a request worker that times out while the cycle's ran says to try again (RB3). A
timeout with nothing else read meanwhile stays the file's, as before.

**RB5. An email's PDFs, one at a time, at most three.** `emailText` reads the PDFs attached to an `.eml` one after
another, not all at once, and only the first three (`MAX_EMAIL_PDFS`): each may start a worker, and workers share one
process's memory budget. Later PDFs are left out, as the 20,000-character cap would mostly cut them anyway. A PDF that
could not be read is left out as before and the message's own text still read; a read stopped for a reason that may not
be the file's (RB3) fails the whole read, so the person tries again rather than getting a draft without its invoice.
When an attachment's pages were left unread past 20,000 characters, the email reads as `truncated`.

**RB6. One pre-scan mode, in which a file past the budget is refused as that.** `prescanPdf(bytes, { limits? })` has no
lenient mode left: nothing in `src` used it once `readDocument` scans strictly, and keeping it would let a later caller
reopen the gap. Its tests that pinned lenient results go with it. A stream whose filter it cannot measure is skipped and
the others are still measured, as the lenient mode did; an encrypted file's streams are measured too, as written, though
pdf.js would decrypt them first, which can only find a bomb, never let a file through. Only once every other stream is
measured under the budget is the file refused as `unbounded_filter` or `encrypted`. So `decoded_limit` comes first: an
LZW stream before a bomb, an `/Encrypt` key on a stream's dictionary or in a fake trailer inside a comment beside one,
is refused before any reader opens the file, wherever it sits in the file. Too many streams or too much work
(`too_complex`) still stops the scan at once. The cycle refuses every reason, so what it does is unchanged.

**RB7. Docs.** CHANGELOG [Unreleased]'s entry on PDFs built to expand (which named neither the payee link nor the
files the pre-scan cannot measure) is amended in place; ARCHITECTURE.md's parse paragraph says where each sent PDF is
read; first-payment.mdx's line on PDFs that are not read names 50 pages and 15 s for those the quick check cannot
measure, and that an `.eml` is read with its first three PDFs; the part 2 spec's DK3 paragraph, out-of-scope notes and
pre-scan tests are updated to point here.

## Out of scope

- A time bound for measured PDFs on the request thread. A nested-forms PDF of under 4 KB passes the pre-scan, so it is
  still parsed on the thread that asks (about 95 s on unpdf 1.8.1). Reading every sent PDF in the worker closes that
  too, but removes read.ts's only static unpdf import: it needs `outputFileTracingIncludes` for unpdf on each route
  that reads PDFs and a check on a preview deployment. A follow-up.
- Measuring LZW, run-length or Brotli in the pre-scan. Fewer files would need the worker, but encrypted files, image
  codecs on text streams and filters in objects it cannot find would still be unmeasurable.
- The payee link's wording for a PDF that could not be read ("Choose a PDF or a text file."), unchanged here.

## Risks

- Request functions start the worker for the first time. Its script loads unpdf with `import("unpdf")` from
  `node_modules`, which the cycle's function is known to carry. The functions that read sent PDFs (the From a document
  and payee link server actions, inbound email, Telegram, Slack, the extension's draft route) import read.ts, which
  imports unpdf statically, so each traces it the same way; if one did not, an unmeasurable PDF there would be a plain
  "try again" error, not a crash. To check on a preview deployment before release: read an LZW or encrypted PDF
  through From a document.
- A request's worker and the cycle's share the process's memory budget, measured from each worker's start. The lower
  request budget makes the request's stop first in the usual case, not in every case.
- A bomb the pre-scan cannot measure still reaches the request's worker: one behind a FlateDecode stage chained to LZW,
  or among more than 10,000 streams. The worker decodes it until its 256 MB budget stops it, and the person is told
  the PDF could not be read. Before, such a file was read on the thread that asked, with no bound.

## Tests (write first)

**`tests/invoice-document-request-pdf.test.ts`** (`readDocument` with the worker and pdf.js on this thread watched;
a test may answer for the worker):
- RB1, RB6: Northwind's invoice is parsed on this thread with no worker. A 600 MB bomb is refused with neither, alone,
  after an LZW stream, or beside a fake trailer in a comment.
- RB2: a page whose text is LZW-encoded goes to the worker with `REQUEST_PDF_LIMITS` (256 MB of memory, the rest
  `PDF_LIMITS`) and 20,000 characters, never to pdf.js on this thread, and reads to the text of the same page
  unencoded (the real worker). So does each other file the pre-scan cannot measure: run-length, Brotli, Flate before
  LZW, an LZW stream no page draws, an LZW stream before one measured under the budget, an encrypted file, `/Encrypt`
  on a stream's dictionary, and more than 10,000 streams. A read does not wait for a turn of the cycle's queue, and
  the real worker's own timeout through it is the file's, so it was not counted as a parse on this thread.
- RB3: `pages`, `timeout` alone, `memory` with and without `retry`, `parse` and `stopped` each read as "This PDF could
  not be read. Paste the invoice's text instead."; `timeout` with `retry` is a plain `Error`, neither a
  `DocumentReadError` nor a `PdfWorkerRefusal`; a reader that could not start is thrown as it is.
- RB5: of five PDFs attached to an email, the first three are read, one at a time; one the worker refuses is left out
  and the message's text still read; one stopped by a contended timeout fails the read with a plain `Error`.

**`tests/invoice-document-read.test.ts`** (the real reader): an LZW-encoded page, and one with `/Encrypt` on its
content stream's dictionary, read in the worker to the text the unencoded page reads to; an unmeasurable file of 51
pages is refused; an unmeasurable nested-forms PDF stops at 15 s as unreadable while a timer on the asking thread keeps
ticking.

**`tests/invoice-document-worker-start.test.ts`** (a stand-in for node's Worker), RB4: a timeout alone is the file's;
one while another worker answered, begun after it, or while two ran at once, has `retry`; so does one while a parse
on this thread ran.

**`tests/invoice-document-prescan.test.ts`**, RB6: the lenient assertions go; the strict refusals stay, under the one
mode. A 600 MB bomb with an LZW stream before or after it, or with an `/Encrypt` key on a stream's dictionary or in a
fake trailer inside a comment, refuses as `decoded_limit`, having decoded under 17 MB; an LZW stream before 1 MB of
measured spaces refuses as `unbounded_filter`, having measured that megabyte; too many streams stop the scan at once.
