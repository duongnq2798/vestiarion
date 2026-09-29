import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EndpointTable } from "@/components/docs/EndpointTable";
import { McpToolTable } from "@/components/docs/McpToolTable";
import { ErrorTable } from "@/components/docs/ErrorTable";
import { ParamTable } from "@/components/docs/ParamTable";
import { SchemaTree } from "@/components/docs/SchemaTree";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { STATUS_FOR } from "@/lib/api/contract";
import { jsonSchema, OPERATIONS, operationById } from "@/lib/api/openapi";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { notesHeadings, referenceHeadings, referenceSectionIds, sectionId } from "@/lib/docs/reference";
import { schemaTree } from "@/lib/docs/schema-tree";
import { generateStaticParams } from "@/app/docs/api/[operation]/page";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe("a reference page's sections", () => {
  it("are the fixed sections in page order, with their ids", () => {
    expect(referenceHeadings(null).map((heading) => [heading.text, heading.id])).toEqual([
      ["Parameters", "parameters"],
      ["Try it", "try-it"],
      ["Code samples", "code-samples"],
      ["Response", "response"],
      ["Errors", "errors"],
    ]);
    expect(sectionId("samples")).toBe("code-samples");
    expect(referenceSectionIds(null)).not.toContain("notes");
  });

  it("add Notes and the notes' headings, numbered as one page so no id repeats", () => {
    const headings = referenceHeadings("Some notes.\n\n## Response\n\n### The `cursor`\n");
    expect(headings.map((heading) => heading.id)).toEqual(["parameters", "try-it", "code-samples", "response", "errors", "notes", "response-2", "the-cursor"]);
    expect(notesHeadings(headings).map((heading) => heading.id)).toEqual(["response-2", "the-cursor"]);
  });
});

describe("the reference page route", () => {
  it("prerenders one page per operation", () => {
    expect(generateStaticParams()).toEqual(OPERATIONS.map((op) => ({ operation: op.id })));
  });
});

describe("ParamTable", () => {
  it("says so when an operation takes no parameters", () => {
    expect(html(<ParamTable params={[]} />)).toBe('<p class="my-4 leading-7 text-ink-2">No parameters.</p>');
  });

  it("lists each parameter as a stacked item: name, type, requirement, then description, default and allowed values", () => {
    const params = operationById("list-invoices")!.params;
    const markup = html(<ParamTable params={params} />);
    expect(markup).toMatch(/^<ul aria-label="Parameters" class="[^"]*divide-y/);
    expect(markup).not.toContain("<table");
    expect(markup.match(/<li /g)).toHaveLength(params.length);
    for (const param of params) expect(markup).toContain(`>${param.name}</code>`);
    expect(markup).toContain(">integer</span>");
    expect(markup).toContain(">optional</span>");
    expect(markup).not.toContain(">required</span>");
    // Every parameter here is in the query: only a path parameter says where it goes.
    expect(markup).not.toContain("in: path");
    expect(markup).toContain(">1 to 200<");
    expect(markup).toContain(">50</code>");
    expect(markup).toContain(">receivable</code>");
    expect(markup).not.toContain("`");
    // "Default" and "Allowed" only where a parameter has one.
    expect(markup.match(/>Default:/g)).toHaveLength(params.filter((param) => param.default !== undefined).length);
    const allowed = params.filter((param) => param.enum || param.minimum !== undefined || param.maximum !== undefined);
    expect(markup.match(/>Allowed:/g)).toHaveLength(allowed.length);
    expect(allowed.length).toBeLessThan(params.length);
  });

  it("marks a path parameter required and in the path", () => {
    const markup = html(<ParamTable params={operationById("get-counterparty")!.params} />);
    expect(markup).toContain(">required</span>");
    expect(markup).toContain(">in: path</span>");
    expect(markup).not.toContain(">Default:");
  });
});

describe("SchemaTree", () => {
  it("shows each field's type line and nests objects in a disclosure, the top level open", () => {
    const markup = html(<SchemaTree nodes={schemaTree(jsonSchema(operationById("list-invoices")!.response))} />);
    expect(markup).toContain(">string · nullable</span>");
    expect(markup).toContain(">array of object</span>");
    expect(markup).toMatch(/<details open="" class="disclosure/);
    expect(markup).toContain("Why the agent ruled as it did");
    expect(markup).toContain(">payable</code>");
  });
});

describe("ErrorTable", () => {
  it("gives each code its HTTP status and when it happens", () => {
    const op = operationById("get-counterparty")!;
    const markup = html(<ErrorTable codes={op.errors} />);
    for (const code of op.errors) {
      expect(markup).toContain(`>${code}</code>`);
      expect(markup).toContain(`>${STATUS_FOR[code]}</td>`);
    }
  });
});

describe("EndpointTable", () => {
  it("links every operation's path to its reference page, one table per tag", () => {
    const markup = html(<EndpointTable />);
    for (const op of OPERATIONS) {
      expect(markup).toContain(`href="/docs/api/${op.id}"`);
      expect(markup).toContain(`>${op.summary}</td>`);
    }
    const tags = new Set(OPERATIONS.map((op) => op.tag));
    expect(markup.match(/<table /g)).toHaveLength(tags.size);
    for (const tag of tags) expect(markup).toContain(`aria-label="${tag}"`);
    // A path wraps only after a slash, never inside a segment.
    expect(markup).toContain("/<wbr/>api/<wbr/>v1/<wbr/>counterparties/<wbr/>{id}");
  });
});

describe("McpToolTable", () => {
  it("lists every MCP tool by name, with its arguments and the description the agent receives, linked to its reference page", () => {
    const markup = html(<McpToolTable />);
    expect(MCP_TOOLS.length).toBe(OPERATIONS.length);
    for (const tool of MCP_TOOLS) {
      expect(markup).toContain(`>${tool.name}</code>`);
      expect(markup).toContain(`href="/docs/api/${tool.operationId}"`);
      for (const argument of Object.keys(tool.inputSchema.shape)) expect(markup, `${tool.name} ${argument}`).toContain(`>${argument}</code>`);
    }
    expect(markup.match(/<tr>/g)).toHaveLength(MCP_TOOLS.length + 1);
    // The description as written, its code spans as code.
    expect(markup).toContain("Replays signatures, body hashes and hash-chain continuity");
    expect(markup).toContain(">page.nextCursor</code>");
  });
});
