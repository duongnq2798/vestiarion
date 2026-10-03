import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { withIdempotency } from "@/lib/api/idempotency";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { AuthenticatedKey } from "@/lib/platform/api-keys";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `Idempotency-Key` (docs/superpowers/specs/2026-10-03-write-api-design.md R5): a write is done once per key in a
 * workspace; a repeat with the same body gets the first outcome back, a repeat with another body or while the first is
 * in flight gets 409, a 5xx is not kept, and an outcome older than a day is replaced. Against a stand-in for
 * `api_idempotency` that answers as PostgREST does.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const KEY: AuthenticatedKey = { keyId: "1a1a1a1a-0000-4000-8000-00000000001a", orgId: ORG, scopes: ["read", "write"], createdBy: null };
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = Date.parse("2026-10-03T10:00:00Z");

interface Row {
  org_id: string;
  idempotency_key: string;
  request_hash: string;
  status: number | null;
  response: unknown;
  created_at: string;
  completed_at: string | null;
}

/** The table, kept in memory, answering inserts that ignore duplicates, reads, updates and deletes by key. */
function table(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [`${row.org_id}|${row.idempotency_key}`, row]));
  const keyOf = (sent: RecordedRequest) => `${sent.params.get("org_id")?.slice(3)}|${decodeURIComponent(sent.params.get("idempotency_key")?.slice(3) ?? "")}`;
  const fake = fakeSupabase((sent) => {
    if (sent.path !== "/rest/v1/api_idempotency") return { body: [] };
    if (sent.method === "POST") {
      const body = sent.body as Pick<Row, "org_id" | "idempotency_key" | "request_hash">;
      const id = `${body.org_id}|${body.idempotency_key}`;
      if (rows.has(id)) return { status: 201, body: [] };
      const row = { status: null, response: null, completed_at: null, created_at: new Date(NOW).toISOString(), ...body };
      rows.set(id, row);
      return { status: 201, body: [row] };
    }
    const id = keyOf(sent);
    if (sent.method === "GET") return { body: rows.has(id) ? [rows.get(id)] : [] };
    if (sent.method === "PATCH") {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...(sent.body as Partial<Row>) });
      return { body: row ? [rows.get(id)] : [] };
    }
    if (sent.method === "DELETE") {
      const existed = rows.delete(id);
      return { body: existed ? [{ org_id: ORG }] : [] };
    }
    return { body: [] };
  });
  return { rows, fake };
}

function post(body: string, idempotencyKey?: string) {
  return new Request("https://vestiarion.invalid/api/v1/invoices", {
    method: "POST",
    headers: { "content-type": "application/json", ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }) },
    body,
  });
}

function counted(status = 201) {
  let calls = 0;
  const run = async () => {
    calls += 1;
    return NextResponse.json({ data: { id: `invoice-${calls}` } }, { status });
  };
  return { run, calls: () => calls };
}

async function send(fake: ReturnType<typeof table>["fake"], body: string, idempotencyKey: string | undefined, run: () => Promise<NextResponse>) {
  const request = post(body, idempotencyKey);
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => withIdempotency(request, KEY, body, run, { now: () => NOW }));
}

describe("withIdempotency", () => {
  it("runs a write once, and answers a repeat with the same body with the first outcome", async () => {
    const { fake } = table();
    const write = counted();

    const first = await send(fake, '{"amount":"10"}', "order-1001", write.run);
    const again = await send(fake, '{"amount":"10"}', "order-1001", write.run);

    expect(write.calls()).toBe(1);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ data: { id: "invoice-1" } });
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
  });

  it("refuses the same key with a different body, running nothing", async () => {
    const { fake } = table();
    const write = counted();
    await send(fake, '{"amount":"10"}', "order-1002", write.run);

    const other = await send(fake, '{"amount":"99"}', "order-1002", write.run);

    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: { code: "conflict" } });
    expect(write.calls()).toBe(1);
  });

  it("refuses a repeat while the first is still being handled (Review focus 2)", async () => {
    const { fake } = table();
    let finish: (response: NextResponse) => void = () => undefined;
    const slow = () => new Promise<NextResponse>((resolve) => (finish = resolve));

    const first = send(fake, '{"amount":"10"}', "order-1003", slow);
    // Let the first request claim the key before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await send(fake, '{"amount":"10"}', "order-1003", counted().run);
    finish(NextResponse.json({ data: { id: "invoice-1" } }, { status: 201 }));

    expect(second.status).toBe(409);
    expect((await first).status).toBe(201);
  });

  it("keeps no 5xx outcome, so the next try runs the write again", async () => {
    const { fake, rows } = table();
    const failing = counted(500);
    const ok = counted(201);

    expect((await send(fake, '{"amount":"10"}', "order-1004", failing.run)).status).toBe(500);
    expect(rows.size).toBe(0);
    expect((await send(fake, '{"amount":"10"}', "order-1004", ok.run)).status).toBe(201);
    expect(ok.calls()).toBe(1);
  });

  it("keeps a 4xx outcome, as the request itself was answered", async () => {
    const { fake } = table();
    const invalid = counted(400);
    await send(fake, '{"amount":"x"}', "order-1005", invalid.run);
    const again = await send(fake, '{"amount":"x"}', "order-1005", invalid.run);
    expect(again.status).toBe(400);
    expect(invalid.calls()).toBe(1);
  });

  it("replaces an outcome older than a day", async () => {
    const stale: Row = {
      org_id: ORG, idempotency_key: "order-1006", request_hash: "f".repeat(64), status: 201, response: { data: { id: "old" } },
      created_at: new Date(NOW - 25 * 3_600_000).toISOString(), completed_at: new Date(NOW - 25 * 3_600_000).toISOString(),
    };
    const { fake } = table([stale]);
    const write = counted();

    const response = await send(fake, '{"amount":"10"}', "order-1006", write.run);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: "invoice-1" } });
  });

  it.each([
    ["empty", ""],
    ["with a space", "order 1007"],
    ["longer than 255 characters", "x".repeat(256)],
  ])("refuses a key that is %s, running nothing", async (_label, value) => {
    const { fake } = table();
    const write = counted();
    const response = await send(fake, "{}", value, write.run);
    expect(response.status).toBe(400);
    expect(write.calls()).toBe(0);
  });

  it("runs a write with no key at all, keeping nothing", async () => {
    const { fake } = table();
    const write = counted();
    expect((await send(fake, "{}", undefined, write.run)).status).toBe(201);
    expect(fake.requests).toEqual([]);
  });
});

