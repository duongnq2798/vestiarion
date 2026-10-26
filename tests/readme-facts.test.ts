import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CYCLE_STAGES } from "@/lib/agent/journal";
import { PERMISSIONS } from "@/lib/auth/roles";
import { MAINNET_STARTING_PAYEE_LOCK } from "@/lib/mainnet";
import { COOLING_HOURS_CHOICES, PAYEE_LOCK_OFF, parseVerification, payeeLockFromRow } from "@/lib/payee-lock-rules";

/** What the README says about the code, held to the code, so a change to one cannot leave the other stale. */

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const README = source("README.md");

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
    // Off on Arc testnet until an owner turns it on: only a workspace created on Arc mainnet is given a lock when it is
    // created, and a workspace with none reads as off (payee lock PL1).
    const creation = source("src/lib/platform/workspace.ts");
    const mainnetOnly = creation.indexOf('if (own === "arc-mainnet") {');
    expect(mainnetOnly).toBeGreaterThan(0);
    expect(creation.slice(0, mainnetOnly)).not.toContain("payee_lock");
    expect(creation.slice(mainnetOnly)).toContain("payee_lock: MAINNET_STARTING_PAYEE_LOCK.on");
    expect(payeeLockFromRow(undefined)).toEqual(PAYEE_LOCK_OFF);
    expect(PAYEE_LOCK_OFF.on).toBe(false);
    // A workspace created on Arc mainnet starts with it on, with no wait (payee lock mainnet default LD1). That is
    // where it starts, not a floor: changing it is an owner's alone (`approval.policy`), on any network (PL1).
    expect(MAINNET_STARTING_PAYEE_LOCK).toEqual({ on: true, coolingHours: 0 });
    expect(PERMISSIONS["approval.policy"]).toEqual(["owner"]);
    expect(source("src/app/actions/payee-lock.ts")).toContain('authorize(formData.get("orgSlug"), "approval.policy")');
    expect(source("src/lib/payee-lock.ts")).not.toMatch(/workspaceNetwork|arc-mainnet/);
    expect(row).toContain(
      "Off on Arc testnet until an owner turns it on. A workspace created on Arc mainnet starts with it on, with no wait, and there too an owner can turn it off or set a wait in Settings."
    );
    expect(row).not.toContain("on, with no wait, for a workspace created on Arc mainnet");
    expect(row).not.toMatch(/opt-in/i);
    // A call or a message names its contact, and the person confirming says it was on file before the change: they tick
    // it, and nothing compares it with the contacts the workspace holds (PL2).
    expect(parseVerification({ method: "call", contact: "+1 555 0100", contactOnFileBefore: false }, true)).toMatchObject({ ok: false, problem: "contact_not_on_file" });
    expect(parseVerification({ method: "call", contact: "+1 555 0100", contactOnFileBefore: true }, true)).toMatchObject({ ok: true });
    expect(row).toContain("(for a call or a message, the contact they used, which they say was on file before the change)");
    expect(row).not.toContain("a contact the workspace had before the change");
    // The waits Settings offers (PL5).
    const waits = COOLING_HOURS_CHOICES.filter((hours) => hours > 0);
    expect(row).toContain(`a wait of ${waits.slice(0, -1).join(", ")} or ${waits[waits.length - 1]} hours from the change`);
    // With the lock on, confirming an address refuses whoever entered it while another member can confirm it, and
    // records that they confirmed it alone where no one else can (PL3).
    const confirm = source("src/lib/counterparty-address.ts");
    const lockOn = confirm.slice(confirm.indexOf("  if (lock.on) {"), confirm.indexOf('  } else if (input.via === "confirm") {'));
    expect(lockOn.length).toBeGreaterThan(0);
    expect(lockOn).toContain('if ((await billApproversBesides([giver])) > 0) throw new CounterpartyAddressError("giver_confirms");');
    expect(lockOn).toContain("soloConfirmation = true;");
    expect(confirm).toContain("...(soloConfirmation ? { soloConfirmation: true } : {}),");
    expect(row).toContain("Whoever entered the address cannot confirm it while another member can; where no one else can, they confirm it alone, and the record says so.");
    // Approving a payment confirms its address with the lock off, and is refused that with it on (PL4).
    expect(source("src/lib/agent/approvals.ts")).toContain('via: "approval"');
    expect(lockOn).toContain('if (input.via === "approval") throw new CounterpartyAddressError("lock_requires_confirm");');
    expect(row).toContain("With the lock on, approving a payment no longer confirms its address.");
    expect(row).not.toContain("never confirms its address");
  });
});
