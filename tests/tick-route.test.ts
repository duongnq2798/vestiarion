import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/agent/tick`'s own response shape: `runLiveOrganizations` is
 * stubbed (its own behaviour is covered by `tests/cron.test.ts`), so these
 * pin only what the route does with what it returns — the status code and
 * the per-organization envelope.
 */

const { runLiveOrganizations, runScheduledCycle } = vi.hoisted(() => ({ runLiveOrganizations: vi.fn(), runScheduledCycle: vi.fn() }));
vi.mock("@/lib/agent/cron", () => ({ runLiveOrganizations, runScheduledCycle }));
const { deliverPendingWebhooks } = vi.hoisted(() => ({ deliverPendingWebhooks: vi.fn() }));
vi.mock("@/lib/webhooks/deliver", () => ({ deliverPendingWebhooks }));

const { afterTasks } = vi.hoisted(() => ({ afterTasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => void afterTasks.push(task) };
});

const { POST, maxDuration } = await import("@/app/api/agent/tick/route");
const { dispatchWebhooksSoon, resetDispatchSoonForTests } = await import("@/lib/webhooks/dispatch-soon");

const TOKEN = "tick-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;

beforeEach(() => {
  deliverPendingWebhooks.mockReset();
  deliverPendingWebhooks.mockResolvedValue({ delivered: 0, failed: 0, retried: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.restoreAllMocks();
});

// The rate limiter (src/lib/rate-limit.ts) is a module-level bucket keyed by
// client IP, capacity 2, shared across every test in this file. A distinct
// x-forwarded-for per test keeps them from exhausting one another's tokens.
let ipCounter = 0;

function post(): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  ipCounter += 1;
  const request = new Request("https://vestiarion.invalid/api/agent/tick", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": `10.0.0.${ipCounter}` },
  });
  return POST(request);
}

describe("POST /api/agent/tick", () => {
  it("runs its cycles with dispatch-soon off, since it dispatches within its own budget", async () => {
    afterTasks.length = 0;
    resetDispatchSoonForTests();
    runLiveOrganizations.mockImplementationOnce(async () => {
      dispatchWebhooksSoon(); // what every ledger append in a cycle calls
      return [];
    });
    await post();
    expect(afterTasks).toHaveLength(0);
    expect(deliverPendingWebhooks).toHaveBeenCalledOnce();
  });

  it("reports 500 with one entry per organization when any organization failed", async () => {
    runLiveOrganizations.mockResolvedValueOnce([
      { slug: "a-corp", ok: true, result: { lines: [{}, {}] } },
      { slug: "b-corp", ok: false, error: "boom" },
    ]);

    const response = await post();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      organizations: [
        { slug: "a-corp", ok: true, lines: 2 },
        { slug: "b-corp", ok: false, error: "boom" },
      ],
    });
  });

  it("reports 200 when every organization succeeded", async () => {
    runLiveOrganizations.mockResolvedValueOnce([
      { slug: "a-corp", ok: true, result: { lines: [{}] } },
    ]);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizations: [{ slug: "a-corp", ok: true, lines: 1 }] });
  });

  it("shapes a skipped, paused organization as ok, and still reports 200", async () => {
    runLiveOrganizations.mockResolvedValueOnce([
      { slug: "a-corp", ok: true, result: { lines: [{}] } },
      { slug: "b-corp", ok: true, skipped: "paused" },
    ]);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizations: [
        { slug: "a-corp", ok: true, lines: 1 },
        { slug: "b-corp", ok: true, skipped: "paused" },
      ],
    });
  });

  it("delivers pending webhooks after the cycles, with a 30-second deadline when the tick has time to spare", async () => {
    const order: string[] = [];
    runLiveOrganizations.mockImplementationOnce(async () => {
      order.push("cycles");
      return [{ slug: "a-corp", ok: true, result: { lines: [{}] } }];
    });
    deliverPendingWebhooks.mockImplementationOnce(async () => {
      order.push("webhooks");
      return { delivered: 1, failed: 0, retried: 0 };
    });

    const response = await post();

    expect(order).toEqual(["cycles", "webhooks"]);
    expect(deliverPendingWebhooks).toHaveBeenCalledWith({ deadlineMs: 30_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizations: [{ slug: "a-corp", ok: true, lines: 1 }] });
  });

  describe("the dispatch's budget, against the time the tick has already used", () => {
    const START = Date.parse("2026-09-29T10:00:00.000Z");

    /** Runs a tick whose cycles take `cyclesMs`, on a fake clock. */
    async function tickTaking(cyclesMs: number): Promise<Response> {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      runLiveOrganizations.mockImplementationOnce(async () => {
        vi.setSystemTime(START + cyclesMs);
        return [{ slug: "a-corp", ok: true, result: { lines: [{}] } }];
      });
      return post();
    }

    it("is capped at 30 seconds", async () => {
      await tickTaking(10_000);
      expect(deliverPendingWebhooks).toHaveBeenCalledWith({ deadlineMs: 30_000 });
    });

    it("is what is left of maxDuration after a 15-second margin, when that is less than 30 seconds", async () => {
      expect(maxDuration).toBe(300);
      await tickTaking(260_000);
      expect(deliverPendingWebhooks).toHaveBeenCalledWith({ deadlineMs: 25_000 });
    });

    it.each([285_000, 299_000, 320_000])("skips the dispatch when %i ms are already used, keeping the tick's result", async (used) => {
      const response = await tickTaking(used);

      expect(deliverPendingWebhooks).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ organizations: [{ slug: "a-corp", ok: true, lines: 1 }] });
    });
  });

  it.each([
    ["200", [{ slug: "a-corp", ok: true, result: { lines: [{}] } }], 200, [{ slug: "a-corp", ok: true, lines: 1 }]],
    ["500", [{ slug: "b-corp", ok: false, error: "boom" }], 500, [{ slug: "b-corp", ok: false, error: "boom" }]],
  ])("keeps a %s tick's status and body when the webhook dispatch fails", async (_label, results, status, organizations) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runLiveOrganizations.mockResolvedValueOnce(results);
    deliverPendingWebhooks.mockRejectedValueOnce(new Error("dispatch broke"));

    const response = await post();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ organizations });
  });

  it("runs the scheduled cycle, which notifies after each cycle, in every live organization", async () => {
    runLiveOrganizations.mockResolvedValueOnce([]);

    await post();

    expect(runLiveOrganizations).toHaveBeenLastCalledWith(runScheduledCycle);
  });
});
