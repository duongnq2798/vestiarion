import crypto from "node:crypto";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./fake-supabase";

/**
 * A small PostgREST in memory, behind a real supabase-js client (`fakeSupabase`): rows kept per table, the filters
 * supabase-js writes (`eq`, `neq`, `is`, `gt`, `gte`, `lt`, `lte`, `in`), `order` and `limit`, inserts with defaults
 * and unique keys (a clash is PostgREST's 409 with `23505`), updates and deletes that answer the rows they touched, and
 * `.single()`'s 406 when no row matches. Embedded resources and column lists are not read: a select answers whole
 * rows. RPCs answer what the test gives them. Enough to run a flow through its routes and commands in-process, and
 * to assert on the rows it leaves, where a recorder alone would only show the requests.
 */

export type Row = Record<string, unknown>;

export interface TableSpec {
  /** Columns filled in on insert when absent. */
  defaults?: () => Row;
  /** Column sets that must be unique together. */
  unique?: string[][];
}

export interface MemoryPostgrest {
  tables: Record<string, Row[]>;
  rows(table: string): Row[];
  requests: RecordedRequest[];
  client: ReturnType<typeof fakeSupabase>["client"];
  fetch: typeof fetch;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function splitList(list: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of list) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else current += char;
  }
  values.push(current);
  return values;
}

function compare(left: unknown, right: string): number {
  if (left === null || left === undefined) return NaN;
  const text = String(left);
  const leftTime = Date.parse(text);
  const rightTime = Date.parse(right);
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && /^\d{4}-\d{2}-\d{2}/.test(right) && !Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return leftTime - rightTime;
  const leftNumber = Number(text);
  const rightNumber = Number(right);
  if (text !== "" && right !== "" && !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber;
  return text < right ? -1 : text > right ? 1 : 0;
}

function matches(row: Row, column: string, filter: string): boolean {
  const dot = filter.indexOf(".");
  const operator = filter.slice(0, dot);
  const value = filter.slice(dot + 1);
  const cell = row[column];
  switch (operator) {
    case "eq":
      return cell !== null && cell !== undefined && String(cell) === value;
    case "neq":
      return cell === null || cell === undefined || String(cell) !== value;
    case "is":
      if (value === "null") return cell === null || cell === undefined;
      if (value === "true") return cell === true;
      if (value === "false") return cell === false;
      return false;
    case "gt":
      return compare(cell, value) > 0;
    case "gte":
      return compare(cell, value) >= 0;
    case "lt":
      return compare(cell, value) < 0;
    case "lte":
      return compare(cell, value) <= 0;
    case "in":
      return cell !== null && cell !== undefined && splitList(value.replace(/^\(|\)$/g, "")).includes(String(cell));
    default:
      throw new Error(`memory-postgrest: the filter ${operator} is not supported`);
  }
}

function filtered(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows.filter((row) => [...params].every(([column, filter]) => RESERVED.has(column) || matches(row, column, filter)));
  const order = params.get("order");
  if (order) {
    const [column, direction] = order.split(",")[0].split(".");
    out = [...out].sort((a, b) => {
      const result = compare(a[column], String(b[column] ?? ""));
      return direction === "desc" ? -result : result;
    });
  }
  const limit = params.get("limit");
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

const copy = (row: Row): Row => JSON.parse(JSON.stringify(row));

export function memoryPostgrest(options: { specs?: Record<string, TableSpec>; rpc?: Record<string, (args: Row) => FakeReply>; seed?: Record<string, Row[]> } = {}): MemoryPostgrest {
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(options.seed ?? {})) tables[table] = rows.map(copy);
  const specs = options.specs ?? {};
  const rowsOf = (table: string) => (tables[table] ??= []);

  const answer = (request: RecordedRequest, rows: Row[]): FakeReply => {
    const single = (request.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (!single) return { body: rows.map(copy) };
    if (rows.length !== 1) return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null } };
    return { body: copy(rows[0]) };
  };

  const respond = (request: RecordedRequest): FakeReply => {
    if (request.path.startsWith("/rest/v1/rpc/")) {
      const name = request.path.slice("/rest/v1/rpc/".length);
      const handler = options.rpc?.[name];
      if (!handler) return { status: 404, body: { code: "PGRST202", message: `Could not find the function public.${name}`, details: null, hint: null } };
      return handler((request.body as Row) ?? {});
    }
    const table = request.path.slice("/rest/v1/".length);
    const spec = specs[table] ?? {};
    const rows = rowsOf(table);
    switch (request.method) {
      case "GET":
      case "HEAD":
        return answer(request, filtered(rows, request.params));
      case "POST": {
        const incoming = (Array.isArray(request.body) ? request.body : [request.body]) as Row[];
        const added: Row[] = [];
        for (const values of incoming) {
          const row: Row = { ...(spec.defaults?.() ?? {}), ...values };
          for (const key of spec.unique ?? []) {
            if ([...rows, ...added].some((other) => key.every((column) => other[column] !== null && other[column] !== undefined && other[column] === row[column]))) {
              return { status: 409, body: { code: "23505", message: `duplicate key value violates unique constraint "${table}_${key.join("_")}_key"`, details: null, hint: null } };
            }
          }
          added.push(row);
        }
        rows.push(...added);
        return answer(request, added);
      }
      case "PATCH": {
        const touched = filtered(rows, request.params);
        for (const row of touched) Object.assign(row, request.body as Row);
        return answer(request, touched);
      }
      case "DELETE": {
        const gone = filtered(rows, request.params);
        tables[table] = rows.filter((row) => !gone.includes(row));
        return answer(request, gone);
      }
      default:
        throw new Error(`memory-postgrest: ${request.method} is not supported`);
    }
  };

  const fake = fakeSupabase(respond);
  return { tables, rows: rowsOf, requests: fake.requests, client: fake.client, fetch: fake.fetch };
}

/** An id and a time, the defaults most tables have. */
export function withId(extra: () => Row = () => ({})): () => Row {
  return () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...extra() });
}
