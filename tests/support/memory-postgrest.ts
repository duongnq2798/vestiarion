import crypto from "node:crypto";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./fake-supabase";

/**
 * A small PostgREST in memory, behind a real supabase-js client (`fakeSupabase`): rows kept per table, the filters
 * supabase-js writes (`eq`, `neq`, `is`, `gt`, `gte`, `lt`, `lte`, `in`, `ov` on an array column, and `or` of them), `order` and `limit`, inserts
 * with defaults and unique keys (a clash is PostgREST's 409 with `23505`), updates and deletes that answer the rows they
 * touched, and `.single()`'s 406 when no row matches. A table's checks refuse an insert or an update that breaks one, as
 * Postgres does (400, `23514`), the whole request at once. An upsert (`on_conflict` with `resolution=ignore-duplicates`
 * or `merge-duplicates`) names a unique key the table has, or is refused as Postgres refuses it (`42P10`); it skips, or
 * merges its own columns into, the row it meets on that key only, and a clash on another key is still a 409. A count
 * asked for (`count=exact`) comes back in `content-range`. A table given its columns refuses a select, a filter or a
 * write that names another, as Postgres (`42703`) and PostgREST (`PGRST204`) do, as before a migration that adds it. A
 * body with half of a surrogate pair in any string (an emoji cut in two) is refused as Postgres refuses its JSON (`22P02`).
 * Embedded resources are not read, and a select answers whole rows. RPCs answer what the test gives them. Enough to run a flow through its routes and commands
 * in-process, and to assert on the rows it leaves, where a recorder alone would only show the requests.
 */

export type Row = Record<string, unknown>;

export interface TableSpec {
  /** Columns filled in on insert when absent. */
  defaults?: () => Row;
  /** Column sets that must be unique together. */
  unique?: string[][];
  /** The table's CHECK constraints, by name: a row written that breaks one is refused. */
  checks?: Array<{ name: string; holds: (row: Row) => boolean }>;
  /** The table's columns, when a test needs a column it lacks refused; any column otherwise. */
  columns?: ReadonlySet<string>;
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
  if (filter.startsWith("not.")) return !matches(row, column, filter.slice(4));
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
    case "ov": {
      // `.overlaps(column, [1, 2])`: an array column sharing any element with `{1,2}`.
      const wanted = splitList(value.replace(/^\{|\}$/g, ""));
      return Array.isArray(cell) && cell.some((element) => wanted.includes(String(element)));
    }
    default:
      throw new Error(`memory-postgrest: the filter ${operator} is not supported`);
  }
}

/** `or=(a.eq.1,b.is.null)`: any of the filters, each `column.operator.value`. */
function anyOf(row: Row, list: string): boolean {
  return splitList(list.replace(/^\(|\)$/g, "")).some((part) => {
    const dot = part.indexOf(".");
    return matches(row, part.slice(0, dot), part.slice(dot + 1));
  });
}

function filtered(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows.filter((row) => [...params].every(([column, filter]) => RESERVED.has(column) || (column === "or" ? anyOf(row, filter) : matches(row, column, filter))));
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

/** Whether a string holds half of a surrogate pair: JSON carries it as a lone `\u` escape, which Postgres refuses. */
function hasLoneSurrogate(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        at += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Whether any string in a request's body, however deep, holds half of a surrogate pair. */
function carriesLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.some(carriesLoneSurrogate);
  if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => hasLoneSurrogate(key) || carriesLoneSurrogate(inner));
  return false;
}

