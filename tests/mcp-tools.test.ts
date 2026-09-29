import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import type { ToolResult } from "@/lib/mcp/call";
import { MCP_TOOLS, toolName, type McpTool } from "@/lib/mcp/tools";

/**
 * The MCP tools are the `/api/v1` operations, generated
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M3 and §4).
 */

function tool(name: string) {
  const found = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("MCP_TOOLS", () => {
  it("has one tool per operation, in the same order, and nothing else", () => {
    expect(MCP_TOOLS.map((t) => t.operationId)).toEqual(OPERATIONS.map((op) => op.id));
  });

  it("names each tool after its operation id in snake_case", () => {
    expect(toolName("list-invoices")).toBe("list_invoices");
    expect(toolName("list-ledger-entries")).toBe("list_ledger_entries");
    for (const t of MCP_TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.name).toBe(toolName(t.operationId));
    }
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  it("marks every tool read-only, closed-world and idempotent", () => {
    for (const t of MCP_TOOLS) {
      expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false, idempotentHint: true });
    }
  });

  it("titles and describes each tool from its operation, and tells a collection how to page", () => {
    for (const op of OPERATIONS) {
      const t = tool(toolName(op.id));
      expect(t.title).toBe(op.summary);
      expect(t.description.startsWith(`${op.summary}. ${op.description}`)).toBe(true);
      expect(t.description.includes("pass page.nextCursor back as cursor")).toBe(op.collection);
    }
  });

  it("takes exactly the operation's parameters, requiring only the required ones", () => {
    for (const op of OPERATIONS) {
      const shape = tool(toolName(op.id)).inputSchema.shape;
      expect(Object.keys(shape)).toEqual(op.params.map((p) => p.name));
      for (const p of op.params) {
        expect(shape[p.name].safeParse(undefined).success, `${op.id}.${p.name}`).toBe(!p.required);
        expect(shape[p.name].description).toBe(p.description);
      }
    }
  });

  it("accepts each operation's example parameters", () => {
    for (const op of OPERATIONS) {
      const example = Object.fromEntries(op.params.filter((p) => p.example !== undefined).map((p) => [p.name, p.example]));
      expect(tool(toolName(op.id)).inputSchema.safeParse(example).success, op.id).toBe(true);
    }
  });
});

describe("the SDK's types", () => {
  it("take a tool's input schema and a call's result as they are", () => {
    expectTypeOf<McpTool["inputSchema"]>().toExtend<StandardSchemaWithJSON>();
    expectTypeOf<ToolResult>().toExtend<CallToolResult>();
  });
});

describe("list_invoices' input schema", () => {
  const schema = tool("list_invoices").inputSchema;

  it("accepts a limit within bounds and a known status", () => {
    expect(schema.safeParse({ limit: 5, status: "held" })).toEqual({ success: true, data: { limit: 5, status: "held" } });
  });

  it.each([
    ["a limit over the maximum", { limit: 500 }],
    ["a limit under the minimum", { limit: 0 }],
    ["a fractional limit", { limit: 1.5 }],
    ["a limit that is not a number", { limit: "abc" }],
    ["an unknown status", { status: "bogus" }],
    ["an unknown direction", { direction: "sideways" }],
  ])("rejects %s", (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("strips a key the operation does not take", () => {
    expect(schema.parse({ limit: 5, key: "vxk_should_not_travel" })).toEqual({ limit: 5 });
  });
});

describe("get_counterparty's input schema", () => {
  it("requires the id", () => {
    const schema = tool("get_counterparty").inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: "dc5e5751-3287-46c9-8bd1-83a42ab02699" }).success).toBe(true);
  });
});
