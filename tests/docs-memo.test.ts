import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The docs layout builds the search index on every render, request-time 404s
 * included, and the shell reads each page's Markdown view. Both are pure for
 * a given origin, so each is built once and kept. `readSource` is wrapped in a
 * spy that still reads the real file, to count how often a page is read.
 */

vi.mock("@/lib/docs/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/docs/content")>();
  return { ...actual, readSource: vi.fn(actual.readSource) };
});

const { readSource } = await import("@/lib/docs/content");
const { pageMarkdown } = await import("@/lib/docs/markdown");
const { buildSearchIndex } = await import("@/lib/docs/search-index");

const ORIGIN = "https://memo.test";
const reads = vi.mocked(readSource);

beforeEach(() => {
  reads.mockClear();
});

describe("pageMarkdown, memoized", () => {
  it("reads and converts a page once per origin, then answers from memory", () => {
    const first = pageMarkdown("get-started/authentication", ORIGIN);
    const second = pageMarkdown("get-started/authentication", ORIGIN);
    expect(second).toBe(first);
    expect(reads.mock.calls.filter(([slug]) => slug === "get-started/authentication")).toHaveLength(1);

    // Another origin is another document: its links are absolute on it.
    const elsewhere = pageMarkdown("get-started/authentication", "https://other.test");
    expect(elsewhere).not.toBe(first);
    expect(elsewhere).toContain("https://other.test/");
  });

  it("keeps nothing for an address that is not a page, so a stream of 404s cannot grow the cache", () => {
    for (let index = 0; index < 3; index++) expect(pageMarkdown(`nope-${index}`, ORIGIN)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("buildSearchIndex, memoized", () => {
  it("builds the index once per origin and hands back the same one", () => {
    const first = buildSearchIndex(ORIGIN);
    reads.mockClear();
    expect(buildSearchIndex(ORIGIN)).toBe(first);
    expect(reads).not.toHaveBeenCalled();
    expect(buildSearchIndex("https://other.test")).not.toBe(first);
  });
});
