import { Worker } from "node:worker_threads";

/**
 * A PDF's text read in a worker thread (document checks DK3), for a file the cycle reads: one a vendor sent through
 * its link, or a member attached. pdf.js parses on the thread that calls it and sets itself no limit, and the scheduled
 * tick runs every live workspace's cycle on one thread, so a PDF built to keep pdf.js busy (forms drawn inside forms,
 * say) or to fill its memory would hold or end every workspace's cycle, payments included. Here the parse runs in its
 * own thread, with its own heap, and is stopped at its time limit or once its heap is full. Inside it, a PDF of more
 * pages than `maxPages` is refused, and pages stop being read once their text passes `maxChars`; neither stops forms
 * nested inside one page, so the time limit is the bound that holds.
 *
 * The worker is a script given as text, so no bundler rewrites it: it loads unpdf from the working directory's
 * node_modules (next.config.ts keeps unpdf there, in serverExternalPackages, so a deployment carries it).
 */

export interface PdfLimits {
  /** How long the worker may take, from its start to its answer. */
  timeoutMs: number;
  /** The most pages read; a PDF with more is refused before any page is. */
  maxPages: number;
  /** The worker's own heap, in MB: V8's old and young generations. */
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
}

/** The limits the cycle reads with. */
export const PDF_LIMITS: Readonly<PdfLimits> = { timeoutMs: 15_000, maxPages: 50, maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

/** The file could not be read in the worker, by its own doing: too slow, too large for the heap, too many pages, or unparsable. */
export class PdfWorkerRefusal extends Error {
  constructor(readonly why: "timeout" | "memory" | "pages" | "parse" | "stopped") {
    super(`the PDF could not be read (${why})`);
    this.name = "PdfWorkerRefusal";
  }
}

/**
 * The worker's script. It answers once: the text of each page read, and whether pages were left unread; a refusal; or,
 * when unpdf itself cannot be loaded, `setup`, which is no fault of the file. Its text has no backslash and no template
 * placeholder, so it reads here as it runs.
 */
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const EOL = String.fromCharCode(10);
async function read() {
  let unpdf;
  try {
    unpdf = await import("unpdf");
  } catch (error) {
    return { setup: String((error && error.message) || error) };
  }
  let pdf;
  try {
    pdf = await unpdf.getDocumentProxy(workerData.bytes, { verbosity: 0 });
  } catch {
    return { refused: "parse" };
  }
  try {
    if (pdf.numPages > workerData.maxPages) return { refused: "pages" };
    const pages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      const text = content.items
        .filter((item) => item.str != null)
        .map((item) => item.str + (item.hasEOL ? EOL : ""))
        .join("");
      pages.push(text);
      length += text.length;
      if (length > workerData.maxChars && number < pdf.numPages) return { pages, cut: true };
    }
    return { pages, cut: false };
  } catch {
    return { refused: "parse" };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
read().then(
  (answer) => parentPort.postMessage(answer),
  () => parentPort.postMessage({ refused: "parse" })
);
`;

type Answer = { pages: unknown; cut: unknown } | { refused: unknown } | { setup: unknown };

/**
 * The text of each page of `bytes`, read in a worker under `limits`, and whether pages were left unread once the text
 * passed `maxChars`. Rejects with a `PdfWorkerRefusal` for anything the file did; with a plain `Error` when the worker
 * could not start or load its reader, which the file did not, so the caller can try it again later.
 */
export function pdfPagesInWorker(bytes: Uint8Array, limits: PdfLimits & { maxChars: number }): Promise<{ pages: string[]; cut: boolean }> {
  return new Promise((resolve, reject) => {
    // The worker is handed its own copy: the caller's bytes stay whole, for the hash of what was sent.
    const copy = bytes.slice();
    let worker: Worker;
    try {
      worker = new Worker(SOURCE, {
        eval: true,
        workerData: { bytes: copy, maxPages: limits.maxPages, maxChars: limits.maxChars },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb },
      });
    } catch (error) {
      reject(new Error(`the PDF reader could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    const timer = setTimeout(() => settle(() => reject(new PdfWorkerRefusal("timeout"))), limits.timeoutMs);
    worker.once("message", (answer: Answer) =>
      settle(() => {
        if (answer && "setup" in answer) return reject(new Error(`the PDF reader could not start: ${String(answer.setup)}`));
        if (answer && "pages" in answer && Array.isArray(answer.pages) && answer.pages.every((page) => typeof page === "string")) {
          return resolve({ pages: answer.pages as string[], cut: answer.cut === true });
        }
        reject(new PdfWorkerRefusal(answer && "refused" in answer && answer.refused === "pages" ? "pages" : "parse"));
      })
    );
    // A heap filled, or the worker failed in a way its own script did not catch: the file's doing either way.
    worker.once("error", (error: Error & { code?: string }) => settle(() => reject(new PdfWorkerRefusal(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "stopped"))));
    worker.once("exit", () => settle(() => reject(new PdfWorkerRefusal("stopped"))));
  });
}
