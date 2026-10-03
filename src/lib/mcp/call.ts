import { operationById, type DocOperation } from "@/lib/api/openapi";
import { requestUrl } from "@/lib/docs/samples";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as listCounterparties, POST as createCounterparty } from "@/app/api/v1/counterparties/route";
import { GET as getInsights } from "@/app/api/v1/insights/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/v1/invoices/route";
import { GET as verifyLedger } from "@/app/api/v1/ledger/verify/route";
import { GET as listLedgerEntries } from "@/app/api/v1/ledger/route";
import { GET as listMilestones } from "@/app/api/v1/milestones/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { GET as getTreasury } from "@/app/api/v1/treasury/route";
import { argumentName } from "./tools";

/**
 * Runs one `/api/v1` operation for an MCP tool call, in-process
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M3 and M4).
 *
 * The operation's own route handler serves the call, with a `Request` built
 * from the arguments and the caller's `Authorization` header passed through
 * unchanged. A write's arguments are its JSON body, and its `idempotencyKey`
 * is its `Idempotency-Key` header (write API R9). The route authenticates the key, scopes the call to the key's
 * workspace, validates the arguments and pages the result, exactly as it does
 * over HTTP; this module adds no second read path. Its JSON is returned as it
 * is: an error status becomes a tool error the agent can read and correct.
 *
 * Neither the key nor an argument is ever logged: a failure is logged by
 * operation id alone.
 */

/**
 * A type alias rather than an interface, so it is assignable to the SDK's
 * `CallToolResult`, which has an index signature an interface does not meet.
 */
export type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** An operation's route, given the request and its path parameters. */
type Route = (request: Request, params: Record<string, string>) => Promise<Response>;

/** Every operation's handler: a read's `GET`, a write's `POST`. `tests/mcp-call.test.ts` calls each one through here. */
const ROUTES: Record<string, Route> = {
  "get-status": getStatus,
  "list-ledger-entries": listLedgerEntries,
  "verify-ledger": verifyLedger,
  "list-invoices": listInvoices,
  "list-counterparties": listCounterparties,
  "get-counterparty": (request, params) => getCounterparty(request, { params: Promise.resolve({ id: params.id ?? "" }) }),
  "create-counterparty": createCounterparty,
  "create-invoice": createInvoice,
  "list-milestones": listMilestones,
  "get-treasury": getTreasury,
  "get-insights": getInsights,
};

const FAILED = "The operation failed. Try again.";

function text(value: string): ToolResult["content"] {
  return [{ type: "text", text: value }];
}

/**
 * The arguments as the strings a URL carries, trimmed as `requestUrl` trims
 * them. The tool's input schema admits only strings and numbers; anything
 * else is dropped rather than stringified.
 */
function stringValues(args: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    if (typeof value === "string") values[name] = value.trim();
    else if (typeof value === "number" || typeof value === "boolean") values[name] = String(value);
  }
  return values;
}

/**
 * The request a call becomes. A read's arguments are its query and path. A
 * write's header parameters travel as headers, and every other argument is
 * the JSON body, as the tool's schema took it: the route checks it again.
 */
function toRequest(op: DocOperation, args: Record<string, unknown>, authorization: string, origin: string): Request {
  const values = stringValues(args);
  if (op.method === "get") return new Request(requestUrl(op, origin, values), { headers: { authorization } });
  const headers: Record<string, string> = { authorization, "content-type": "application/json" };
  const body: Record<string, unknown> = { ...args };
  for (const param of op.params.filter((candidate) => candidate.in === "header")) {
    const name = argumentName(param);
    if (values[name]) headers[param.name] = values[name];
    delete body[name];
  }
  return new Request(requestUrl(op, origin, {}), { method: "POST", headers, body: JSON.stringify(body) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function callOperation(
  operationId: string,
  args: Record<string, unknown>,
  authorization: string,
  origin: string
): Promise<ToolResult> {
  const op = operationById(operationId);
  const route = Object.hasOwn(ROUTES, operationId) ? ROUTES[operationId] : undefined;
  if (!op || !route) return { content: text("No such operation."), isError: true };

  try {
    const values = stringValues(args);
    const params = Object.fromEntries(op.params.filter((param) => param.in === "path").map((param) => [param.name, values[param.name] ?? ""]));
    const response = await route(toRequest(op, args, authorization, origin), params);
    const body = await response.text();
    if (!response.ok) return { content: text(body), isError: true };
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? { content: text(body), structuredContent: parsed } : { content: text(body) };
  } catch {
    console.error("mcp tool failed", operationId);
    return { content: text(FAILED), isError: true };
  }
}
