import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CYCLE_STAGES } from "@/lib/agent/journal";
import { MAINNET_STARTING_PAYEE_LOCK } from "@/lib/mainnet";
import { COOLING_HOURS_CHOICES } from "@/lib/payee-lock-rules";

/** What the README says about the code, held to the code, so a change to one cannot leave the other stale. */

const README = readFileSync(path.join(process.cwd(), "README.md"), "utf8");

describe("the README", () => {
  it("lists the agent cycle's stages, in the order the cycle runs them", () => {
    const start = README.indexOf("The agent cycle:");
    const block = README.slice(start, README.indexOf("the ledger", start)).replace(/\s+/g, " ");
    const words: Record<string, string> = { follow_up: "follow-up", ap: "AP", early_offers: "early offers", customer_offers: "customer offers", term_requests: "term requests", document_requests: "document requests", cash_alert: "cash alert", document_checks: "document checks" };
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

  it("describes the payee lock as the code starts and runs it, on each network", () => {
    const row = README.split("\n").find((line) => line.startsWith("| **Payee lock** |")) ?? "";
    // Off on Arc testnet until an owner turns it on; on, with no wait, for a new Arc mainnet workspace (payee lock
    // mainnet default LD1).
    expect(MAINNET_STARTING_PAYEE_LOCK).toEqual({ on: true, coolingHours: 0 });
    expect(row).toContain("Off on Arc testnet until an owner turns it on; on, with no wait, for a workspace created on Arc mainnet.");
    expect(row).not.toMatch(/opt-in/i);
    // The waits Settings offers (PL5).
    const waits = COOLING_HOURS_CHOICES.filter((hours) => hours > 0);
    expect(row).toContain(`a wait of ${waits.slice(0, -1).join(", ")} or ${waits[waits.length - 1]} hours from the change`);
    // Whoever entered the address confirms it only when no one else can, and the record says so (PL3).
    expect(row).toContain("Whoever entered the address cannot confirm it while another member can; where no one else can, they confirm it alone, and the record says so.");
    // Approving confirms an address with the lock off, never with it on (PL4).
    expect(row).toContain("With the lock on, approving a payment no longer confirms its address.");
    expect(row).not.toContain("never confirms its address");
  });
});
