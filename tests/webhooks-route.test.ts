import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/platform/webhooks`, run every 10 minutes by Supabase Cron
 * (`supabase/cron/watches.sql`, tests/supabase-cron.test.ts) and by hand from
 * `.github/workflows/webhooks.yml` (webhooks design W3). The dispatcher is
 * stubbed (its behaviour is covered by `tests/webhook-deliver.test.ts`), so
 * these pin only the bearer check and the counts-only response.
 */

const { deliverPendingWebhooks } = vi.hoisted(() => ({ deliverPendingWebhooks: vi.fn() }));
vi.mock("@/lib/webhooks/deliver", () => ({ deliverPendingWebhooks }));

const route = await import("@/app/api/platform/webhooks/route");
const { POST } = route;

const TOKEN = "webhooks-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.restoreAllMocks();
  deliverPendingWebhooks.mockReset();
});

function post(authorization?: string): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return POST(new Request("https://vestiarion.invalid/api/platform/webhooks", { method: "POST", headers }));
}

describe("POST /api/platform/webhooks", () => {
  it("allows the scheduled run up to 300 seconds", () => {
    expect(route.maxDuration).toBe(300);
  });

  it("returns 401 without a bearer, and never dispatches", async () => {
    const response = await post();

    expect(response.status).toBe(401);
    expect(deliverPendingWebhooks).not.toHaveBeenCalled();
  });

  it("returns 401 for the wrong bearer", async () => {
    const response = await post("Bearer not-the-token");

    expect(response.status).toBe(401);
    expect(deliverPendingWebhooks).not.toHaveBeenCalled();
  });

  it("dispatches with the default limit and deadline, and returns 200 with counts only", async () => {
    deliverPendingWebhooks.mockResolvedValueOnce({ delivered: 3, failed: 1, retried: 2 });

    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 3, failed: 1, retried: 2 });
    expect(deliverPendingWebhooks).toHaveBeenCalledWith();
  });

  it("returns a JSON 500 if the dispatcher ever throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliverPendingWebhooks.mockRejectedValueOnce(new Error("unexpected"));

    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "webhook dispatch failed" });
  });
});
