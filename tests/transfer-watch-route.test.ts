import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/agent/transfer-watch` (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md D3): the agent's
 * bearer token, its own rate limit, and the watch's per-workspace results; and the workflow that calls it every 5
 * minutes, one run at a time. `watchStuckTransfers` is stubbed; its behaviour is tests/transfer-watch.test.ts's.
 */

const { watchStuckTransfers } = vi.hoisted(() => ({ watchStuckTransfers: vi.fn() }));
vi.mock("@/lib/agent/transfer-watch", () => ({ watchStuckTransfers }));

const { POST, maxDuration } = await import("@/app/api/agent/transfer-watch/route");

const TOKEN = "transfer-watch-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;
let ipCounter = 0;

function post(authorization = `Bearer ${TOKEN}`, ip?: string): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  ipCounter += 1;
  return POST(
    new Request("https://vestiarion.invalid/api/agent/transfer-watch", {
      method: "POST",
      headers: { authorization, "x-forwarded-for": ip ?? `10.2.0.${ipCounter}` },
    })
  );
}

beforeEach(() => {
  watchStuckTransfers.mockReset();
  watchStuckTransfers.mockResolvedValue([{ slug: "acme", inFlight: 1, told: 1 }]);
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
});

describe("POST /api/agent/transfer-watch", () => {
  it("runs the watch for the agent's token and answers each workspace's result", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, organizations: [{ slug: "acme", inFlight: 1, told: 1 }] });
    expect(maxDuration).toBe(300);
  });

  it("refuses anyone without the agent's token, running nothing", async () => {
    const response = await post("Bearer wrong-token");
    expect(response.status).toBe(401);
    expect(watchStuckTransfers).not.toHaveBeenCalled();
  });

  it("allows two runs a minute from one address", async () => {
    expect((await post(undefined, "10.8.8.8")).status).toBe(200);
    expect((await post(undefined, "10.8.8.8")).status).toBe(200);
    const third = await post(undefined, "10.8.8.8");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("answers 500 when the watch failed in a workspace, naming none (final review M4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchStuckTransfers.mockResolvedValueOnce([
      { slug: "acme", inFlight: 0, told: 0, error: "column payment_intents.submitted_at does not exist" },
      { slug: "beta", inFlight: 1, told: 1 },
    ]);
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "The transfer watch failed in 1 workspace." });
  });

  it("says the watch failed, without the error's detail, when it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchStuckTransfers.mockRejectedValueOnce(new Error("relation payment_intents has no column submitted_at"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "The transfer watch failed." });
  });
});

describe("the transfer watch's workflow", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/transfer-watch.yml"), "utf8");

  it("calls the protected route every 5 minutes with the agent's token, one run at a time", () => {
    expect(workflow).toContain('- cron: "*/5 * * * *"');
    expect(workflow).toContain("group: transfer-watch");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('--header "Authorization: Bearer $AGENT_API_TOKEN"');
    // The repository is public: the log shows the status only, never which workspace has a payment stuck.
    expect(workflow).toContain("--output /dev/null");
    expect(workflow).toContain('--write-out "%{http_code}');
    expect(workflow).not.toContain("--fail-with-body");
    expect(workflow).toContain('"${VESTIARION_URL%/}/api/agent/transfer-watch"');
  });
});
