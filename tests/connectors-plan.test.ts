import { describe, expect, it } from "vitest";
import { inWindow, planBill, withKeptFacts, type StagedBill } from "@/lib/connectors/bills";
import { afterPage, NEW_CURSOR, nextRequest, pagesRead, type SyncCursor } from "@/lib/connectors/cursors";
import type { ExternalBill } from "@/lib/connectors/provider";

/**
 * One bill, one row, never two payables (docs/superpowers/specs/2026-10-12-xero-connector-design.md X9, X10), and a
 * sync that resumes where it stopped (X8, I13): pure decisions over what was read and what is kept.
 */

const bill = (fields: Partial<ExternalBill> = {}): ExternalBill => ({
  externalId: "bill-1",
  version: "2026-10-12T07:15:22.093Z",
  updatedAt: "2026-10-12T07:15:22.093Z",
  contactExternalId: "contact-1",
  contactName: "PowerDirect",
  number: "PD-4471",
  reference: null,
  currency: "USD",
  total: "1250",
  amountDue: "1250",
  issuedOn: "2026-10-03",
  dueOn: "2026-10-28",
  status: "open",
  ...fields,
});

const staged = (fields: Partial<StagedBill> = {}): StagedBill => ({
  id: "row-1",
  externalVersion: "2026-10-12T07:15:22.093Z",
  sourceStatus: "open",
  reviewState: "review",
  ...fields,
});

const WINDOW = "2026-07-14";
const LATER = "2026-10-12T09:00:00.000Z";

describe("inWindow", () => {
  it("takes a bill due or dated on or after the window's first day, and one with no day at all", () => {
    expect(inWindow(bill(), WINDOW)).toBe(true);
    expect(inWindow(bill({ dueOn: "2026-07-14", issuedOn: "2026-06-01" }), WINDOW)).toBe(true);
    expect(inWindow(bill({ dueOn: "2026-07-13", issuedOn: "2026-07-20" }), WINDOW)).toBe(true);
    expect(inWindow(bill({ dueOn: "2026-06-30", issuedOn: "2026-06-01" }), WINDOW)).toBe(false);
    expect(inWindow(bill({ dueOn: null, issuedOn: null }), WINDOW)).toBe(true);
  });
});

