import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/agent/tick`'s own response shape: `runLiveOrganizations` is
 * stubbed (its own behaviour is covered by `tests/cron.test.ts`), so these
 * pin only what the route does with what it returns — the status code and
 * the per-organization envelope.
 */

const { runLiveOrganizations } = vi.hoisted(() => ({ runLiveOrganizations: vi.fn() }));
vi.mock("@/lib/agent/cron", () => ({ runLiveOrganizations }));

const { POST } = await import("@/app/api/agent/tick/route");

const TOKEN = "tick-route-test-token";
const previousToken = process.env.AGENT_API_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.restoreAllMocks();
});

function post(): Promise<Response> {
  process.env.AGENT_API_TOKEN = TOKEN;
  const request = new Request("https://vestiarion.invalid/api/agent/tick", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return POST(request);
}

describe("POST /api/agent/tick", () => {
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
});
