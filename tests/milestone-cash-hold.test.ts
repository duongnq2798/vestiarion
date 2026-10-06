import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseCashShort } from "@/lib/agent/liquidity";

/**
 * A milestone release from the operating wallet needs its cash there (mainnet pre-flight, 2026-10-06). The contractor
 * stage sent a release whatever the wallet held, so one it could not cover went to Circle only to fail, and on Arc
 * mainnet the wallet pays its own gas. Now the stage weighs each release against what the wallet holds, less the
 * releases planned before it in the same cycle. One it cannot cover is held for want of cash, and the follow-up stage
 * reopens it once cash comes in (reserve cash back R4). A release from escrow is paid from the escrow.
 */

describe("releaseCashShort", () => {
  it("is nothing while the wallet covers the release, to the last micro-USDC", () => {
    expect(releaseCashShort({ amount: 5, operatingBalance: 5, plannedUsdc: 0 })).toBeNull();
    expect(releaseCashShort({ amount: 2, operatingBalance: 10, plannedUsdc: 8 })).toBeNull();
  });

  it("says what the release needed and what the wallet had left for it, once it does not", () => {
    expect(releaseCashShort({ amount: 5, operatingBalance: 4.999999, plannedUsdc: 0 })).toEqual({ needed: 5, available: 4.999999 });
    expect(releaseCashShort({ amount: 5, operatingBalance: 10, plannedUsdc: 8 })).toEqual({ needed: 5, available: 2 });
  });

  it("never says the wallet had less than nothing for it", () => {
    expect(releaseCashShort({ amount: 1, operatingBalance: 3, plannedUsdc: 4 })).toEqual({ needed: 1, available: 0 });
  });
});

describe("the contractor stage and the cash in the operating wallet", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("await writeDecision({"));

  it("weighs a release against what the wallet holds less the releases planned before it, after every guardrail and before it is planned", () => {
    expect(release).toContain("const plannedUsdc = inFlightUsdc + planned.reduce((sum, entry) => sum + (entry.fromEscrow ? 0 : entry.amount), 0);");
    expect(release).toContain("releaseCashShort({ amount, operatingBalance, plannedUsdc })");
    expect(release.indexOf("releaseCashShort(")).toBeGreaterThan(release.indexOf("} else if (onChainHold) {"));
    expect(release.indexOf("releaseCashShort(")).toBeLessThan(release.indexOf("budget.spend(amount);"));
    expect(release.indexOf("releaseCashShort(")).toBeLessThan(release.indexOf("planned.push("));
  });

  it("counts a release from the wallet still in flight from an earlier cycle against what the wallet holds (review finding 3)", () => {
    // A transfer not yet mined has not left the balance; one queued behind it on an EOA would fail on chain.
    const reconciled = stage.slice(stage.indexOf("const reconciled = await reconcileMilestone("), stage.indexOf("// A contractor whose address a person changed"));
    expect(reconciled).toContain('if (reconciled.status === "verified" && !escrowedRelease(milestone)) inFlightUsdc += amount;');
  });

  it("leaves a release from escrow to the escrow, and one Circle never answered to its own lookup, and plans each as before", () => {
    // A send Circle never answered may already have moved the money: sending it again under its key finds it (review finding 2).
    expect(release).toContain("escrowed || unanswered.has(milestone.id) ? null : releaseCashShort(");
    expect(release).toContain("fromEscrow: escrowed");
    expect(stage).toContain("const unanswered = await unansweredMilestoneSends(db, milestones);");
  });

  it("records why it held, what it needed and the cash it saw, for the follow-up stage", () => {
    const entry = stage.slice(stage.indexOf("action: `milestone_${decision.action}`"));
    expect(entry).toContain(
      "...(heldForCash ? { heldBecause: HELD_FOR_CASH, cashNeededUsdc: heldForCash.needed, cashSeen: { operating: heldForCash.available, reserve: reserveBalance, ...(gasKeptUsdc > 0 ? { gasKeptUsdc } : {}) } } : {}),"
    );
  });

  it("passes the hold to the entry it writes, so the follow-up stage can reopen it (review: test gap)", () => {
    const afterRelease = stage.slice(stage.indexOf('if (decision.action === "release") {'));
    const held = afterRelease.slice(afterRelease.indexOf("await writeDecision({"), afterRelease.indexOf("});", afterRelease.indexOf("await writeDecision({")));
    expect(held).toContain("heldForCash,");
  });
});
