import { describe, expect, it } from "vitest";
import { VestiarionError } from "../sdk/src/errors";
import { createTransport, type FetchLike, type TransportOptions } from "../sdk/src/http";
import { VERSION } from "../sdk/src/version";

/** One request, from the SDK to the API and back (TypeScript SDK design R4–R6). */

const KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error;
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function answering(...answers: Answer[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    const next = answers.shift() ?? { status: 500 };
    if (next instanceof Error) throw next;
    return { status: next.status, headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null }, text: async () => next.body ?? "" };
  };
  return { calls, fetch };
}

function transport(fetch: FetchLike, over: Partial<TransportOptions> = {}) {
  const waits: number[] = [];
  const t = createTransport({ apiKey: KEY, baseUrl: "https://api.test/", fetch, maxRetries: 2, timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), random: () => 1, uuid: () => "generated-key", ...over });
  return { t, waits };
}

const ok = (data: unknown, status = 200) => ({ status, body: JSON.stringify({ data }) });
const failure = (status: number, code: string, message = "Said the API.", headers?: Record<string, string>) => ({ status, body: JSON.stringify({ error: { code, message } }), headers });
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (error: unknown) => error as VestiarionError);

describe("a request", () => {
  it("sends the key as a bearer token and its version as the User-Agent, and leaves out empty query values", async () => {
    const { calls, fetch } = answering(ok([]));
    await transport(fetch).t.request({ method: "GET", path: "/api/v1/invoices", query: { limit: 5, status: undefined, cursor: "a+b/c=" } });
    expect(calls[0].url).toBe("https://api.test/api/v1/invoices?limit=5&cursor=a%2Bb%2Fc%3D");
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${KEY}`, "user-agent": `vestiarion-sdk-js/${VERSION}`, accept: "application/json" });
    expect(calls[0].headers).not.toHaveProperty("idempotency-key");
    expect(calls[0].body).toBeUndefined();
  });

  it("returns the answer's JSON", async () => {
    const { fetch } = answering(ok({ id: "i1" }));
    expect(await transport(fetch).t.request({ method: "GET", path: "/api/v1/status" })).toEqual({ data: { id: "i1" } });
  });

  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("throws the API's %i as a VestiarionError with its code and message, and does not retry it", async (status, code) => {
    const { calls, fetch } = answering(failure(status, code));
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toBeInstanceOf(VestiarionError);
    expect(error).toMatchObject({ status, code, message: "Said the API.", retryAfter: null });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("never repeats the key in an error (Review focus 3)", async () => {
    const { fetch } = answering(failure(401, "unauthorized", "A valid API key is required."));
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(`${error.message} ${String(error)} ${JSON.stringify(error)}`).not.toContain(KEY);
  });

  it("retries a 503 and a network failure with backoff, then returns the answer", async () => {
    const { calls, fetch } = answering({ status: 503 }, new TypeError("fetch failed"), ok("done"));
    const { t, waits } = transport(fetch);
    expect(await t.request({ method: "GET", path: "/api/v1/status" })).toEqual({ data: "done" });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("waits as long as Retry-After says on a 429", async () => {
    const { fetch } = answering(failure(429, "rate_limited", "Too many.", { "retry-after": "2" }), ok("done"));
    const { t, waits } = transport(fetch);
    await t.request({ method: "GET", path: "/api/v1/status" });
    expect(waits).toEqual([2000]);
  });

  it("throws a 429 whose Retry-After is more than a minute, without waiting", async () => {
    const { calls, fetch } = answering(failure(429, "rate_limited", "Too many.", { "retry-after": "120" }));
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 120 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("gives up after maxRetries, with the last answer's error", async () => {
    const { calls, fetch } = answering({ status: 503 }, { status: 503 }, { status: 503 });
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 503, code: "unavailable", message: "The API answered HTTP 503." });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("caps the backoff at 8 seconds", async () => {
    const { fetch } = answering({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, ok("done"));
    const { t, waits } = transport(fetch, { maxRetries: 6 });
    await t.request({ method: "GET", path: "/api/v1/status" });
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });

  it("times out an attempt that gets no answer", async () => {
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const error = await caught(transport(fetch, { timeoutMs: 5, maxRetries: 0 }).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 0, code: "timeout" });
  });

  it.each([
    ["a 2xx that is not JSON", { status: 200, body: "<html>" }],
    ["an empty 2xx", { status: 204, body: "" }],
  ])("answers %s with invalid_response, not a crash, and does not retry it (Review focus 2)", async (_label, answer) => {
    const { calls, fetch } = answering(answer);
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(calls).toHaveLength(1);
  });

  it("names the status's code when the body is not the API's", async () => {
    const { fetch } = answering({ status: 502, body: "<html>Bad gateway</html>" });
    const error = await caught(transport(fetch, { maxRetries: 0 }).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 502, code: "internal", message: "The API answered HTTP 502." });
  });
});

describe("a write", () => {
  it("sends its body as JSON with a fresh Idempotency-Key, and repeats the same key and body on a retry", async () => {
    const { calls, fetch } = answering({ status: 503 }, ok({ id: "i1" }, 201));
    await transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: { amount: "0.10" } });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toMatchObject({ "idempotency-key": "generated-key", "content-type": "application/json" });
      expect(call.body).toBe('{"amount":"0.10"}');
    }
  });

  it("sends the caller's Idempotency-Key when given", async () => {
    const { calls, fetch } = answering(ok({}, 201));
    await transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: {}, idempotencyKey: "billing-inv-1" });
    expect(calls[0].headers["idempotency-key"]).toBe("billing-inv-1");
  });

  it("retries a 409 that answers its own retry: the first attempt is still being handled", async () => {
    const { calls, fetch } = answering({ status: 503 }, failure(409, "conflict"), ok({ id: "i1" }, 201));
    const { t, waits } = transport(fetch);
    expect(await t.request({ method: "POST", path: "/api/v1/invoices", body: {} })).toEqual({ data: { id: "i1" } });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("throws a 409 on the first attempt: the caller used a key twice", async () => {
    const { calls, fetch } = answering(failure(409, "conflict"));
    const error = await caught(transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: {} }));
    expect(error).toMatchObject({ status: 409, code: "conflict" });
    expect(calls).toHaveLength(1);
  });

  it("never retries a read's 409", async () => {
    const { calls, fetch } = answering({ status: 503 }, failure(409, "conflict"));
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ code: "conflict" });
    expect(calls).toHaveLength(2);
  });
});
