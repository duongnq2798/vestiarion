import { describe, expect, it } from "vitest";
import { slugify, slugifyHeadings, stripFences } from "@/lib/docs/headings";

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

describe("heading text, as MDX renders it", () => {
  const ids = (md: string) => slugifyHeadings(md).map((h) => [h.text, h.id]);

  it("keeps code spans verbatim, tags and all", () => {
    expect(ids("## The `<Callout>` component")).toEqual([["The <Callout> component", "the-callout-component"]]);
    expect(ids("## Send `Authorization: Bearer <key>`")).toEqual([["Send Authorization: Bearer <key>", "send-authorization-bearer-key"]]);
    expect(ids("## Sort by `**seq**` and `[a](b)`")).toEqual([["Sort by **seq** and [a](b)", "sort-by-seq-and-a-b"]]);
    expect(ids("## Use ``a ` tick``")).toEqual([["Use a ` tick", "use-a-tick"]]);
  });

  it("decodes named, decimal and hex character references, outside code only", () => {
    expect(ids("## Q&amp;A")).toEqual([["Q&A", "q-a"]]);
    expect(ids("## Caf&eacute; &#35;1 &#x41;")).toEqual([["Café #1 A", "caf-1-a"]]);
    expect(ids("## Keep `&amp;` &notanentity;")).toEqual([["Keep &amp; &notanentity;", "keep-amp-notanentity"]]);
    expect(ids("## A &lt;b&gt; tag")).toEqual([["A <b> tag", "a-b-tag"]]);
  });

  it("reads a reference link as its label when the reference is defined, and literally when it is not", () => {
    expect(ids("## Use [the ref][r]\n\n[r]: /docs/api\n")).toEqual([["Use the ref", "use-the-ref"]]);
    expect(ids("## Use [the ref][]\n## Use [the ref]\n\n[The Ref]: /docs/api\n").map(([, id]) => id)).toEqual(["use-the-ref", "use-the-ref-2"]);
    expect(ids("## Use [the ref][missing]")).toEqual([["Use [the ref][missing]", "use-the-ref-missing"]]);
  });

  it("strips JSX tags, emphasis and strikethrough, but not escaped or intraword markers", () => {
    expect(ids("## The <Badge tone=\"agent\">GET</Badge> call")).toEqual([["The GET call", "the-get-call"]]);
    expect(ids("## ***Very*** ~~old~~ new_field_name")).toEqual([["Very old new_field_name", "very-old-new-field-name"]]);
    expect(ids("## Not \\*emphasis\\*")).toEqual([["Not *emphasis*", "not-emphasis"]]);
  });
});

describe("stripFences", () => {
  it("blanks fenced code, keeping every line so positions still line up", () => {
    const md = "a\n```md\n## x\n[l](/docs/nope)\n```\nb\n~~~~\n~~~\n~~~~\nc";
    expect(stripFences(md)).toBe("a\n\n\n\n\nb\n\n\n\nc");
  });
});
