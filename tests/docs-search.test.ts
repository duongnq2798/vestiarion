import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { hasSource, publishedPages, readSource } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";
import { referenceHeadings } from "@/lib/docs/reference";
import { isSearchShortcut, searchDocs, searchHref, type SearchEntry } from "@/lib/docs/search";
import { buildSearchIndex, plainText } from "@/lib/docs/search-index";

/**
 * Docs search: the index built at build time, one entry per page and one per
 * `##`/`###` heading; the filter the dialog runs over it; and the keyboard
 * shortcut that opens it. Tests run in `node`, without a DOM, so a key
 * event's target is a plain object shaped like the element it stands for.
 */

const INDEX = buildSearchIndex();

describe("buildSearchIndex", () => {
  it("indexes every page and its headings, with the anchors the page renders", () => {
    for (const page of publishedPages()) {
      const entries = INDEX.filter((entry) => entry.slug === page.slug);
      const top = entries.filter((entry) => entry.heading === undefined);
      expect(top.map((entry) => entry.title), page.slug).toEqual([page.title]);

      const id = page.slug.startsWith("api/") ? page.slug.slice("api/".length) : null;
      const headings = id === null ? slugifyHeadings(readSource(page.slug)) : referenceHeadings(hasSource(page.slug) ? readSource(page.slug) : null);
      const indexed = entries.filter((entry) => entry.heading !== undefined).map((entry) => [entry.heading, entry.anchor]);
      expect(indexed, page.slug).toEqual(headings.map((heading) => [heading.text, heading.id]));
    }
  });

  it("keeps the first 200 characters of plain text after each page and heading", () => {
    for (const entry of INDEX) {
      expect(entry.text.length).toBeLessThanOrEqual(200);
      expect(entry.text).not.toMatch(/```|\]\(|\*\*|^#|\n/);
    }
    const errors = INDEX.find((entry) => entry.slug === `api/${OPERATIONS[0].id}` && entry.anchor === "errors")!;
    expect(errors.text).toMatch(/^Status Code When 401 unauthorized/);
    const page = INDEX.find((entry) => entry.slug === "api/list-invoices" && entry.heading === undefined)!;
    expect(page.text.startsWith("GET /api/v1/invoices The payable and receivable book")).toBe(true);
  });

  it("names each entry's section", () => {
    expect(INDEX.find((entry) => entry.slug === "api/get-status")?.section).toBe("API reference");
    expect(INDEX.find((entry) => entry.slug === "")?.section).toBe("Overview");
  });
});

describe("plainText", () => {
  it("reads Markdown as the words on the page", () => {
    expect(plainText("> **Note** See [the key](https://x.test/docs) and `limit`.\n\n```sh\ncurl x\n```\n\n| A | B |\n| --- | --- |\n| `1` | two |\n- item")).toBe(
      "Note See the key and limit. A B 1 two item"
    );
  });
});

describe("searchDocs", () => {
  const entries: SearchEntry[] = [
    { slug: "webhooks/verify", title: "Verifying signatures", section: "Webhooks", text: "Check a delivery's signature." },
    { slug: "webhooks/verify", title: "Verifying signatures", section: "Webhooks", heading: "Node.js", anchor: "node-js", text: "Use crypto.timingSafeEqual." },
    { slug: "get-started/pagination", title: "Pagination", section: "Get started", text: "Page with a cursor and limit." },
    { slug: "api/list-invoices", title: "List invoices", section: "API reference", heading: "Parameters", anchor: "parameters", text: "limit cursor direction status" },
  ];

  it("matches every word in the title, heading or text, best matches first", () => {
    expect(searchDocs(entries, "cursor").map((entry) => entry.slug)).toEqual(["get-started/pagination", "api/list-invoices"]);
    expect(searchDocs(entries, "PAGINATION")[0].slug).toBe("get-started/pagination");
    expect(searchDocs(entries, "cursor websocket")).toEqual([]);
    expect(searchDocs(entries, "signatures node").map((entry) => entry.anchor)).toEqual(["node-js"]);
    expect(searchDocs(entries, "timingSafeEqual")[0].anchor).toBe("node-js");
  });

  it("finds nothing for a word no entry has, and nothing for an empty query", () => {
    expect(searchDocs(entries, "websocket")).toEqual([]);
    expect(searchDocs(entries, "   ")).toEqual([]);
  });

  it("finds the real index's reference pages by path and heading", () => {
    expect(searchDocs(INDEX, "list invoices")[0].slug).toBe("api/list-invoices");
    expect(searchDocs(INDEX, "errors").some((entry) => entry.anchor === "errors")).toBe(true);
  });

  it("links a result to its page, and to its heading when it has one", () => {
    expect(searchHref(entries[0])).toBe("/docs/webhooks/verify");
    expect(searchHref(entries[1])).toBe("/docs/webhooks/verify#node-js");
    expect(searchHref({ slug: "", title: "Overview", section: "Overview", text: "" })).toBe("/docs");
  });
});

describe("isSearchShortcut", () => {
  const body = { tagName: "BODY" };
  const input = { tagName: "INPUT" };
  const key = (init: Partial<Record<"key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey", unknown>>, target: unknown = body) =>
    ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, ...init }) as unknown as KeyboardEvent;

  it("opens on Ctrl/⌘ K but never on a plain k typed in a field", () => {
    expect(isSearchShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ key: "K", ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key({}, input))).toBe(false);
    expect(isSearchShortcut(key({}))).toBe(false);
  });

  it("ignores a plain k in any field, but Ctrl/⌘ K opens from one", () => {
    for (const target of [input, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(isSearchShortcut(key({}, target))).toBe(false);
      expect(isSearchShortcut(key({ ctrlKey: true }, target))).toBe(true);
    }
  });

  it("leaves other keys and other chords alone", () => {
    expect(isSearchShortcut(key({ key: "j", ctrlKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true }, null))).toBe(true);
  });
});
