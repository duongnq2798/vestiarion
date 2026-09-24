import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  paginate,
  parseLimit,
  STATUS_FOR,
} from "@/lib/api/contract";

describe("cursors", () => {
  it("round-trips a sequence position", () => {
    expect(decodeCursor(encodeCursor({ k: 1247 }))).toEqual({ k: 1247 });
  });

  it("round-trips a timestamp position with a tiebreak", () => {
    const payload = { k: "2026-09-25T01:02:03.000Z", id: "b7a1" };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("is opaque, so nothing a caller reads can become load-bearing", () => {
    // The point of encoding: ordering can change from a timestamp to a
    // sequence later without breaking anyone who stored a cursor.
    const cursor = encodeCursor({ k: "2026-09-25T00:00:00.000Z" });
    expect(cursor).not.toContain("2026");
    expect(cursor).not.toContain("{");
  });

  it("rejects anything it did not issue rather than guessing a position", () => {
    // Reading a bad cursor as "start from the beginning" would silently replay
    // an entire ledger to a bot that believed it was resuming.
    for (const bad of ["", "not-base64!!", Buffer.from("plain text").toString("base64url")]) {
      expect(decodeCursor(bad), `accepted ${bad}`).toBeNull();
    }
  });

  it("rejects a decodable cursor of the wrong shape", () => {
    const wrong = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(decodeCursor(wrong({ nope: 1 }))).toBeNull();
    expect(decodeCursor(wrong({ k: { nested: true } }))).toBeNull();
    expect(decodeCursor(wrong({ k: 1, id: 5 }))).toBeNull();
    expect(decodeCursor(wrong([1, 2]))).toBeNull();
    expect(decodeCursor(wrong(null))).toBeNull();
  });

  it("treats an absent cursor as the start, which is not an error", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe("parseLimit", () => {
  it("defaults when absent", () => {
    expect(parseLimit(null)).toEqual({ limit: DEFAULT_PAGE_SIZE });
    expect(parseLimit("")).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it("caps rather than trusting the caller", () => {
    // An unbounded limit is a way to ask one request to read a whole ledger.
    expect(parseLimit("100000")).toEqual({ limit: MAX_PAGE_SIZE });
  });

  it("rejects values that are not a positive integer", () => {
    for (const bad of ["0", "-5", "abc", "1.5", "NaN", "Infinity"]) {
      expect(parseLimit(bad), `accepted ${bad}`).toHaveProperty("error");
    }
  });

  it("accepts a sensible explicit size", () => {
    expect(parseLimit("25")).toEqual({ limit: 25 });
  });
});

describe("paginate", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1 }));
  const cursorOf = (row: { seq: number }) => ({ k: row.seq });

  it("reports more pages by observing an extra row, not by counting", () => {
    // A separate count query is a second round trip and can disagree with the
    // rows already read.
    const page = paginate(rows(11), 10, cursorOf);
    expect(page.data).toHaveLength(10);
    expect(page.page).toMatchObject({ hasMore: true, count: 10 });
    expect(decodeCursor(page.page.nextCursor)).toEqual({ k: 10 });
  });

  it("ends cleanly when the extra row is absent", () => {
    const page = paginate(rows(7), 10, cursorOf);
    expect(page.page).toEqual({ hasMore: false, nextCursor: null, count: 7 });
  });

  it("ends cleanly on an exactly full page", () => {
    // The boundary that an off-by-one gets wrong in the direction that loses
    // the last page.
    const page = paginate(rows(10), 10, cursorOf);
    expect(page.page).toEqual({ hasMore: false, nextCursor: null, count: 10 });
  });

  it("handles an empty result without inventing a cursor", () => {
    expect(paginate([], 10, cursorOf).page).toEqual({
      hasMore: false,
      nextCursor: null,
      count: 0,
    });
  });

  it("points the next cursor at the last row returned, not the one dropped", () => {
    // Pointing at the dropped row would skip it on the next page.
    const page = paginate(rows(6), 5, cursorOf);
    expect(decodeCursor(page.page.nextCursor)).toEqual({ k: 5 });
  });

  it("walks a whole collection exactly once", () => {
    const all = rows(23);
    const seen: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 10; guard++) {
      const slice = all.filter((r) => r.seq > after).slice(0, 11);
      const page = paginate(slice, 10, cursorOf);
      seen.push(...page.data.map((r) => r.seq));
      if (!page.page.hasMore) break;
      after = Number(decodeCursor(page.page.nextCursor)!.k);
    }
    expect(seen).toEqual(all.map((r) => r.seq));
    expect(new Set(seen).size).toBe(23);
  });
});

describe("error codes", () => {
  it("maps every code to the status a client will branch on", () => {
    expect(STATUS_FOR).toEqual({
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      invalid_request: 400,
      rate_limited: 429,
      unavailable: 503,
      internal: 500,
    });
  });
});
