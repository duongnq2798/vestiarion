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
    const words: Record<string, string> = { follow_up: "follow-up", ap: "AP", early_offers: "early offers", customer_offers: "customer offers", term_requests: "term requests", document_requests: "document requests", cash_alert: "cash alert" };
    const named = CYCLE_STAGES.map((stage) => words[stage] ?? stage);
    expect(block).toContain(named.join(" -> "));
  });

  it("names the SDK's own version in its npm badge, which shields.io cannot look up for this package", () => {
    const { version } = JSON.parse(readFileSync(path.join(process.cwd(), "sdk", "package.json"), "utf8")) as { version: string };
    const line = README.split("\n").find((row) => row.startsWith("[![npm](")) ?? "";
    const badge = line.slice("[![npm](".length, line.indexOf(")]("));
    expect(line).toContain("](https://www.npmjs.com/package/@vestiarion/sdk)");
    expect(badge).toBe(`https://img.shields.io/badge/%40vestiarion%2Fsdk-v${version}-cb3837?style=flat-square&logo=npm&logoColor=white`);
  });
});
