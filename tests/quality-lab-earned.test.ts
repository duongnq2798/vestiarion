import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QualityLabRun } from "@/lib/quality-lab/judge";
import { QUALITY_LAB_SCENARIOS, type QualityLabScenario } from "@/lib/quality-lab/scenarios";
import { apHarness } from "./support/ap-harness";
import { qualityLabRunner } from "./support/quality-lab-runner";

/**
 * The Quality Lab's two invariants for earned vendors paid on their own
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL23, AL30), over every scenario through the real AP stage:
 *
 * 1. **Never more than live.** Each scenario of a live workspace, run again in shadow mode with the owner's switch on and
 *    its vendor earned, ends exactly as it did live: the same status, rule, reason for a hold, and transfers, to the same
 *    address, for the same amount. Both runs carry an agent spending limit, which the switch needs, where the scenario
 *    sets none.
 * 2. **Nothing changes for vendors that have not earned it.** Each scenario, run in shadow mode, ends exactly as it does
 *    with the switch on and its vendor not earned.
 *
 * A difference fails, naming the scenario.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const { world } = apHarness();
const runScenario = qualityLabRunner(world, decideMock);

beforeEach(() => {
  decideMock.mockReset();
});
afterEach(() => vi.useRealTimers());

/** A spending limit no scenario's bill reaches, for a scenario that sets none. */
const ROOMY_LIMIT = 100_000;

/** The scenario in another workspace: its own settings, then these. */
function inWorkspace(scenario: QualityLabScenario, workspace: NonNullable<QualityLabScenario["workspace"]>, payee: NonNullable<QualityLabScenario["payee"]> = {}): QualityLabScenario {
  return { ...scenario, workspace: { ...scenario.workspace, ...workspace }, payee: { ...scenario.payee, ...payee } };
}

/** What a run did, as both invariants compare it. */
async function outcome(scenario: QualityLabScenario): Promise<Omit<QualityLabRun, "scheduled">> {
  const { run } = await runScenario(scenario);
  return { status: run.status, rule: run.rule, heldBecause: run.heldBecause, transfers: run.transfers };
}

describe("never more than live (AL23)", () => {
  for (const scenario of QUALITY_LAB_SCENARIOS.filter((one) => !one.workspace?.shadowMode)) {
    it(`${scenario.id}: an earned vendor in shadow mode ends as it does live`, { timeout: 30_000 }, async () => {
      const limit = { dailySpendingLimit: scenario.workspace?.dailySpendingLimit ?? ROOMY_LIMIT };
      const live = await outcome(inWorkspace(scenario, limit));
      const earned = await outcome(inWorkspace(scenario, { ...limit, shadowMode: true, earnedVendorPayments: true }, { earned: true }));
      expect(earned, `${scenario.id} differs from live`).toEqual(live);
    });
  }
});

describe("nothing changes for vendors that have not earned it (AL23)", () => {
  for (const scenario of QUALITY_LAB_SCENARIOS) {
    it(`${scenario.id}: a vendor that has not earned it ends as it does in shadow mode`, { timeout: 30_000 }, async () => {
      const shadow = await outcome(inWorkspace(scenario, { shadowMode: true, earnedVendorPayments: false }, { earned: false }));
      const notEarned = await outcome(inWorkspace(scenario, { shadowMode: true, earnedVendorPayments: true }, { earned: false }));
      expect(notEarned, `${scenario.id} differs from shadow mode`).toEqual(shadow);
    });
  }
});
