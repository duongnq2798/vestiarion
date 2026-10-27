import { Worker } from "node:worker_threads";

/**
 * A PDF's text read in a worker thread (document checks DK3), for a file the cycle reads: one a vendor sent through
 * its link, or a member attached. pdf.js parses on the thread that calls it and sets itself no limit, and the scheduled
 * tick runs every live workspace's cycle in one process, so a PDF built to keep pdf.js busy (forms drawn inside forms,
 * say) or to fill its memory would hold or end every workspace's cycle, payments included. `readDocument` reads here
 * too, under `REQUEST_PDF_LIMITS`, a file someone sends in that the pre-scan cannot measure
 * (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB2).
 *
 * Here the parse runs in its own thread, under three limits:
 * - its own heap (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`). It bounds pdf.js's JavaScript objects only:
 *   pdf.js decodes each stream into an ArrayBuffer, which is external memory, and Node counts none of that against it;
 * - the process's memory: the parent reads its resident size every 25 ms while the worker runs, and stops the worker
 *   once it has grown by more than `maxRssGrowthMb` since the worker started. This is the bound on what pdf.js decodes.
 *   The pre-scan (./pdf-prescan.ts) refuses most such files before any worker starts; this catches what it cannot see;
 * - `timeoutMs`, from the worker's start to its answer.
 * Inside it, a PDF of more pages than `maxPages` is refused, and pages stop being read once their text passes
 * `maxChars`; neither stops forms nested inside one page, so the time limit is the bound that holds there.
 *
 * Who is at fault decides what the cycle does (`PdfWorkerRefusal.retry`). Too many pages, a parse error pdf.js
 * reports, a full heap of the worker's own, a worker that stopped once running, or a timeout while no other PDF was read
 * in this process, are the file's doing: unreadable for good. The process's memory counts every thread's, and a timeout
 * while another PDF was read, parsed on this thread or in another worker, may be that read's (RB4), so those stops are
 * tried again, and counted (0144's start_document_parse). A worker that never came online never touched the file: a
 * plain Error.
 *
 * The cycle parses one PDF at a time per process (`oneParseAtATime`), so a run that dies mid-parse has one suspect.
 *
 * The worker is a script given as text, so no bundler rewrites it: it loads unpdf from the working directory's
 * node_modules (next.config.ts keeps unpdf there, in serverExternalPackages, so a deployment carries it).
 */

export interface PdfLimits {
  /** How long the worker may take, from its start to its answer. */
  timeoutMs: number;
  /** The most pages read; a PDF with more is refused before any page is. */
  maxPages: number;
  /** The worker's own heap, in MB: V8's old and young generations, which do not count the buffers pdf.js decodes into. */
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  /** How far the process's resident memory may grow, in MB, from the worker's start until it answers. */
  maxRssGrowthMb: number;
}

/** The limits the cycle reads with. 512 MB of growth is a quarter of a 2 GB function, far above any invoice. */
export const PDF_LIMITS: Readonly<PdfLimits> = {
  timeoutMs: 15_000,
  maxPages: 50,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  maxRssGrowthMb: 512,
};

/**
 * The limits a file someone sends in is read with when the pre-scan cannot measure it (RB2): the cycle's, with half its
 * memory budget. Where a request's worker and the cycle's share a process, the request's stops first, so a stranger's
 * file does not cost a vendor's document one of its two tries.
 */
export const REQUEST_PDF_LIMITS: Readonly<PdfLimits> = { ...PDF_LIMITS, maxRssGrowthMb: 256 };

/** How often the parent reads the process's memory while a worker runs. */
const MEMORY_CHECK_MS = 25;

/**
 * The worker stopped, or refused the file: too slow, out of memory, too many pages, unparsable, or stopped otherwise.
 * `retry` is true when the stop may not be the file's doing (the process's memory, or a timeout while another PDF was
 * read in this process): the cycle tries it again, and counts it. Otherwise the file is unreadable for good.
 */
export class PdfWorkerRefusal extends Error {
  readonly retry: boolean;
  constructor(
    readonly why: "timeout" | "memory" | "pages" | "parse" | "stopped",
    { retry = false }: { retry?: boolean } = {}
  ) {
    super(`the PDF could not be read (${why})`);
    this.name = "PdfWorkerRefusal";
    this.retry = retry;
  }
}

