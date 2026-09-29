import { describe, expect, it } from "vitest";
import { slugify, slugifyHeadings } from "@/lib/docs/headings";

describe("slugifyHeadings", () => {
  it("gives repeated headings unique ids, and ignores headings inside code", () => {
    const md = "## Example\n\ntext\n\n```md\n## Not a heading\n```\n\n### Query `limit`\n\n## Example\n";
    expect(slugifyHeadings(md)).toEqual([
      { depth: 2, text: "Example", id: "example" },
      { depth: 3, text: "Query limit", id: "query-limit" },
      { depth: 2, text: "Example", id: "example-2" },
    ]);
  });

  it("counts a third repeat, across depths, and skips tilde fences and deeper or shallower headings", () => {
    const md = [
      "# Title",
      "## Setup",
      "~~~",
      "## Setup",
      "~~~",
      "### Setup",
      "#### Setup",
      "## Setup ##",
      "````md",
      "```",
      "## Still code",
      "```",
      "````",
    ].join("\n");
    expect(slugifyHeadings(md).map((h) => [h.depth, h.id])).toEqual([
      [2, "setup"],
      [3, "setup-2"],
      [2, "setup-3"],
    ]);
  });

  it("never hands out an id twice, even when a heading's own text ends in a number", () => {
    const ids = slugifyHeadings("## Example\n## Example\n## Example 2\n").map((h) => h.id);
    expect(ids).toEqual(["example", "example-2", "example-2-2"]);
  });

  it("drops link targets and emphasis from the text", () => {
    expect(slugifyHeadings("## Read [the ledger](/docs/api) **now**")).toEqual([
      { depth: 2, text: "Read the ledger now", id: "read-the-ledger-now" },
    ]);
  });
});

describe("slugify", () => {
  it("lowercases, joins words with single dashes and trims them", () => {
    expect(slugify("Retries & disabling")).toBe("retries-disabling");
    expect(slugify("  `next_cursor`, then? ")).toBe("next-cursor-then");
    expect(slugify("GET /api/v1/status")).toBe("get-api-v1-status");
  });
});
