import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CYCLE_STAGES } from "@/lib/agent/journal";

/** What the README says about the code, held to the code, so a change to one cannot leave the other stale. */

const README = readFileSync(path.join(process.cwd(), "README.md"), "utf8");

describe("the README", () => {
  it("lists the agent cycle's stages, in the order the cycle runs them", () => {
    const start = README.indexOf("The agent cycle:");
    const block = README.slice(start, README.indexOf("the ledger", start)).replace(/\s+/g, " ");
    const words: Record<string, string> = { follow_up: "follow-up", ap: "AP" };
    const named = CYCLE_STAGES.map((stage) => words[stage] ?? stage);
    expect(block).toContain(named.join(" -> "));
  });
});