/**
 * PDF reads running in this process, and how many have begun: parses on this thread, outside any worker (readDocument's,
 * through `countedParse`), and workers (`pdfPagesInWorker`: the cycle's, and readDocument's for a file the pre-scan
 * cannot measure). A worker that times out while another ran may have been kept waiting by it (RB4).
 */
let readsRunning = 0;
let readsBegun = 0;

/**
 * Runs `parse`, a PDF parsed on the calling thread, counted: a worker that times out while one ran may have been kept
 * waiting by it, so its timeout is tried again rather than blamed on its file. Never around a worker's read, which holds
 * no thread here: its own timeout would then look like another read's.
 */
export async function countedParse<T>(parse: () => Promise<T>): Promise<T> {
  readsRunning++;
  readsBegun++;
  try {
    return await parse();
  } finally {
    readsRunning--;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` once every task given before it has settled: one at a time in this process, whichever workspace's cycle
 * asks. The cycle counts, parses and clears each document's read inside one task, so a run that dies mid-parse leaves
 * one read unfinished: the one that was running.
 */
export function oneParseAtATime<T>(task: () => Promise<T>): Promise<T> {
  const turn = queue.then(task, task);
  queue = turn.then(
    () => undefined,
    () => undefined
  );
  return turn;
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
 * passed `maxChars`. Rejects with a `PdfWorkerRefusal` when the worker stopped or refused the file (see its `retry`);
 * with a plain `Error` when the worker could not start or load its reader, which the file did not, so the caller can
 * try it again later. Its clocks start when the worker is made: a caller waiting for its turn waits before calling this.
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
    const rssAtStart = process.memoryUsage.rss();
    const busyAtStart = readsRunning > 0;
    const begunAtStart = readsBegun;
    // This worker's read is counted from here until it settles, for the other reads in this process (RB4).
    readsRunning++;
    readsBegun++;
    let online = false;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      readsRunning--;
      clearTimeout(timer);
      clearInterval(memory);
      void worker.terminate();
      finish();
    };
    // A timeout is the file's own only when no other PDF was read in this process meanwhile, on this thread or in
    // another worker. Its own read is still counted here, and is left out.
    const timer = setTimeout(() => {
      const othersRead = busyAtStart || readsRunning > 1 || readsBegun > begunAtStart + 1;
      settle(() => reject(new PdfWorkerRefusal("timeout", { retry: othersRead })));
    }, limits.timeoutMs);
    // The buffers pdf.js decodes into are outside the worker's heap: the process's memory is what bounds them. It counts
    // every thread's, so a stop here is tried again.
    const memory = setInterval(() => {
      if (process.memoryUsage.rss() - rssAtStart > limits.maxRssGrowthMb * 2 ** 20) settle(() => reject(new PdfWorkerRefusal("memory", { retry: true })));
    }, MEMORY_CHECK_MS);
    worker.once("online", () => {
      online = true;
    });
    worker.once("message", (answer: Answer) =>
      settle(() => {
        if (answer && "setup" in answer) return reject(new Error(`the PDF reader could not start: ${String(answer.setup)}`));
        if (answer && "pages" in answer && Array.isArray(answer.pages) && answer.pages.every((page) => typeof page === "string")) {
          return resolve({ pages: answer.pages as string[], cut: answer.cut === true });
        }
        reject(new PdfWorkerRefusal(answer && "refused" in answer && answer.refused === "pages" ? "pages" : "parse"));
      })
    );
    // Once online, a heap of its own filled, or a failure its script did not catch, is the file's doing; before, the
    // worker never touched the file (Node reports a thread it could not make, ERR_WORKER_INIT_FAILED, here rather than by
    // throwing). Listened to for as long as the worker lives, so no later error reaches the process unheard.
    worker.on("error", (error: Error & { code?: string }) =>
      settle(() => {
        if (!online || error.code === "ERR_WORKER_INIT_FAILED") return reject(new Error(`the PDF reader could not start: ${error.message}`));
        reject(new PdfWorkerRefusal(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "stopped"));
      })
    );
    worker.once("exit", () =>
      settle(() => reject(online ? new PdfWorkerRefusal("stopped") : new Error("the PDF reader could not start: the worker exited before it ran")))
    );
  });
}