export function memoryPostgrest(
  options: {
    specs?: Record<string, TableSpec>;
    rpc?: Record<string, (args: Row) => FakeReply>;
    seed?: Record<string, Row[]>;
    /**
     * Runs before a request is answered: a test's way to let something else happen at that moment, or, by returning a
     * reply, to answer it in the database's place.
     */
    before?: (request: RecordedRequest) => Promise<FakeReply | void> | FakeReply | void;
  } = {}
): MemoryPostgrest {
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(options.seed ?? {})) tables[table] = rows.map(copy);
  const specs = options.specs ?? {};
  const rowsOf = (table: string) => (tables[table] ??= []);

  const refused = (status: number, code: string, message: string): FakeReply => ({ status, body: { code, message, details: null, hint: null } });
  /** The first check of `table` a row breaks, as Postgres names it. */
  const broken = (table: string, row: Row): FakeReply | null => {
    const check = (specs[table]?.checks ?? []).find((one) => !one.holds(row));
    return check ? refused(400, "23514", `new row for relation "${table}" violates check constraint "${check.name}"`) : null;
  };
  const prefer = (request: RecordedRequest) => request.headers.get("prefer") ?? "";

  const answer = (request: RecordedRequest, rows: Row[], total: number = rows.length): FakeReply => {
    const single = (request.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (prefer(request).includes("count=exact")) return { body: rows.map(copy), headers: { "content-range": rows.length > 0 ? `0-${rows.length - 1}/${total}` : `*/${total}` } };
    if (!single) return { body: rows.map(copy) };
    if (rows.length !== 1) return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null } };
    return { body: copy(rows[0]) };
  };

  const respond = (request: RecordedRequest): FakeReply => {
    // PostgREST hands the body to Postgres as JSON, whose text Postgres refuses with half of a surrogate pair in it.
    if (carriesLoneSurrogate(request.body)) {
      return { status: 400, body: { code: "22P02", message: "invalid input syntax for type json", details: "Unicode low surrogate must follow a high surrogate.", hint: null } };
    }
    if (request.path.startsWith("/rest/v1/rpc/")) {
      const name = request.path.slice("/rest/v1/rpc/".length);
      const handler = options.rpc?.[name];
      if (!handler) return { status: 404, body: { code: "PGRST202", message: `Could not find the function public.${name}`, details: null, hint: null } };
      return handler((request.body as Row) ?? {});
    }
    const table = request.path.slice("/rest/v1/".length);
    const spec = specs[table] ?? {};
    const rows = rowsOf(table);
    if (spec.columns) {
      const known = spec.columns;
      const named = [
        ...(request.params.get("select") ?? "")
          .split(",")
          .map((column) => column.trim())
          .filter((column) => column && column !== "*" && !column.includes("(") && !column.includes(":")),
        ...[...request.params.keys()].filter((key) => !RESERVED.has(key) && key !== "or"),
      ];
      const missing = named.find((column) => !known.has(column));
      if (missing) return refused(400, "42703", `column ${table}.${missing} does not exist`);
      const written = (Array.isArray(request.body) ? request.body : request.body ? [request.body] : []) as Row[];
      const unknown = written.flatMap((row) => Object.keys(row)).find((column) => !known.has(column));
      if (unknown) return refused(400, "PGRST204", `Could not find the '${unknown}' column of '${table}' in the schema cache`);
    }
    switch (request.method) {
      case "GET":
      case "HEAD": {
        const all = filtered(rows, new URLSearchParams([...request.params].filter(([key]) => key !== "limit" && key !== "offset")));
        return answer(request, filtered(rows, request.params), all.length);
      }
      case "POST": {
        const incoming = (Array.isArray(request.body) ? request.body : [request.body]) as Row[];
        // An upsert names the unique key it resolves on, and how: Postgres refuses one that names no such key.
        const onConflict = request.params.get("on_conflict")?.split(",").map((column) => column.trim());
        const resolution = /resolution=(ignore|merge)-duplicates/.exec(prefer(request))?.[1] ?? null;
        const conflictKey = onConflict ? (spec.unique ?? []).find((key) => [...key].sort().join(",") === [...onConflict].sort().join(",")) : undefined;
        if (onConflict && !conflictKey) return refused(400, "42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification");
        const same = (key: string[], a: Row, b: Row) => key.every((column) => a[column] !== null && a[column] !== undefined && a[column] === b[column]);
        const added: Row[] = [];
        const merged: Array<{ row: Row; values: Row }> = [];
        const answered: Row[] = [];
        for (const values of incoming) {
          const row: Row = { ...(spec.defaults?.() ?? {}), ...values };
          const met = conflictKey && resolution ? [...rows, ...added].find((other) => same(conflictKey, other, row)) : undefined;
          if (met && resolution === "ignore") continue;
          if (met) {
            const after = { ...met, ...values };
            const failed = broken(table, after);
            if (failed) return failed;
            merged.push({ row: met, values });
            answered.push(after);
            continue;
          }
          for (const key of spec.unique ?? []) {
            if ([...rows, ...added].some((other) => same(key, other, row))) {
              return refused(409, "23505", `duplicate key value violates unique constraint "${table}_${key.join("_")}_key"`);
            }
          }
          const failed = broken(table, row);
          if (failed) return failed;
          added.push(row);
          answered.push(row);
        }
        rows.push(...added);
        for (const { row, values } of merged) Object.assign(row, values);
        return answer(request, answered);
      }
      case "PATCH": {
        const touched = filtered(rows, request.params);
        for (const row of touched) {
          const failed = broken(table, { ...row, ...(request.body as Row) });
          if (failed) return failed;
        }
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

  const fake = fakeSupabase(async (request) => (await options.before?.(request)) ?? respond(request));
  return { tables, rows: rowsOf, requests: fake.requests, client: fake.client, fetch: fake.fetch };
}

/** An id and a time, the defaults most tables have. */
export function withId(extra: () => Row = () => ({})): () => Row {
  return () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...extra() });
}
