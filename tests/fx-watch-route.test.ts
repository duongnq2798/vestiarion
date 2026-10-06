import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/agent/fx-watch` (FX re-evaluation F4): the agent's bearer token, its own rate limit, and the watcher's
 * per-workspace results. `watchFxHolds` is stubbed; its behaviour is tests/fx-watch.test.ts's.
 */

const { watchFxHolds } = vi.hoisted(() => ({ watchFxHolds: vi.fn() }));
vi.mock("@/lib/agent/fx-watch", () => ({ watchFxHolds }));

const { POST, maxDuration } = await import("@/app/api/agent/fx-watch/route");

const TOKEN = "fx-watch-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;
let ipCounter = 0;

function post(authorization = `Bearer ${TOKEN}`, ip?: string): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  ipCounter += 1;
  return POST(
    new Request("https://vestiarion.invalid/api/agent/fx-watch", {
      method: "POST",
      headers: { authorization, "x-forwarded-for": ip ?? `10.1.0.${ipCounter}` },
    })
  );
}

beforeEach(() => {
  watchFxHolds.mockReset();
  watchFxHolds.mockResolvedValue([{ slug: "demo-wp", held: 1, probed: 1, cleared: 1, cycle: "ran" }]);
});
afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
});

describe("POST /api/agent/fx-watch", () => {
  it("runs the watcher for the agent's token and answers each workspace's result", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, organizations: [{ slug: "demo-wp", held: 1, probed: 1, cleared: 1, cycle: "ran" }] });
    expect(maxDuration).toBe(300);
  });

  it("refuses anyone without the agent's token, running nothing", async () => {
    const response = await post("Bearer wrong-token");
    expect(response.status).toBe(401);
    expect(watchFxHolds).not.toHaveBeenCalled();
  });

  it("allows two runs a minute from one address", async () => {
    expect((await post(undefined, "10.9.9.9")).status).toBe(200);
    expect((await post(undefined, "10.9.9.9")).status).toBe(200);
    const third = await post(undefined, "10.9.9.9");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("says the watch failed, without the error's detail, when it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchFxHolds.mockRejectedValue(new Error("orgs read failed: secret detail"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "The FX watch failed." });
  });
});

describe(".github/workflows/fx-watch.yml", () => {
  it("runs the watch by hand with the agent's token, one run at a time, and schedules nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const workflow = readFileSync(".github/workflows/fx-watch.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain("group: fx-watch");
    expect(workflow).toContain('"${VESTIARION_URL%/}/api/agent/fx-watch"');
    expect(workflow).toContain('--header "Authorization: Bearer $AGENT_API_TOKEN"');
  });
});
