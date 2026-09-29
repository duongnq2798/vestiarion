import { z } from "zod";
import { OPERATIONS, type DocOperation, type DocParam } from "@/lib/api/openapi";

/**
 * The MCP tools: one per `/api/v1` operation, generated from `OPERATIONS`
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M3).
 *
 * A tool's input schema is built only from the operation's `DocParam`s, the
 * same metadata the OpenAPI document and the reference pages are built from,
 * so a tool cannot take an argument the API does not, or refuse one it takes.
 * A call runs the operation's own route (`src/lib/mcp/call.ts`), so the
 * route still has the last word on every value.
 */

export interface McpTool {
  name: string;
  operationId: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: { readOnlyHint: true; openWorldHint: false; idempotentHint: true };
}

/** `list-invoices` → `list_invoices`. */
export function toolName(operationId: string): string {
  return operationId.replaceAll("-", "_");
}

const PAGING = "Returns one page; pass page.nextCursor back as cursor for the next.";

function paramSchema(param: DocParam): z.ZodType {
  let schema: z.ZodType;
  if (param.type === "integer") {
    let integer = z.number().int();
    if (param.minimum !== undefined) integer = integer.min(param.minimum);
    if (param.maximum !== undefined) integer = integer.max(param.maximum);
    schema = integer;
  } else {
    schema = param.enum ? z.enum(param.enum as [string, ...string[]]) : z.string();
  }
  return (param.required ? schema : schema.optional()).describe(param.description);
}

function toTool(op: DocOperation): McpTool {
  const description = `${op.summary}. ${op.description}`;
  return {
    name: toolName(op.id),
    operationId: op.id,
    title: op.summary,
    description: op.collection ? `${description}\n\n${PAGING}` : description,
    // `z.object` strips a key the operation does not take.
    inputSchema: z.object(Object.fromEntries(op.params.map((param) => [param.name, paramSchema(param)]))),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  };
}

export const MCP_TOOLS: readonly McpTool[] = OPERATIONS.map(toTool);