describe("planBill", () => {
  it("adds a new open bill in the window to the review list", () => {
    expect(planBill(null, bill(), WINDOW)).toEqual({ kind: "insert" });
  });

  it("keeps nothing of a new bill that is closed or outside the window", () => {
    for (const status of ["paid", "voided", "deleted", "draft"] as const) {
      expect(planBill(null, bill({ status }), WINDOW)).toEqual({ kind: "ignore", reason: "closed" });
    }
    expect(planBill(null, bill({ dueOn: "2026-05-01", issuedOn: "2026-04-01" }), WINDOW)).toEqual({ kind: "ignore", reason: "outside" });
  });

  it("ignores a version it already has or an older one, so a page read twice changes nothing", () => {
    expect(planBill(staged(), bill(), WINDOW)).toEqual({ kind: "ignore", reason: "older" });
    expect(planBill(staged({ externalVersion: LATER }), bill(), WINDOW)).toEqual({ kind: "ignore", reason: "older" });
  });

  it("follows a newer version: facts, and what Xero says of it now", () => {
    expect(planBill(staged(), bill({ version: LATER, amountDue: "600" }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
    expect(planBill(staged(), bill({ version: LATER, status: "paid" }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
    expect(planBill(staged({ sourceStatus: "paid" }), bill({ version: LATER, status: "open" }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
  });

  it("says when a bill already added was paid, voided or deleted in the source, once", () => {
    for (const status of ["paid", "voided", "deleted"] as const) {
      expect(planBill(staged({ reviewState: "added" }), bill({ version: LATER, status }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: true });
    }
    // Already said: a later change to a closed bill is not news again.
    expect(planBill(staged({ reviewState: "added", sourceStatus: "paid" }), bill({ version: "2026-10-12T10:00:00.000Z", status: "paid" }), WINDOW)).toEqual({
      kind: "update",
      closedAfterAdded: false,
    });
    // Back in draft is not a close: Xero never pays a draft.
    expect(planBill(staged({ reviewState: "added" }), bill({ version: LATER, status: "draft" }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
  });

  it("keeps a dismissed bill dismissed while following its facts", () => {
    expect(planBill(staged({ reviewState: "dismissed" }), bill({ version: LATER, status: "paid" }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
  });

  it("follows a bill kept without a version", () => {
    expect(planBill(staged({ externalVersion: null }), bill(), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
  });
});

describe("the cursor", () => {
  const T0 = "2026-10-12T07:00:00.000Z";
  const T1 = "2026-10-12T07:30:00.000Z";

  it("starts a backfill on page 1 with no time, and remembers when it started", () => {
    const { cursor, request } = nextRequest(NEW_CURSOR, T0);
    expect(request).toEqual({ phase: "backfill", since: null, page: 1 });
    expect(cursor).toMatchObject({ page: 1, runStartedAt: T0, backfillStartedAt: T0, changedInRun: false });
  });

  it("keeps the next page and the latest change after each page, so a stopped run resumes there", () => {
    const started = nextRequest(NEW_CURSOR, T0).cursor;
    const after1 = afterPage(started, { page: 1, last: false, updatedAts: ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"] }, T0);
    expect(after1).toMatchObject({ phase: "backfill", page: 2, highWater: "2026-10-01T00:00:00.000Z" });
    expect(pagesRead(after1)).toBe(1);
    // A later run resumes on page 2, from the same start.
    const resumed = nextRequest(after1, T1);
    expect(resumed.request).toEqual({ phase: "backfill", since: null, page: 2 });
    expect(resumed.cursor.runStartedAt).toBe(T0);
  });

  it("moves a finished backfill on to changes since it started, less five minutes", () => {
    const started = nextRequest(NEW_CURSOR, T0).cursor;
    const done = afterPage(started, { page: 1, last: true, updatedAts: ["2026-10-01T00:00:00.000Z"] }, T1);
    expect(done).toEqual<SyncCursor>({
      phase: "incremental",
      since: "2026-10-12T06:55:00.000Z",
      page: null,
      highWater: null,
      backfillStartedAt: T0,
      runStartedAt: null,
      changedInRun: false,
      total: null,
      completedAt: T1,
    });
    expect(nextRequest(done, T1).request).toEqual({ phase: "incremental", since: "2026-10-12T06:55:00.000Z", page: 1 });
  });

  it("moves an incremental run's time to the latest change it read, or keeps it when it read none", () => {
    const cursor: SyncCursor = { ...NEW_CURSOR, phase: "incremental", since: "2026-10-12T06:55:00.000Z", backfillStartedAt: T0, completedAt: T0 };
    const started = nextRequest(cursor, T1).cursor;
    expect(afterPage(started, { page: 1, last: true, updatedAts: ["2026-10-12T07:20:00.000Z", "2026-10-12T07:10:00.000Z"] }, T1).since).toBe(
      "2026-10-12T07:20:00.000Z"
    );
    expect(afterPage(started, { page: 1, last: true, updatedAts: [] }, T1).since).toBe("2026-10-12T06:55:00.000Z");
  });

  it("reads again from page 1 when a run of several pages saw a change made during it, since paging may have skipped a row", () => {
    const started = nextRequest(NEW_CURSOR, T0).cursor;
    const page1 = afterPage(started, { page: 1, last: false, updatedAts: ["2026-09-01T00:00:00.000Z"] }, T0);
    const page2 = afterPage(page1, { page: 2, last: true, updatedAts: ["2026-10-12T07:01:00.000Z"] }, T0);
    expect(page2).toMatchObject({ phase: "backfill", page: null, highWater: null, runStartedAt: null, backfillStartedAt: T0 });
    expect(nextRequest(page2, T1).request).toEqual({ phase: "backfill", since: null, page: 1 });
  });

  it("reads again from page 1 when fewer records match than on the run's last page, since one that left moved the next up into a page already read", () => {
    const started = nextRequest(NEW_CURSOR, T0).cursor;
    // Page 1 of three open bills; then one on it is paid in the source, and leaves what a backfill reads.
    const page1 = afterPage(started, { page: 1, last: false, updatedAts: ["2026-09-01T00:00:00.000Z"], total: 3 }, T0);
    const resumed = nextRequest(page1, T1).cursor;
    const page2 = afterPage(resumed, { page: 2, last: true, updatedAts: ["2026-09-03T00:00:00.000Z"], total: 2 }, T1);
    expect(page2).toMatchObject({ phase: "backfill", page: null, runStartedAt: null, backfillStartedAt: T0 });
    expect(nextRequest(page2, T1).request).toEqual({ phase: "backfill", since: null, page: 1 });
    // More records than before is one added at the end, in update order: nothing was skipped.
    const grown = afterPage(page1, { page: 2, last: true, updatedAts: ["2026-09-03T00:00:00.000Z"], total: 4 }, T1);
    expect(grown.phase).toBe("incremental");
  });

  it("moves on after one page whatever changed during it: a single page cannot skip a row", () => {
    const started = nextRequest(NEW_CURSOR, T0).cursor;
    expect(afterPage(started, { page: 1, last: true, updatedAts: ["2026-10-12T07:01:00.000Z"] }, T0).phase).toBe("incremental");
  });
});

describe("a bill the provider names by its id alone (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q8)", () => {
  const deleted = bill({ version: "2026-10-12T09:00:00.000Z#deleted", updatedAt: "2026-10-12T09:00:00.000Z", contactName: "Unnamed vendor", number: null, status: "deleted", factsKnown: false });
  const quickbooksVersion = "2026-10-12T09:00:00.000Z#00000004";

  it("closes an added bill once it is deleted, even in the same second as its last change", () => {
    expect(planBill(staged({ reviewState: "added", externalVersion: quickbooksVersion }), deleted, WINDOW)).toEqual({ kind: "update", closedAfterAdded: true });
    expect(planBill(null, deleted, WINDOW)).toEqual({ kind: "ignore", reason: "closed" });
    expect(planBill(staged({ externalVersion: deleted.version, sourceStatus: "deleted" }), deleted, WINDOW)).toEqual({ kind: "ignore", reason: "older" });
  });

  it("orders two changes in the same second by their sync token", () => {
    expect(planBill(staged({ externalVersion: "2026-10-12T09:00:00.000Z#00000003" }), bill({ version: quickbooksVersion }), WINDOW)).toEqual({ kind: "update", closedAfterAdded: false });
    expect(planBill(staged({ externalVersion: "2026-10-12T09:00:00.000Z#00000010" }), bill({ version: quickbooksVersion }), WINDOW)).toEqual({ kind: "ignore", reason: "older" });
  });

  it("takes the supplier and number its row kept", () => {
    expect(withKeptFacts(deleted, staged({ contactName: "PowerDirect", number: "PD-4471" }))).toMatchObject({ contactName: "PowerDirect", number: "PD-4471", status: "deleted" });
    expect(withKeptFacts(bill(), staged({ contactName: "Someone else" })).contactName).toBe("PowerDirect");
    expect(withKeptFacts(deleted, null)).toBe(deleted);
  });
});
