import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderResults, type QualityLabResult } from "@/lib/quality-lab/judge";
import { QUALITY_LAB_SCENARIOS } from "@/lib/quality-lab/scenarios";
import { outcomeWords } from "@/lib/quality-lab/words";
import { apHarness } from "./support/ap-harness";
import { expectedOf, qualityLabRunner } from "./support/quality-lab-runner";

/**
 * The Quality Lab (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL1-QL6): every scenario in
 * src/lib/quality-lab/scenarios.ts, run through the real AP stage over the shared harness, with only the model's answer
 * scripted (tests/support/quality-lab-runner.ts). Transfers are counted from the provider, never inferred from a status
 * (QL4).
 *
 * - Any wrong payment fails its scenario's test, naming it.
 * - A scenario that is not right does not fail: a safe miss is recorded as not right in the committed file.
 * - The committed results (src/lib/data/quality-lab.json) must equal this run; with QUALITY_LAB_WRITE=1 the run writes
 *   them instead (`npm run quality-lab`).
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const { world } = apHarness();
const runScenario = qualityLabRunner(world, decideMock);

// A hook that returned the mock would be called as its teardown.
beforeEach(() => {
  decideMock.mockReset();
});
afterEach(() => vi.useRealTimers());

const RESULTS_FILE = path.join(process.cwd(), "src", "lib", "data", "quality-lab.json");
const STALE = "run npm run quality-lab and commit src/lib/data/quality-lab.json";

const results = new Map<string, QualityLabResult>();
/** How often each scenario asked the provider to send, and the model to decide. */
const reached = new Map<string, { asked: number; decided: number }>();

describe("the Quality Lab: every scenario through the real decision code (QL1, QL4)", () => {
  for (const scenario of QUALITY_LAB_SCENARIOS) {
    it(`${scenario.id}: makes no wrong payment`, { timeout: 20_000 }, async () => {
      const { verdict, reached: counts } = await runScenario(scenario);
      results.set(scenario.id, { id: scenario.id, group: scenario.group, title: scenario.title, expected: expectedOf(scenario), ...verdict });
      reached.set(scenario.id, counts);
      expect(verdict.wrongPayment, `wrong payment in ${scenario.id}: ${outcomeWords(verdict.actual)}`).toBe(false);
    });
  }
});

/** The harness itself, held to what the sending-once scenarios say they test, so a change to it cannot empty them (QL2). */
describe("the Quality Lab's sending-once scenarios reach what they test", () => {
  it("finds a send whose answer was lost after the provider took it, deciding and sending nothing more", () => {
    expect(reached.get("once-answer-lost-after-sending")).toEqual({ asked: 1, decided: 1 });
  });

  it("decides again, and sends once, a send the provider never took", () => {
    expect(reached.get("once-answer-lost-never-sent")).toEqual({ asked: 2, decided: 2 });
  });

  it("has both cycles decide the bill when two reach it at once", () => {
    expect(reached.get("once-two-cycles-at-once")).toEqual({ asked: 1, decided: 2 });
  });
});

describe("the Quality Lab's committed results (QL5, QL6)", () => {
  it("are this run's, scenario for scenario", () => {
    expect([...results.keys()], "every scenario ran").toEqual(QUALITY_LAB_SCENARIOS.map((scenario) => scenario.id));
    const rendered = renderResults(QUALITY_LAB_SCENARIOS.map((scenario) => results.get(scenario.id)!));
    if (process.env.QUALITY_LAB_WRITE === "1") {
      writeFileSync(RESULTS_FILE, rendered);
      return;
    }
    expect(readFileSync(RESULTS_FILE, "utf8").replace(/\r\n/g, "\n"), STALE).toBe(rendered);
  });
});
