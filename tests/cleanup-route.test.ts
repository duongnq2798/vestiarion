import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/platform/cleanup`'s own response shape, the same shape as
 * `tests/tick-route.test.ts`: `deleteAbandonedSandboxes` is stubbed (its own
 * behaviour is covered by `tests/cleanup.test.ts`), so these pin only the
 * bearer check and what the route does with what it returns.
 */

const { deleteAbandonedSandboxes } = vi.hoisted(() => ({ deleteAbandonedSandboxes: vi.fn() }));
vi.mock("@/lib/platform/cleanup", () => ({ deleteAbandonedSandboxes }));

const { POST } = await import("@/app/api/platform/cleanup/route");

const TOKEN = "cleanup-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.restoreAllMocks();
});

function post(authorization?: string): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  const request = new Request("https://vestiarion.invalid/api/platform/cleanup", { method: "POST", headers });
  return POST(request);
}

describe("POST /api/platform/cleanup", () => {
  it("returns 401 without a valid bearer, and never calls deleteAbandonedSandboxes", async () => {
    const response = await post();

    expect(response.status).toBe(401);
    expect(deleteAbandonedSandboxes).not.toHaveBeenCalled();
  });

  it("returns 401 for the wrong bearer", async () => {
    const response = await post("Bearer not-the-token");

    expect(response.status).toBe(401);
    expect(deleteAbandonedSandboxes).not.toHaveBeenCalled();
  });

  it("returns 200 with the counts when nothing failed", async () => {
    deleteAbandonedSandboxes.mockResolvedValueOnce({ deleted: 2, failed: 0 });

    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, failed: 0 });
  });

  it("returns 500 with the counts when any deletion failed", async () => {
    deleteAbandonedSandboxes.mockResolvedValueOnce({ deleted: 0, failed: 1 });

    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ deleted: 0, failed: 1 });
  });

  it("logs and returns a JSON 500 when the listing itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAbandonedSandboxes.mockRejectedValueOnce(new Error("listing unavailable"));

    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "cleanup failed" });
    expect(error).toHaveBeenCalledWith("sandbox cleanup failed", "listing unavailable");
  });
});
