import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { OPERATIONS, type DocParam } from "@/lib/api/openapi";
import type { ToolResult } from "@/lib/mcp/call";
import { argumentName, MCP_TOOLS, toolName, type McpTool } from "@/lib/mcp/tools";

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

  it("marks a read's tool read-only and idempotent, and a write's as adding records, not idempotent (write API R9)", () => {
    for (const op of OPERATIONS) {
      expect(tool(toolName(op.id)).annotations, op.id).toEqual(
        op.scope === "write"
          ? { readOnlyHint: false, destructiveHint: op.destructive === true, idempotentHint: false, openWorldHint: false }
          : { readOnlyHint: true, openWorldHint: false, idempotentHint: true }
      );
    }
    expect(MCP_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual([
      "create_counterparty",
      "create_invoice",
      "create_milestone",
      "create_payee_link",
    ]);
  });

  it("says a payee link's tool can undo something: a new link revokes the payee's unused one (write API part 2, W3)", () => {
    expect(tool("create_payee_link").annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(MCP_TOOLS.filter((t) => !t.annotations.readOnlyHint && t.annotations.destructiveHint).map((t) => t.name)).toEqual(["create_payee_link"]);
  });

  it("offers an idempotencyKey, and tells the agent about it, only for a write that takes one (write API part 2, W3)", () => {
    for (const op of OPERATIONS.filter((candidate) => candidate.scope === "write")) {
      const t = tool(toolName(op.id));
      const keyed = op.params.some((param) => param.name === "Idempotency-Key");
      expect(Object.hasOwn(t.inputSchema.shape, "idempotencyKey"), op.id).toBe(keyed);
      expect(t.description.includes("idempotencyKey"), op.id).toBe(keyed);
    }
    expect(Object.hasOwn(tool("create_milestone").inputSchema.shape, "idempotencyKey")).toBe(true);
    expect(Object.hasOwn(tool("create_payee_link").inputSchema.shape, "idempotencyKey")).toBe(false);
  });

  it("titles and describes each tool from its operation, and tells a collection how to page", () => {
    for (const op of OPERATIONS) {
      const t = tool(toolName(op.id));
      expect(t.title).toBe(op.summary);
      expect(t.description.startsWith(`${op.summary}. ${op.description}`)).toBe(true);
      expect(t.description.includes("pass page.nextCursor back as cursor")).toBe(op.collection);
      expect(t.description.includes("Needs a read-and-write key.")).toBe(op.scope === "write");
    }
  });

  it("names a header parameter's argument in camelCase", () => {
    expect(argumentName({ name: "Idempotency-Key", in: "header" } as DocParam)).toBe("idempotencyKey");
    expect(argumentName({ name: "counterpartyId", in: "query" } as DocParam)).toBe("counterpartyId");
  });

  it("takes exactly the operation's body fields and parameters, requiring only the required ones", () => {
    for (const op of OPERATIONS) {
      const shape = tool(toolName(op.id)).inputSchema.shape;
      const fields = op.requestBody ? Object.keys(op.requestBody.shape) : [];
      expect(Object.keys(shape), op.id).toEqual([...fields, ...op.params.map(argumentName)]);
      for (const field of fields) expect(shape[field], `${op.id}.${field}`).toBe(op.requestBody!.shape[field]);
      for (const p of op.params) {
        expect(shape[argumentName(p)].safeParse(undefined).success, `${op.id}.${p.name}`).toBe(!p.required);
        expect(shape[argumentName(p)].description).toBe(p.description);
      }
    }
  });

  it("accepts each operation's example parameters, and a write's example body", () => {
    for (const op of OPERATIONS) {
      const example = {
        ...(op.requestExample ?? {}),
        ...Object.fromEntries(op.params.filter((p) => p.example !== undefined).map((p) => [argumentName(p), p.example])),
      };
      expect(tool(toolName(op.id)).inputSchema.safeParse(example).success, op.id).toBe(true);
    }
  });

  it("refuses a field a write does not take, as its route would, rather than dropping it", () => {
    const op = OPERATIONS.find((candidate) => candidate.id === "create-invoice")!;
    expect(tool("create_invoice").inputSchema.safeParse({ ...op.requestExample, vendor: "Acme" }).success).toBe(false);
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
