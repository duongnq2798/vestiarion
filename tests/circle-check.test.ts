import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionRefusedError,
  ForbiddenError,
  InternalServerError,
  RatelimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "@circle-fin/developer-controlled-wallets";
import { checkCircleApiKey, type CircleClientFactory } from "@/lib/circle/check";

/**
 * The API-key check. The fakes throw the SDK's own error classes, which is
 * what its client throws: an Axios failure with a response becomes an
 * `HttpResponseError` carrying the HTTP `status` on the error itself, and one
 * without a response becomes an `HttpRequestError` whose `code` names the
 * network failure (ECONNREFUSED, ETIMEDOUT, ...) and which has no status.
 *
 * Each error's message quotes the key and the secret, standing in for an SDK
 * error that echoes its request: none of it may reach a log line.
 */

const API_KEY = "TEST_API_KEY:check-key-id:check-key-secret-value";
const ENTITY_SECRET = "c0ffee".repeat(10) + "abcd";
const REQUEST = { url: "/v1/w3s/developer/walletSets", method: "GET" };
const LEAKY = `Bearer ${API_KEY} ${ENTITY_SECRET}`;

const logged: string[] = [];

function client(listWalletSets: () => Promise<unknown>): { factory: CircleClientFactory; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(listWalletSets);
  const factory = vi.fn(() => ({ listWalletSets: list }) as unknown as ReturnType<CircleClientFactory>);
  return { factory, list };
}

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 5 }))).join(" "));
    });
  }
});

afterEach(() => {
  for (const line of logged) {
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(ENTITY_SECRET);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("checkCircleApiKey", () => {
  it("answers ok when Circle lists the wallet sets, with one call made with the given credentials", async () => {
    const { factory, list } = client(async () => ({ data: { walletSets: [] } }));
    await expect(checkCircleApiKey(API_KEY, ENTITY_SECRET, factory)).resolves.toBe("ok");
    expect(factory).toHaveBeenCalledWith({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["401", () => new UnauthorizedError({ ...REQUEST, status: 401, code: 156007, message: LEAKY })],
    ["403", () => new ForbiddenError({ ...REQUEST, status: 403, message: LEAKY })],
  ])("answers rejected on a %s", async (_status, error) => {
    const { factory } = client(() => Promise.reject(error()));
    await expect(checkCircleApiKey(API_KEY, ENTITY_SECRET, factory)).resolves.toBe("rejected");
  });

  it("reads the status from an Axios-style response when the error carries one there", async () => {
    const axiosLike = Object.assign(new Error(LEAKY), { response: { status: 401, data: {} } });
    const { factory } = client(() => Promise.reject(axiosLike));
    await expect(checkCircleApiKey(API_KEY, ENTITY_SECRET, factory)).resolves.toBe("rejected");
  });

  it.each([
    ["a 500", () => new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })],
    ["a 503", () => new ServiceUnavailableError({ ...REQUEST, status: 503, message: LEAKY })],
    ["a 429", () => new RatelimitError({ ...REQUEST, status: 429, message: LEAKY })],
    ["a refused connection", () => new ConnectionRefusedError({ ...REQUEST, code: "ECONNREFUSED", message: LEAKY })],
    ["a plain error", () => new Error(LEAKY)],
  ])("answers unreachable on %s", async (_label, error) => {
    const { factory } = client(() => Promise.reject(error()));
    await expect(checkCircleApiKey(API_KEY, ENTITY_SECRET, factory)).resolves.toBe("unreachable");
  });

  it("answers unreachable when the client cannot even be built", async () => {
    const factory = vi.fn(() => {
      throw new Error(LEAKY);
    }) as unknown as CircleClientFactory;
    await expect(checkCircleApiKey(API_KEY, ENTITY_SECRET, factory)).resolves.toBe("unreachable");
  });

  it("answers unreachable when Circle does not answer within 10 s, and not before", async () => {
    vi.useFakeTimers();
    const { factory } = client(() => new Promise<never>(() => {}));
    let answer: string | undefined;
    const pending = checkCircleApiKey(API_KEY, ENTITY_SECRET, factory).then((value) => (answer = value));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(answer).toBe("unreachable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
