import { z } from "zod";
import { OPERATIONS, type DocOperation, type DocParam } from "@/lib/api/openapi";

/**
 * The MCP tools: one per `/api/v1` operation, generated from `OPERATIONS`
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M3; write API R9).
 *
 * A tool's input schema is built only from the operation's `DocParam`s and,
 * for a write, its request body schema: the same metadata the OpenAPI
 * document and the reference pages are built from, so a tool cannot take an
 * argument the API does not, or refuse one it takes. A call runs the
 * operation's own route (`src/lib/mcp/call.ts`), so the route still has the
 * last word on every value, and on whether the key may write at all.
 */

export interface McpTool {
  name: string;
  operationId: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /**
   * A read only reads, and asking twice changes nothing. A write adds a
   * record: it changes and removes nothing, and a repeat without the same
   * `idempotencyKey` adds another.
   */
  annotations:
    | { readOnlyHint: true; openWorldHint: false; idempotentHint: true }
    | { readOnlyHint: false; destructiveHint: false; idempotentHint: false; openWorldHint: false };
}

/** `list-invoices` → `list_invoices`. */
export function toolName(operationId: string): string {
  return operationId.replaceAll("-", "_");
}

/** A parameter's argument: its own name, or a header's in camelCase, `Idempotency-Key` → `idempotencyKey`. */
export function argumentName(param: Pick<DocParam, "name" | "in">): string {
  if (param.in !== "header") return param.name;
  const [first = "", ...rest] = param.name.split("-");
  return first.toLowerCase() + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("");
}

const PAGING = "Returns one page; pass page.nextCursor back as cursor for the next.";
const WRITING =
  "Needs a read-and-write key. Pass idempotencyKey, unique to the record, to make a retry safe: a repeat with the same key and arguments adds nothing.";

function paramSchema(param: DocParam): z.ZodType {
  let schema: z.ZodType;
  if (param.type === "integer") {
    let integer = z.number().int();
    if (param.minimum !== undefined) integer = integer.min(param.minimum);
    if (param.maximum !== undefined) integer = integer.max(param.maximum);
    schema = integer;
  } else if (param.type === "string") {
    schema = param.enum ? z.enum(param.enum as [string, ...string[]]) : z.string();
  } else {
    // A new DocParam type must get its own schema here, never fall through to a string.
    const unhandled: never = param.type;
    throw new Error(`No tool schema for parameter type ${String(unhandled)}`);
  }
  return (param.required ? schema : schema.optional()).describe(param.description);
}

function toTool(op: DocOperation): McpTool {
  const description = `${op.summary}. ${op.description}`;
  const params = Object.fromEntries(op.params.map((param) => [argumentName(param), paramSchema(param)]));
  const note = op.collection ? PAGING : op.scope === "write" ? WRITING : null;
  return {
    name: toolName(op.id),
    operationId: op.id,
    title: op.summary,
    description: note ? `${description}\n\n${note}` : description,
    // A read's `z.object` strips a key the operation does not take. A write is
    // as strict as its route: a misspelt field is refused, never dropped.
    inputSchema: op.requestBody ? z.strictObject({ ...op.requestBody.shape, ...params }) : z.object(params),
    annotations:
      op.scope === "write"
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        : { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  };
}

export const MCP_TOOLS: readonly McpTool[] = OPERATIONS.map(toTool);
