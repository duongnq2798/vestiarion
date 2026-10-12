import type { FakeReply, RecordedRequest } from "./fake-supabase";

/**
 * A small in-memory workspace behind the fake Supabase client, for the deal domain and command tests: the tables a deal
 * touches, filtered as PostgREST filters them (`eq`, `in`, `is`, `not.is`), and `create_deal` and `revise_deal` doing in
 * JavaScript what migration 0104's functions do. The SQL itself is held by `tests/deals-migration.test.ts` on PGlite.
 */

export type Row = Record<string, unknown>;

export interface DealStore {
  counterparties: Row[];
  deals: Row[];
  deal_versions: Row[];
  deal_lines: Row[];
  invoices: Row[];
  ledger_entries: Row[];
  shadow_modes: Row[];
  /** Answer a table's or function's requests with this instead (a missing table, a failure). */
  override: Record<string, FakeReply | undefined>;
}

export function emptyStore(over: Partial<DealStore> = {}): DealStore {
  return { counterparties: [], deals: [], deal_versions: [], deal_lines: [], invoices: [], ledger_entries: [], shadow_modes: [], override: {}, ...over };
}

// One workspace: the DAL stamps every request with its org_id, which the store does not keep apart.
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "org_id"]);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key)) continue;
    const field = key.startsWith("detail->>") ? String((row.detail as Row | undefined)?.[key.slice("detail->>".length)] ?? "") : row[key];
    if (value.startsWith("eq.")) {
      if (String(field) !== value.slice(3)) return false;
    } else if (value === "is.null") {
      if (field !== null && field !== undefined) return false;
    } else if (value === "not.is.null") {
      if (field === null || field === undefined) return false;
    } else if (value.startsWith("in.(")) {
      const options = value.slice(4, -1).split(",").map((option) => option.replace(/^"|"$/g, ""));
      if (!options.includes(String(field))) return false;
    }
  }
  return true;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`;

function withCounterparty(store: DealStore, row: Row, select: string | null): Row {
  if (!select?.includes("counterparties(")) return row;
  const counterparty = store.counterparties.find((candidate) => candidate.id === row.counterparty_id);
  return { ...row, counterparties: counterparty ? { name: counterparty.name } : null };
}

function createDeal(store: DealStore, body: Row): FakeReply {
  const deal = body.p_deal as Row;
  const existing = store.deals.find((row) => row.idempotency_key === deal.idempotencyKey);
  if (existing) return { body: { id: existing.id, created: false } };
  if (deal.externalRef && store.deals.some((row) => row.external_ref === deal.externalRef)) {
    return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "deals_external_ref_key"' } };
  }
  const id = nextId("dddddddd");
  const now = new Date().toISOString();
  store.deals.push({
    id,
    org_id: body.p_org_id,
    counterparty_id: deal.counterpartyId,
    title: deal.title,
    currency: deal.currency,
    minor_digits: deal.minorDigits,
    total_minor: deal.totalMinor,
    starts_on: deal.startsOn,
    terms_days: deal.termsDays,
    external_ref: deal.externalRef ?? null,
    template: deal.template,
    status: "active",
    current_version: 1,
    auto_release: deal.autoRelease === true,
    auto_release_by: deal.autoRelease ? deal.createdBy : null,
    auto_release_at: deal.autoRelease ? now : null,
    idempotency_key: deal.idempotencyKey,
    created_by: deal.createdBy,
    created_at: now,
  });
  store.deal_versions.push({ deal_id: id, version: 1, kind: "signed", total_minor: deal.totalMinor, reason: null, changes: [], idempotency_key: null, created_by: deal.createdBy, created_at: now });
  for (const line of body.p_lines as Row[]) {
    store.deal_lines.push({
      id: nextId("11111111"),
      deal_id: id,
      added_in: 1,
      position: line.position,
      kind: "charge",
      label: line.label,
      invoice_on: line.invoiceOn,
      due_on: line.dueOn,
      amount_minor: line.amountMinor,
      rounding_minor: line.roundingMinor ?? 0,
      replaces: null,
      status: "planned",
      ended_in: null,
      released_at: null,
      released_by: null,
      released_via: null,
    });
  }
  return { body: { id, created: true } };
}

function reviseDeal(store: DealStore, body: Row): FakeReply {
  const revision = body.p_revision as Row;
  const made = store.deal_versions.find((row) => row.deal_id === body.p_deal_id && row.idempotency_key === revision.idempotencyKey);
  if (made) return { body: { version: made.version, created: false } };
  const deal = store.deals.find((row) => row.id === body.p_deal_id);
  if (!deal) return { status: 400, body: { code: "P0001", message: "deal_not_found" } };
  if (deal.current_version !== body.p_base_version) return { status: 400, body: { code: "P0001", message: "deal_changed" } };
  const version = (deal.current_version as number) + 1;
  for (const end of revision.end as Row[]) {
    const line = store.deal_lines.find((row) => row.id === end.id && row.status === "planned");
    if (!line) return { status: 400, body: { code: "P0001", message: "deal_line_not_planned" } };
  }
  store.deal_versions.push({
    deal_id: deal.id,
    version,
    kind: revision.kind,
    total_minor: revision.totalMinor,
    reason: revision.reason ?? null,
    changes: revision.changes ?? [],
    idempotency_key: revision.idempotencyKey ?? null,
    created_by: revision.createdBy ?? null,
    created_at: new Date().toISOString(),
  });
  for (const end of revision.end as Row[]) Object.assign(store.deal_lines.find((row) => row.id === end.id) as Row, { status: end.status, ended_in: version });
  for (const line of revision.add as Row[]) {
    store.deal_lines.push({
      id: nextId("22222222"),
      deal_id: deal.id,
      added_in: version,
      position: line.position,
      kind: line.kind,
      label: line.label,
      invoice_on: line.invoiceOn,
      due_on: line.dueOn,
      amount_minor: line.amountMinor,
      rounding_minor: 0,
      replaces: line.replaces ?? null,
      status: "planned",
      ended_in: null,
      released_at: null,
      released_by: null,
      released_via: null,
    });
  }
  Object.assign(deal, {
    current_version: version,
    total_minor: revision.totalMinor,
    status: revision.kind === "cancelled" ? "cancelled" : revision.kind === "reopened" ? "active" : deal.status,
  });
  return { body: { version, created: true } };
}

/** The responder for `fakeSupabase`, over the store. */
export function dealStoreResponder(store: DealStore) {
  return (request: RecordedRequest): FakeReply => {
    const name = request.path.replace("/rest/v1/", "").replace("rpc/", "");
    const override = store.override[name];
    if (override) return override;
    if (name === "create_deal") return createDeal(store, request.body as Row);
    if (name === "revise_deal") return reviseDeal(store, request.body as Row);
    const table = (store as unknown as Record<string, Row[] | undefined>)[name];
    if (!Array.isArray(table)) return { body: [] };
    const select = request.params.get("select");
    if (request.method === "GET") {
      const rows = table.filter((row) => matches(row, request.params)).map((row) => withCounterparty(store, row, select));
      // `.single()` asks for one object.
      return { body: request.headers.get("accept")?.includes("vnd.pgrst.object") ? (rows[0] ?? null) : rows };
    }
    if (request.method === "POST") {
      const bodies = (Array.isArray(request.body) ? request.body : [request.body]) as Row[];
      const inserted: Row[] = [];
      for (const body of bodies) {
        if (name === "invoices" && body.deal_line_id && table.some((row) => row.deal_line_id === body.deal_line_id)) {
          return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "invoices_deal_line_key"' } };
        }
        const row = { id: nextId("33333333"), status: name === "invoices" ? "pending" : undefined, ...body };
        table.push(row);
        inserted.push(row);
      }
      return { status: 201, body: request.headers.get("accept")?.includes("vnd.pgrst.object") ? inserted[0] : inserted };
    }
    if (request.method === "PATCH") {
      const changed = table.filter((row) => matches(row, request.params));
      for (const row of changed) Object.assign(row, request.body as Row);
      return { body: changed };
    }
    return { body: [] };
  };
}
