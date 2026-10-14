/**
 * A Pipedrive company over HTTP, in memory, for the connector's tests
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md): the OAuth server (token, refresh, revoke) and the
 * company's own API domain (users/me, deals v2 with opaque cursors, archived deals, organizations, persons, stages,
 * pipelines, deal fields, a deal's custom fields, webhooks). Every request is recorded with its host, so a test can say
 * where each token went. Shapes follow Pipedrive's OpenAPI files for API v1 and v2.
 */

export interface FakeDeal {
  id: number;
  title: string;
  value: number | null;
  currency: string;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  org_id: number | null;
  person_id: number | null;
  owner_id: number;
  update_time: string;
  won_time?: string | null;
  local_won_date?: string | null;
  lost_reason?: string | null;
  expected_close_date?: string | null;
  is_archived?: boolean;
  custom_fields?: Record<string, unknown>;
}

export interface Recorded {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

export const COMPANY_ID = 13013937;
export const API_DOMAIN = "https://cedar-and-co.pipedrive.com";

export function fakePipedrive(options: { scope?: string; apiDomain?: string; companyId?: number; admin?: boolean } = {}) {
  const requests: Recorded[] = [];
  const deals = new Map<number, FakeDeal>();
  const organizations = new Map<number, { id: number; name: string }>([[501, { id: 501, name: "Cedar & Co" }]]);
  const persons = new Map<number, { id: number; name: string; emails: Array<{ value: string; primary: boolean; label: string }> }>([
    [601, { id: 601, name: "Rosa Cedar", emails: [{ value: "Rosa@CedarAndCo.example", primary: true, label: "work" }] }],
  ]);
  const fields: Array<{ field_code: string; field_name: string; field_type: string; is_custom_field: boolean }> = [
    { field_code: "title", field_name: "Title", field_type: "varchar", is_custom_field: false },
  ];
  const webhooks: Array<Record<string, unknown>> = [];
  let tokenCount = 0;
  let refreshes = 0;
  const state = {
    /** Answers the next calls with these statuses, by "METHOD /path", once each. */
    fail: new Map<string, Array<{ status: number; headers?: Record<string, string>; body?: unknown }>>(),
    refreshToken: "1:1:refresh-a",
    accessToken: "v1u:access-a",
    refused: new Set<string>(),
    revoked: [] as string[],
    fieldsRefused: null as null | { status: number; body: unknown },
    webhooksRefused: false,
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const list = (items: unknown[], next: string | null = null) => json({ success: true, data: items, additional_data: { next_cursor: next } });

  function page(items: FakeDeal[], query: URLSearchParams) {
    const limit = Number(query.get("limit") ?? 100);
    const start = query.get("cursor") ? Number(Buffer.from(query.get("cursor") as string, "base64url").toString("utf8")) : 0;
    const slice = items.slice(start, start + limit);
    const next = start + limit < items.length ? Buffer.from(String(start + limit), "utf8").toString("base64url") : null;
    return list(slice, next);
  }

  function dealsMatching(query: URLSearchParams, archived: boolean): FakeDeal[] {
    const statuses = (query.get("status") ?? "open,won,lost").split(",");
    const since = query.get("updated_since");
    const ids = query.get("ids")?.split(",").map(Number) ?? null;
    return [...deals.values()]
      .filter((deal) => (deal.is_archived === true) === archived)
      .filter((deal) => statuses.includes(deal.status))
      .filter((deal) => (since ? deal.update_time >= since : true))
      .filter((deal) => (ids ? ids.includes(deal.id) : true))
      .sort((a, b) => (a.update_time === b.update_time ? a.id - b.id : a.update_time.localeCompare(b.update_time)));
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    requests.push({ method, host: url.host, path: url.pathname, query: url.searchParams, headers, body });
    const queued = state.fail.get(`${method} ${url.pathname}`);
    if (queued && queued.length > 0) {
      const next = queued.shift() as { status: number; headers?: Record<string, string>; body?: unknown };
      return json(next.body ?? { success: false, error: "failure" }, next.status, next.headers);
    }

    if (url.host === "oauth.pipedrive.com") {
      const form = new URLSearchParams(body);
      if (url.pathname === "/oauth/revoke") {
        state.revoked.push(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname !== "/oauth/token") return json({ error: "not_found" }, 404);
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== state.refreshToken) return json({ error: "invalid_grant" }, 400);
        refreshes += 1;
        tokenCount += 1;
        // A rotated refresh token: the store must keep the new one.
        state.refreshToken = `1:1:refresh-${String.fromCharCode(97 + tokenCount)}`;
        state.accessToken = `v1u:access-${String.fromCharCode(97 + tokenCount)}`;
      }
      return json({
        access_token: state.accessToken,
        token_type: "Bearer",
        refresh_token: state.refreshToken,
        scope: options.scope ?? "base,deals:full,contacts:read,deal-fields:full,users:read,recents:read,webhooks:full",
        expires_in: 3599,
        api_domain: options.apiDomain ?? API_DOMAIN,
      });
    }

    if (`https://${url.host}` !== (options.apiDomain ?? API_DOMAIN)) return json({ error: "unknown host" }, 404);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (state.refused.has(token)) return json({ success: false, error: "unauthorized access", errorCode: 401 }, 401);

    const path = url.pathname;
    if (path === "/api/v1/users/me") {
      return json({
        success: true,
        data: {
          id: 7001,
          name: "Owen Owner",
          is_admin: options.admin ?? true,
          access: [{ app: "sales", admin: options.admin ?? true }],
          company_id: options.companyId ?? COMPANY_ID,
          company_name: "Cedar & Co",
          company_domain: "cedar-and-co",
        },
      });
    }
    if (path === "/api/v2/deals" && method === "GET") return page(dealsMatching(url.searchParams, false), url.searchParams);
    if (path === "/api/v2/deals/archived" && method === "GET") return page(dealsMatching(url.searchParams, true), url.searchParams);
    const one = /^\/api\/v2\/deals\/(\d+)$/.exec(path);
    if (one) {
      const deal = deals.get(Number(one[1]));
      if (!deal) return json({ success: false, error: "Deal not found" }, 404);
      if (method === "PATCH") {
        const patch = JSON.parse(body) as { custom_fields?: Record<string, unknown> };
        deal.custom_fields = { ...(deal.custom_fields ?? {}), ...(patch.custom_fields ?? {}) };
        return json({ success: true, data: deal });
      }
      const wanted = url.searchParams.get("custom_fields")?.split(",") ?? Object.keys(deal.custom_fields ?? {});
      const custom = Object.fromEntries(wanted.map((code) => [code, deal.custom_fields?.[code] ?? null]));
      return json({ success: true, data: { ...deal, is_deleted: deal.status === "deleted", custom_fields: custom } });
    }
    const byIds = (map: Map<number, unknown>) => {
      const ids = url.searchParams.get("ids")?.split(",").map(Number) ?? [...map.keys()];
      return list(ids.flatMap((id) => (map.has(id) ? [map.get(id)] : [])));
    };
    if (path === "/api/v2/organizations") return byIds(organizations);
    if (path === "/api/v2/persons") return byIds(persons);
    if (path === "/api/v2/stages") {
      return list([
        { id: 1, name: "Qualified", pipeline_id: 1 },
        { id: 4, name: "Negotiation", pipeline_id: 1 },
      ]);
    }
    if (path === "/api/v2/pipelines") return list([{ id: 1, name: "Sales" }]);
    if (path === "/api/v2/dealFields" && method === "GET") return list(fields);
    if (path === "/api/v2/dealFields" && method === "POST") {
      if (state.fieldsRefused) return json(state.fieldsRefused.body, state.fieldsRefused.status);
      const made = JSON.parse(body) as { field_name: string; field_type: string };
      const code = `${(fields.length * 7919).toString(16).padStart(8, "0")}${"a".repeat(32)}`.slice(0, 40);
      const field = { field_code: code, field_name: made.field_name, field_type: made.field_type, is_custom_field: true };
      fields.push(field);
      return json({ success: true, data: field });
    }
    if (path === "/api/v1/webhooks" && method === "GET") return json({ success: true, data: webhooks });
    if (path === "/api/v1/webhooks" && method === "POST") {
      if (state.webhooksRefused) return json({ success: false, error: "forbidden" }, 403);
      const made = { id: webhooks.length + 900, is_active: 1, ...(JSON.parse(body) as Record<string, unknown>) };
      webhooks.push(made);
      return json({ success: true, data: made }, 201);
    }
    const hook = /^\/api\/v1\/webhooks\/(\d+)$/.exec(path);
    if (hook && method === "DELETE") {
      const at = webhooks.findIndex((item) => item.id === Number(hook[1]));
      if (at >= 0) webhooks.splice(at, 1);
      return json({ success: true });
    }
    return json({ success: false, error: `no route ${method} ${path}` }, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    requests,
    deals,
    organizations,
    persons,
    fields,
    webhooks,
    state,
    refreshes: () => refreshes,
    addDeal(deal: Partial<FakeDeal> & { id: number }) {
      const full: FakeDeal = {
        title: `Deal ${deal.id}`,
        value: 200,
        currency: "USD",
        status: "open",
        stage_id: 1,
        pipeline_id: 1,
        org_id: 501,
        person_id: 601,
        owner_id: 7001,
        update_time: "2026-10-14T08:00:00Z",
        expected_close_date: "2026-10-30",
        ...deal,
      };
      deals.set(full.id, full);
      return full;
    },
  };
}
