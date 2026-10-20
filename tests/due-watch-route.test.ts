import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/agent/due-watch` (due-work watch DW1): the agent's bearer token, its own rate limit, and the watch's
 * per-workspace results, a workspace's error kept in the server log. `watchDueWork` is stubbed; its behaviour is
 * tests/due-watch.test.ts's.
 */

const { watchDueWork } = vi.hoisted(() => ({ watchDueWork: vi.fn() }));
vi.mock("@/lib/agent/due-watch", () => ({ watchDueWork }));

const { POST, maxDuration } = await import("@/app/api/agent/due-watch/route");

const TOKEN = "due-watch-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;
let ipCounter = 0;

function post(authorization = `Bearer ${TOKEN}`, ip?: string): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  ipCounter += 1;
  return POST(
    new Request("https://vestiarion.invalid/api/agent/due-watch", {
      method: "POST",
      headers: { authorization, "x-forwarded-for": ip ?? `10.2.0.${ipCounter}` },
    })
  );
}

beforeEach(() => {
  watchDueWork.mockReset();
  watchDueWork.mockResolvedValue([
    { slug: "founding", ok: true, result: { due: "none" } },
    { slug: "pinecrest-studio", ok: true, result: { due: "payee_lock_wait_ended", counterparties: 1 } },
    { slug: "testnet-2", ok: true, skipped: "running" },
  ]);
});
afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
});

describe("POST /api/agent/due-watch", () => {
  it("runs the watch for the agent's token and answers each workspace's result", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizations: [
        { slug: "founding", ok: true, due: "none" },
        { slug: "pinecrest-studio", ok: true, due: "payee_lock_wait_ended", counterparties: 1 },
        { slug: "testnet-2", ok: true, skipped: "running" },
      ],
    });
    expect(maxDuration).toBe(300);
  });

  it("answers 500 when a workspace failed, without the error's detail", async () => {
    watchDueWork.mockResolvedValue([
      { slug: "founding", ok: false, error: "approval_policies not read: secret detail" },
      { slug: "pinecrest-studio", ok: true, result: { due: "missed_schedule" } },
    ]);
    const response = await post();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ organizations: [{ slug: "founding", ok: false }, { slug: "pinecrest-studio", ok: true, due: "missed_schedule" }] });
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });

  it("refuses anyone without the agent's token, running nothing", async () => {
    const response = await post("Bearer wrong-token");
    expect(response.status).toBe(401);
    expect(watchDueWork).not.toHaveBeenCalled();
  });

  it("allows two runs a minute from one address", async () => {
    expect((await post(undefined, "10.9.8.7")).status).toBe(200);
    expect((await post(undefined, "10.9.8.7")).status).toBe(200);
    const third = await post(undefined, "10.9.8.7");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("says the watch failed, without the error's detail, when it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchDueWork.mockRejectedValue(new Error("orgs read failed: secret detail"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The due-work watch failed." });
  });
});

describe(".github/workflows/due-watch.yml", () => {
  it("runs the watch by hand with the agent's token, one run at a time, and schedules nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const workflow = readFileSync(".github/workflows/due-watch.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain("group: due-watch");
    expect(workflow).toContain('"${VESTIARION_URL%/}/api/agent/due-watch"');
    expect(workflow).toContain('--header "Authorization: Bearer $AGENT_API_TOKEN"');
  });
});
