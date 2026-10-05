import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { FxQuoteError } from "@/lib/fx/errors";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * The watcher that decides EURC payables again without a person (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md
 * F4, F5, F7, F9): in each live, unpaused workspace it asks a fresh quote for the payables held for FX that are due a
 * re-check, and runs a cycle, with the event `fx_changed`, only when one cleared. It writes nothing itself. What the
 * cycle then does is the follow-up's and the AP stage's to test.
 */

const { runAgentCycleMock } = vi.hoisted(() => ({ runAgentCycleMock: vi.fn() }));
vi.mock("@/lib/agent/orchestrator", () => ({ runAgentCycle: runAgentCycleMock }));

const { watchFxHolds, FX_RECHECKS_PER_WATCH } = await import("@/lib/agent/fx-watch");

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a000";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const NOW = Date.parse("2026-10-05T02:00:00.000Z");

/** Loto's 0.5 EURC, held because Circle quoted no rate (#1434). */
function decision(invoiceId: string, seq: number) {
  return {
    seq,
    ts: "2026-10-05T01:38:29.000Z",
    action: "ap_hold",
    detail: {
      invoiceId,
      decision: { action: "hold" },
      guardrailRule: null,
      observed: { amount: 0.5, paymentLimit: 1 },
      usdcValue: null,
      fx: null,
      eurcBalance: 0,
      swapOffer: null,
      swapUnavailable: null,
      execution: { resultingStatus: "held" },
    },
  };
}
const heldRow = (id: string, decidedAt = "2026-10-05T01:38:29.000Z") => ({ id, status: "held", decided_at: decidedAt, counterparties: { payment_limit: "1" } });

function workspace(options: { paused?: boolean; held?: Array<ReturnType<typeof heldRow>>; entries?: Array<Record<string, unknown>> }) {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs" && request.params.get("mode") === "eq.live") {
      return { body: [{ id: A, slug: "demo-wp", agent_paused_at: options.paused ? "2026-10-05T01:00:00Z" : null }] };
    }
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: A, slug: "demo-wp", name: "Demo", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    if (request.path === "/rest/v1/invoices") return { body: options.held ?? [] };
    if (request.path === "/rest/v1/ledger_entries") return { body: options.entries ?? [] };
    return { body: [] };
  });
}

const quoted = { usdcEstimated: 0.607631, usdcMinimum: 0.589402, rate: 1.215262, source: "circle-stablecoin-quote" as const, quotedAt: "2026-10-05T02:00:00.000Z" };

function watch(fake: ReturnType<typeof fakeSupabase>, quoteRate: (amount: number) => Promise<typeof quoted>) {
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => watchFxHolds({ quotes: async () => ({ quoteRate }), now: () => NOW }));
}

beforeEach(() => {
  runAgentCycleMock.mockReset();
  runAgentCycleMock.mockResolvedValue({ ok: true });
});
afterEach(() => vi.restoreAllMocks());

describe("watchFxHolds", () => {
  it("runs no cycle and asks no quote where no EURC payable is held", async () => {
    const quoteRate = vi.fn();
    expect(await watch(workspace({}), quoteRate)).toEqual([{ slug: "demo-wp", held: 0, probed: 0, cleared: 0, cycle: "none" }]);
    expect(quoteRate).not.toHaveBeenCalled();
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("asks the quote, and runs no cycle while Circle still quotes no rate", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const quoteRate = vi.fn().mockRejectedValue(new FxQuoteError("no_route"));
    const fake = workspace({ held: [heldRow("inv-1")], entries: [decision("inv-1", 1434)] });
    expect(await watch(fake, quoteRate)).toEqual([{ slug: "demo-wp", held: 1, probed: 1, cleared: 0, cycle: "none" }]);
    expect(quoteRate).toHaveBeenCalledWith(0.5);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("runs one cycle in the workspace, with the event fx_changed, once a quote clears a hold", async () => {
    let scope: string | null = null;
    runAgentCycleMock.mockImplementation(async () => {
      scope = currentOrgId();
      return { ok: true };
    });
    const fake = workspace({ held: [heldRow("inv-1"), heldRow("inv-2")], entries: [decision("inv-1", 1434), decision("inv-2", 1435)] });
    expect(await watch(fake, vi.fn().mockResolvedValue(quoted))).toEqual([{ slug: "demo-wp", held: 2, probed: 2, cleared: 2, cycle: "ran" }]);
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock).toHaveBeenCalledWith({ trigger: { kind: "event", events: ["fx_changed"] } });
    expect(scope).toBe(A);
    // It reads only the held EURC payables, and writes nothing.
    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("status")).toBe("eq.held");
    expect(invoices?.params.get("currency")).toBe("eq.EURC");
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    expect(fake.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("leaves a payable reopened for FX within 30 minutes, asking nothing", async () => {
    const quoteRate = vi.fn().mockResolvedValue(quoted);
    const reopened = { seq: 1440, ts: "2026-10-05T01:45:00.000Z", action: "invoice_reopened", detail: { invoiceId: "inv-1", reevaluation: { trigger: "rate_available" } } };
    const fake = workspace({ held: [heldRow("inv-1")], entries: [{ ...decision("inv-1", 1441), ts: "2026-10-05T01:45:10.000Z" }, reopened] });
    expect(await watch(fake, quoteRate)).toEqual([{ slug: "demo-wp", held: 1, probed: 0, cleared: 0, cycle: "none" }]);
    expect(quoteRate).not.toHaveBeenCalled();
  });

  it("skips a paused workspace without entering it", async () => {
    const fake = workspace({ paused: true, held: [heldRow("inv-1")], entries: [decision("inv-1", 1434)] });
    expect(await watch(fake, vi.fn())).toEqual([{ slug: "demo-wp", held: 0, probed: 0, cleared: 0, cycle: "paused" }]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/invoices")).toBe(false);
  });

  it("reports a cycle already running instead of starting a second one", async () => {
    runAgentCycleMock.mockRejectedValue(new CycleRunningError());
    const fake = workspace({ held: [heldRow("inv-1")], entries: [decision("inv-1", 1434)] });
    expect(await watch(fake, vi.fn().mockResolvedValue(quoted))).toEqual([{ slug: "demo-wp", held: 1, probed: 1, cleared: 1, cycle: "running" }]);
  });

  it("asks about at most three payables per workspace, the oldest held first", async () => {
    const quoteRate = vi.fn().mockRejectedValue(new FxQuoteError("no_route"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const ids = ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5"];
    const fake = workspace({ held: ids.map((id, index) => heldRow(id, `2026-10-05T01:0${index}:00.000Z`)), entries: ids.map((id, index) => decision(id, 1400 + index)) });
    const [result] = await watch(fake, quoteRate);
    expect(FX_RECHECKS_PER_WATCH).toBe(3);
    expect(result).toMatchObject({ held: 5, probed: 3 });
    expect(quoteRate).toHaveBeenCalledTimes(3);
  });
});
