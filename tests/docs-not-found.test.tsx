import { describe, expect, it, vi } from "vitest";

/**
 * An unknown docs address renders the docs' own not-found page, inside the
 * docs shell with its search, rather than the site's root 404. That needs the
 * catch-all routes to accept any path at request time (`dynamicParams`), so
 * each page must refuse an unknown one before it reads any file.
 */

vi.mock("@/lib/docs/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/docs/content")>();
  return {
    ...actual,
    readSource: vi.fn(actual.readSource),
    loadPage: vi.fn(actual.loadPage),
    loadNotes: vi.fn(actual.loadNotes),
  };
});

const content = await import("@/lib/docs/content");
const slugPage = await import("@/app/docs/[[...slug]]/page");
const apiPage = await import("@/app/docs/api/[operation]/page");

/** What `notFound()` throws: Next's 404 fallback error. */
const NOT_FOUND = expect.objectContaining({ digest: expect.stringContaining("404") });

describe("an unknown docs address", () => {
  it("is rendered at request time by the docs routes, not refused before them", () => {
    expect(slugPage.dynamicParams).toBe(true);
    expect(apiPage.dynamicParams).toBe(true);
  });

  it.each([[["nope"]], [["get-started", "nope"]], [["webhooks", "verify", "extra"]]])("/docs/%s is not found, and no file is read for it", async (segments) => {
    vi.mocked(content.readSource).mockClear();
    vi.mocked(content.loadPage).mockClear();
    const params = Promise.resolve({ slug: segments });
    expect(await slugPage.generateMetadata({ params })).toEqual({});
    await expect(slugPage.default({ params })).rejects.toEqual(NOT_FOUND);
    expect(content.readSource).not.toHaveBeenCalled();
    expect(content.loadPage).not.toHaveBeenCalled();
  });

  it("/docs/api/<unknown operation> is not found, and no notes are read for it", async () => {
    vi.mocked(content.readSource).mockClear();
    vi.mocked(content.loadNotes).mockClear();
    const params = Promise.resolve({ operation: "nope" });
    expect(await apiPage.generateMetadata({ params })).toEqual({});
    await expect(apiPage.default({ params })).rejects.toEqual(NOT_FOUND);
    expect(content.readSource).not.toHaveBeenCalled();
    expect(content.loadNotes).not.toHaveBeenCalled();
  });
});
