import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How the bounded PDF reader tells a worker that never started from one the file stopped (document checks DK3), over a
 * stand-in for node's Worker. A worker that fails before it comes online never touched the file: Node reports a thread
 * it could not create (ERR_WORKER_INIT_FAILED) through the worker's `error` event, not by throwing. That is a plain
 * Error, which the cycle tries again; only what happens once the worker runs is the file's doing. And a worker's timeout
 * is the file's own only when no other PDF was read in this process meanwhile, on this thread or in another worker, its
 * own read never counted (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB4).
 */

const { plan, made } = vi.hoisted(() => ({
  /** What each next worker does, once made: emits events on itself. */
  plan: [] as Array<(worker: import("node:events").EventEmitter) => void>,
  made: [] as Array<{ terminated: boolean }>,
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    terminated = false;
    constructor() {
      super();
      made.push(this);
      const act = plan.shift();
      setTimeout(() => act?.(this), 5);
    }
    terminate() {
      this.terminated = true;
      return Promise.resolve(1);
    }
  }
  return { Worker: FakeWorker, default: { Worker: FakeWorker } };
});

import { countedParse, PDF_LIMITS, pdfPagesInWorker, PdfWorkerRefusal } from "@/lib/invoice-document/pdf-worker";
import { DocumentReadError, MAX_DOCUMENT_CHARS, readPdfBounded } from "@/lib/invoice-document/read";
import { pagesPdf } from "./support/pdf-files";

const limits = { ...PDF_LIMITS, maxChars: MAX_DOCUMENT_CHARS };
const failure = (error: Error & { code?: string }, code?: string) => Object.assign(error, code ? { code } : {});
const read = () => pdfPagesInWorker(pagesPdf(1), limits).catch((error: unknown) => error);

beforeEach(() => {
  plan.length = 0;
  made.length = 0;
});

describe("a PDF worker that never started (DK3)", () => {
  it("is a plain Error, not the file's doing, when the thread could not be created", async () => {
    plan.push((worker) => worker.emit("error", failure(new Error("Worker initialization failure: 11"), "ERR_WORKER_INIT_FAILED")));
    const settled = await read();
    expect(settled).toBeInstanceOf(Error);
    expect(settled).not.toBeInstanceOf(PdfWorkerRefusal);
    expect((settled as Error).message).toMatch(/the PDF reader could not start/);
    expect(made[0].terminated).toBe(true);
  });

  it("is a plain Error when it fails, or exits, before it comes online, whatever the code", async () => {
    plan.push((worker) => worker.emit("error", failure(new Error("out of memory before it ran"), "ERR_WORKER_OUT_OF_MEMORY")));
    expect(await read()).not.toBeInstanceOf(PdfWorkerRefusal);
    plan.push((worker) => worker.emit("exit", 1));
    const exited = await read();
    expect(exited).toBeInstanceOf(Error);
    expect(exited).not.toBeInstanceOf(PdfWorkerRefusal);
    expect((exited as Error).message).toMatch(/the PDF reader could not start/);
  });

  it("reaches the cycle as a plain Error through readPdfBounded, never as a document that could not be read", async () => {
    plan.push((worker) => worker.emit("error", failure(new Error("Worker initialization failure: 11"), "ERR_WORKER_INIT_FAILED")));
    const settled = await readPdfBounded(pagesPdf(1)).catch((error: unknown) => error);
    expect(settled).toBeInstanceOf(Error);
    expect(settled).not.toBeInstanceOf(DocumentReadError);
    expect(settled).not.toBeInstanceOf(PdfWorkerRefusal);
  });
});

describe("a PDF worker that started", () => {
  it("is stopped by the file when it fails or exits once online", async () => {
    plan.push((worker) => {
      worker.emit("online");
      worker.emit("error", new Error("pdf.js threw where the script did not catch it"));
    });
    expect(await read()).toMatchObject({ why: "stopped", retry: false });
    plan.push((worker) => {
      worker.emit("online");
      worker.emit("error", failure(new Error("heap full"), "ERR_WORKER_OUT_OF_MEMORY"));
    });
    expect(await read()).toMatchObject({ why: "memory", retry: false });
    plan.push((worker) => {
      worker.emit("online");
      worker.emit("exit", 1);
    });
    expect(await read()).toMatchObject({ why: "stopped", retry: false });
  });

  it("answers with the pages it read", async () => {
    plan.push((worker) => {
      worker.emit("online");
      worker.emit("message", { pages: ["Northwind Hosting invoice INV-2207"], cut: false });
    });
    expect(await read()).toEqual({ pages: ["Northwind Hosting invoice INV-2207"], cut: false });
  });
});

describe("a PDF worker's timeout beside other reads (RB4)", () => {
  const short = { ...limits, timeoutMs: 100 };
  /** A worker that comes online and never answers. */
  const silent = () => plan.push((worker) => worker.emit("online"));
  /** A worker that answers with a page at once. */
  const answering = () =>
    plan.push((worker) => {
      worker.emit("online");
      worker.emit("message", { pages: ["Northwind Hosting invoice INV-2207"], cut: false });
    });
  const slow = (timeoutMs = 100) => pdfPagesInWorker(pagesPdf(1), { ...limits, timeoutMs }).catch((error: unknown) => error);

  it("is the file's own when nothing else read a PDF meanwhile: its own read is not counted", async () => {
    silent();
    expect(await slow()).toMatchObject({ why: "timeout", retry: false });
  });

  it("is tried again when another worker read a PDF meanwhile, begun after it or running when it began", async () => {
    silent();
    answering();
    const first = slow();
    await pdfPagesInWorker(pagesPdf(1), short);
    expect(await first).toMatchObject({ why: "timeout", retry: true });
    silent();
    silent();
    const longer = slow(300);
    const later = slow(100);
    expect(await later).toMatchObject({ why: "timeout", retry: true });
    expect(await longer).toMatchObject({ why: "timeout", retry: true });
    // Once both are done, a worker alone is the file's again.
    silent();
    expect(await slow()).toMatchObject({ why: "timeout", retry: false });
  });

  it("is tried again after a PDF was parsed on this thread meanwhile", async () => {
    silent();
    const waiting = slow();
    await countedParse(async () => "parsed");
    expect(await waiting).toMatchObject({ why: "timeout", retry: true });
  });
});
