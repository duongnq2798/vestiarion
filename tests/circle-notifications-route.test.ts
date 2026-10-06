import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/circle/notifications` (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2): the raw body
 * and Circle's two headers reach `handleCircleNotification`, whose status is the answer; a body over 64 KB and a client
 * past its allowance are refused before it. The handler is stubbed; its behaviour is tests/circle-notify.test.ts's.
 */

const { handleCircleNotification } = vi.hoisted(() => ({ handleCircleNotification: vi.fn() }));
vi.mock("@/lib/circle/notify", () => ({ handleCircleNotification }));

const { POST, maxDuration } = await import("@/app/api/circle/notifications/route");

let ipCounter = 0;
function post(body: string, headers: Record<string, string> = {}, ip = `10.3.0.${++ipCounter}`): Promise<Response> {
  return POST(
    new Request("https://vestiarion.invalid/api/circle/notifications", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "x-circle-signature": "c2ln", "x-circle-key-id": "key-1", ...headers },
      body,
    })
  );
}

beforeEach(() => {
  handleCircleNotification.mockReset();
  handleCircleNotification.mockResolvedValue({ status: 200 });
});

describe("POST /api/circle/notifications", () => {
  it("allows the event cycle it starts its full 300 seconds, since that cycle runs after the answer, in this invocation (final review C1)", async () => {
    // runCycleSoon's after() is bounded by the route's maxDuration: 2 s of debounce, up to 90 s waiting for a running
    // cycle, then the cycle. Cut short, the cycle leaves its run row running and blocks the workspace's cycles.
    expect(maxDuration).toBe(300);
    // The GitHub App's webhook defers the same event cycles (a merged pull request), so it allows the same.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/github/webhook/route.ts", "utf8")).toContain("export const maxDuration = 300;");
  });

  it("hands the raw body and Circle's two headers to the handler, and answers its status", async () => {
    const raw = '{"notificationType":"transactions.outbound","notification":{"id":"tx-1"}}';
    handleCircleNotification.mockResolvedValueOnce({ status: 200, started: { slug: "acme", kind: "payment_settled" } });
    const response = await post(raw);
    expect(response.status).toBe(200);
    expect(handleCircleNotification).toHaveBeenCalledWith(raw, { signature: "c2ln", keyId: "key-1" });
  });

  it.each([401, 400, 503] as const)("answers %i when the handler does", async (status) => {
    handleCircleNotification.mockResolvedValueOnce({ status });
    expect((await post("{}")).status).toBe(status);
  });

  it("passes missing headers as null, for the handler to refuse", async () => {
    const response = await POST(new Request("https://vestiarion.invalid/api/circle/notifications", { method: "POST", headers: { "x-forwarded-for": "10.3.9.1" }, body: "{}" }));
    expect(response.status).toBe(200);
    expect(handleCircleNotification).toHaveBeenCalledWith("{}", { signature: null, keyId: null });
  });

  it("refuses a body over 64 KB without reading it into the handler", async () => {
    const response = await post(`{"pad":"${"x".repeat(64 * 1024)}"}`);
    expect(response.status).toBe(413);
    expect(handleCircleNotification).not.toHaveBeenCalled();
  });

  it("refuses a client past 300 notifications a minute", async () => {
    for (let index = 0; index < 300; index++) expect((await post("{}", {}, "10.3.8.8")).status).toBe(200);
    const response = await post("{}", {}, "10.3.8.8");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(handleCircleNotification).toHaveBeenCalledTimes(300);
  });
});
