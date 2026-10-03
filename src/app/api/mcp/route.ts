import { createMcpHandler } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { bearerToken } from "@/lib/agent-security";
import { guardApiRequest } from "@/lib/api/guard";
import { callOperation } from "@/lib/mcp/call";
import { MCP_TOOLS } from "@/lib/mcp/tools";

/**
 * The remote MCP server: the `/api/v1` operations as tools an AI agent can
 * call (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M1–M4). Any
 * key may connect; a write tool's route answers a read-only key with `403`,
 * which the agent receives as a tool error (write API R9).
 *
 * A request authenticates exactly as a `/api/v1` request does, with a
 * workspace API key in the `Authorization` header, and nowhere else: not the
 * query string, not the MCP `_meta`. The key is checked before the request
 * reaches the MCP handler, so a refused request is answered with the API's
 * own error body and never parsed as JSON-RPC.
 *
 * The handler is built once. Its server factory runs per request, as
 * `createMcpHandler` serves statelessly, and the caller's key reaches each
 * tool through the request's `authInfo`: the same mechanism `withMcpAuth`
 * uses, without its OAuth challenge, which would point a client at an
 * authorization server this API does not have. A tool call runs the
 * operation's own route in-process with that key (`callOperation`), so the
 * route checks it again and serves that key's workspace and no other.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const CHALLENGE = 'Bearer realm="vestiarion"';

/**
 * The header a tool call passes on: the key this request was admitted with.
 * Without one the operation's route answers 401, which the agent reads as a
 * tool error; the handler below always sets it.
 */
function authorizationOf(authInfo: AuthInfo | undefined): string {
  return authInfo ? `Bearer ${authInfo.token}` : "";
}

/**
 * The origin a tool call's `Request` is built on. The operation runs
 * in-process, so it only has to give the route a well-formed URL; the SDK
 * passes the original request in both protocol eras.
 */
function originOf(request: Request | undefined): string {
  return request ? new URL(request.url).origin : "http://localhost";
}

const serve = createMcpHandler(
  (server) => {
    for (const tool of MCP_TOOLS) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
        (args, ctx) => callOperation(tool.operationId, args, authorizationOf(ctx.http?.authInfo), originOf(ctx.http?.req))
      );
    }
  },
  {
    serverInfo: { name: "vestiarion", version: "1.0.0" },
    // `registerTool` advertises `listChanged: true` unless told otherwise, and
    // a 2026-era `subscriptions/listen` for it would then hold an SSE stream
    // open on keep-alives until `maxDuration`. The tool list is fixed at
    // build time, so there is never a change to announce, and a listen
    // request is acknowledged and completed at once.
    capabilities: { tools: { listChanged: false } },
  }
);

async function handler(request: Request): Promise<Response> {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) {
    const { denied } = guard;
    if (denied.status === 401) denied.headers.set("WWW-Authenticate", CHALLENGE);
    if (denied.status === 403) denied.headers.set("WWW-Authenticate", `${CHALLENGE}, error="insufficient_scope", scope="read"`);
    return denied;
  }

  // The guard admitted the header, so it holds exactly `Bearer <token>`.
  const token = bearerToken(request.headers.get("authorization")) ?? "";
  request.auth = { token, clientId: guard.key.keyId, scopes: [...guard.key.scopes] };
  return serve(request);
}

export { handler as GET, handler as POST, handler as DELETE };
