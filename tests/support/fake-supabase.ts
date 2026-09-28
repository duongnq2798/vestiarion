import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VestiarionConfig } from "@/lib/config";
import type { VestiarionContext } from "@/lib/context";

/**
 * A real supabase-js client whose network is a recorder. Tests assert on the
 * requests supabase-js actually builds — the filters, bodies and RPC
 * arguments PostgREST would receive — rather than on a mock of the builder.
 */

export interface RecordedRequest {
  method: string;
  /** e.g. `/rest/v1/invoices` or `/rest/v1/rpc/append_ledger_entry` */
  path: string;
  params: URLSearchParams;
  body: unknown;
  /**
   * What supabase-js sent. `Accept` tells a responder what PostgREST would
   * answer: `.single()` asks for `application/vnd.pgrst.object+json`, which
   * PostgREST refuses with a 406 when no row matches, while `.maybeSingle()`
   * asks for an array and gets `[]`.
   */
  headers: Headers;
}

export interface FakeReply {
  status?: number;
  body: unknown;
  /** Extra response headers — e.g. `content-range`, for supabase-js to read a `head: true` count from. */
  headers?: Record<string, string>;
}

export function fakeSupabase(respond: (request: RecordedRequest) => FakeReply = () => ({ body: [] })): {
  client: SupabaseClient;
  requests: RecordedRequest[];
  /** The recorder itself, for a context's `fetch`, so the tenant client a scope builds records too. */
  fetch: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body;
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      params: url.searchParams,
      body: typeof raw === "string" && raw ? JSON.parse(raw) : undefined,
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    const reply = respond(request);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  const client = createClient("https://tests.supabase.invalid", "test-service-role", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: recordingFetch },
  });
  return { client, requests, fetch: recordingFetch };
}

/** An organization context as the DAL builds it, over one recorded fake client. */
export function orgTestContext(input: {
  config: VestiarionConfig; client: SupabaseClient; orgId: string; secretWarnings?: string[]; userId?: string;
}): VestiarionContext {
  return {
    config: input.config, db: input.client, tenantDb: input.client, orgId: input.orgId,
    platformConfig: input.config, secretWarnings: input.secretWarnings, userId: input.userId,
  };
}

/** Whether a request names the organization: a filter, a stamped body, or an RPC argument. */
export function carriesOrg(request: RecordedRequest, orgId: string): boolean {
  if (request.path.startsWith("/rest/v1/rpc/")) {
    return (request.body as Record<string, unknown> | undefined)?.p_org_id === orgId;
  }
  if (request.method === "POST") {
    const rows = Array.isArray(request.body) ? request.body : [request.body];
    return rows.length > 0 && rows.every((row) => (row as Record<string, unknown>)?.org_id === orgId);
  }
  return request.params.get("org_id") === `eq.${orgId}`;
}
