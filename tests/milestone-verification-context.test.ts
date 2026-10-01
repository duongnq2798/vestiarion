import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { milestoneVerification } from "@/lib/agent/milestone-evidence";

/**
 * What the model is told about how a milestone was verified. A milestone a
 * person verified by hand often has no evidence link (pay a freelancer sets
 * one up that way), and given only `verificationSource: null` the model read
 * it as unverified and held it (testnet-2, ledger #641, 2026-10-01).
 */

describe("milestoneVerification", () => {
  it("says a milestone a person verified by hand is verified, by whom's method and with their note, link or not", () => {
    expect(
      milestoneVerification({
        verified: true,
        verification_method: "manual",
        verification_source: null,
        verification_detail: { note: "Delivered work confirmed when the payment was set up" },
      })
    ).toEqual({ verified: true, method: "manual", source: null, note: "Delivered work confirmed when the payment was set up" });
  });

  it("says a pull request verified it", () => {
    expect(
      milestoneVerification({
        verified: true,
        verification_method: "github",
        verification_source: "https://github.com/acme/app/pull/12",
        verification_detail: { mergedAt: "2026-10-01T10:00:00Z" },
      })
    ).toEqual({ verified: true, method: "github", source: "https://github.com/acme/app/pull/12", note: null });
  });

  it("keeps whatever is missing missing", () => {
    expect(milestoneVerification({ verified: true, verification_source: null })).toEqual({ verified: true, method: null, source: null, note: null });
  });
});

describe("the contractor stage's decision", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const prompt = stage.slice(stage.indexOf("await decide<MilestoneDecision>("), stage.indexOf("schema: milestoneDecisionSchema"));

  it("tells the model how the milestone was verified, and that a missing link does not undo it", () => {
    expect(prompt).toContain("verification: milestoneVerification(milestone)");
    expect(prompt).toContain("A missing evidence link does not make it unverified");
  });

  it("records the same in the decision's observed facts", () => {
    const observed = stage.slice(stage.indexOf("observed: {"), stage.indexOf("execution: {"));
    expect(observed).toContain("verification: milestoneVerification(milestone)");
  });
});
