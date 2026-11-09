import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing from Jira moves money (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR13, JR16, JR18), pinned
 * as source structure, as Asana's and Linear's are (tests/asana-paying-path.test.ts, tests/linear-paying-path.test.ts):
 * - the agent reaches Jira only through the reads of accepted work Asana's and Linear's go through, `refreshAcceptedWork`
 *   and `recheckAcceptedWork` in src/lib/milestone-verification.ts, which read the three tools at once;
 * - the payments, the held milestone decisions and the escrow never name Jira, and Jira's code imports none of them;
 * - Jira's code writes no milestone at all: its verification moves only in 0149's two functions, and its criteria through
 *   Linear's `writeCriteria`; never an amount, a payee, an address or a payment intent;
 * - Pay now's one Jira check only refuses the payee, by email, without asking Jira.
 */

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const IMPORTS_JIRA = /from "(?:\.\.?\/)+(?:lib\/)?jira\/|from "@\/lib\/jira\//;
/** The modules that pay, release, hold for paying, or hold a payee's money: Jira's code imports none of them. */
const PAYMENT_CODE =
  /from "(?:\.\.?\/)+(?:agent|circle|escrow|bank-payouts|blindpay|early-pay|treasury|payout-check)(?:\/|")|from "(?:\.\.?\/)+(?:payments|payout-route|two-approvals|pay-freelancer|payment-[\w-]+|payee-[\w-]+|new-payee[\w-]*)"|from "(?:\.\.?\/)+commands\/(?:payables|payment-plan|bookings|allocations|milestones)"/;

describe("the agent and the payments (Jira acceptance JR16, JR18)", () => {
  it("never import Jira, but for the reads of accepted work beside Asana's and Linear's", () => {
    const watched = [
      ...files(path.join(root, "src", "lib", "agent")),
      ...files(path.join(root, "src", "lib", "circle")),
      ...files(path.join(root, "src", "lib", "escrow")),
      path.join(root, "src", "lib", "payments.ts"),
      path.join(root, "src", "lib", "payout-route.ts"),
      path.join(root, "src", "lib", "two-approvals.ts"),
      ...["payables.ts", "payment-plan.ts", "bookings.ts", "allocations.ts"].map((name) => path.join(root, "src", "lib", "commands", name)),
    ];
    for (const file of watched) expect(readFileSync(file, "utf8"), path.relative(root, file)).not.toMatch(IMPORTS_JIRA);
    const verification = read("src/lib/milestone-verification.ts");
    expect(verification).toContain('import { recheckJiraBeforeSending, refreshJiraMilestones } from "./jira/workspace";');
    // The three tools read at once, so the read before sending still waits at most its one deadline.
    expect(verification).toContain("Promise.all([refreshAsanaMilestones(), refreshLinearMilestones(), refreshJiraMilestones()])");
    expect(verification).toContain("Promise.all([recheckBeforeSending(milestoneIds), recheckLinearBeforeSending(milestoneIds), recheckJiraBeforeSending(milestoneIds)])");
    expect(verification.match(/refreshJiraMilestones\(/g)).toHaveLength(1);
    expect(verification.match(/recheckJiraBeforeSending\(/g)).toHaveLength(1);
    const orchestrator = read("src/lib/agent/orchestrator.ts");
    // The orchestrator's imports do not change: it reaches Jira only through the two reads above.
    expect(orchestrator).toContain('import { recheckAcceptedWork, refreshAcceptedWork, refreshGitHubMilestones } from "../milestone-verification";');
    expect(orchestrator).not.toMatch(/import [^;]*jira/i);
    // Jira's read before the contractor stage says what it found, after Linear's line.
    expect(orchestrator.indexOf("if (acceptedWork.jira.checked > 0) {")).toBeGreaterThan(orchestrator.indexOf("if (acceptedWork.linear.checked > 0) {"));
    expect(orchestrator.indexOf("if (acceptedWork.jira.checked > 0) {")).toBeLessThan(orchestrator.indexOf('await stage("contractors"'));
    // A Jira issue not read again just before sending leaves its acceptance as given, and the cycle says so.
    const stage = orchestrator.slice(orchestrator.indexOf('await stage("contractors"'), orchestrator.indexOf('await stage("treasury"'));
    expect(stage).toMatch(/if \(!recheck\.jira\.complete\) \{\s*lines\.push\(\{ domain: "contractor", message: "Jira: not every accepted issue could be read again just before sending; those acceptances stand as given" \}\);/);
    expect(stage.indexOf("if (!recheck.jira.complete)")).toBeGreaterThan(stage.indexOf("if (!recheck.linear.complete)"));
    expect(stage.indexOf("if (!recheck.jira.complete)")).toBeLessThan(stage.indexOf("await stillVerified(db, planned.map((entry) => entry.milestone.id))"));
  });
});

describe("Jira's own code (JR18)", () => {
  const jira = files(path.join(root, "src", "lib", "jira")).map((file) => ({ file: path.relative(root, file), source: readFileSync(file, "utf8") }));
  const commands = { file: path.join("src", "lib", "commands", "jira.ts"), source: read("src/lib/commands/jira.ts") };
  const actions = { file: path.join("src", "app", "actions", "jira.ts"), source: read("src/app/actions/jira.ts") };

  it("imports no payment, release or escrow code; its commands reach the agent only to start a cycle soon", () => {
    expect(jira.length).toBeGreaterThan(10);
    for (const { file, source } of jira) expect(source, file).not.toMatch(PAYMENT_CODE);
    for (const { file, source } of [commands, actions]) {
      expect(source.replace('import { runCycleSoon } from "../agent/cycle-soon";', ""), file).not.toMatch(PAYMENT_CODE);
    }
  });

  it("writes no payment intent, amount, payee or address", () => {
    for (const { file, source } of [...jira, commands, actions]) {
      expect(source, file).not.toMatch(/from\("payment_intents"\)/);
      for (const write of source.matchAll(/\.(?:update|insert|upsert)\(\{([\s\S]*?)\}\)/g)) {
        expect(write[1], file).not.toMatch(/\b(?:amount|contractor_id|address|payout|escrow_\w+)\s*:/);
      }
    }
  });

  it("writes no milestone row itself: its criteria go through Linear's writeCriteria, its verification only through 0149's two functions", () => {
    const writes = [...jira, commands, actions].flatMap(({ file, source }) =>
      [...source.matchAll(/\.from\("milestones"\)\s*\.(update|insert|upsert|delete)\(/g)].map(() => file)
    );
    expect(writes).toEqual([]);
    expect(read("src/lib/jira/links.ts")).toContain('export { milestonesForAcceptance, writeCriteria, type MilestoneForAcceptance } from "../linear/links";');
    expect(read("src/lib/jira/links.ts")).toMatch(/\.rpc\("accept_jira_issue", \{/);
    expect(read("src/lib/jira/links.ts")).toMatch(/\.rpc\("hold_jira_acceptance", \{/);
    const sql = read("supabase/migrations/0149_jira_acceptance.sql");
    const updates = [...sql.matchAll(/update public\.milestones\s+set([\s\S]*?)\s+where/g)].map((match) => match[1]);
    expect(updates).toHaveLength(2);
    for (const set of updates) {
      expect(set).not.toMatch(/\b(amount|contractor_id|escrow_|tx_ref|address)\b/);
      expect(set).toMatch(/verified =/);
    }
  });

  it("calls Jira from Pay now only to refuse its payee, by email, without asking Jira", () => {
    const milestones = read("src/lib/commands/milestones.ts");
    expect(milestones).toContain('import { approvesOwnJiraPayout } from "../jira/identities";');
    expect(milestones).toMatch(/if \(await approvesOwnJiraPayout\(actor, input\.milestoneId\)\) return refused\("self_payout"/);
    expect(milestones.match(/approvesOwnJiraPayout/g)).toHaveLength(2);
    // After Linear's check, as the spec orders them.
    expect(milestones.indexOf("await approvesOwnJiraPayout(")).toBeGreaterThan(milestones.indexOf("await approvesOwnLinearPayout("));
    expect(read("src/lib/jira/identities.ts")).toMatch(/identitiesOf\(member, milestone, null\)/);
  });

  it("reads a webhook's body once, for which issue to read again, and the route believes nothing else (JR15)", () => {
    const webhook = read("src/lib/jira/webhook.ts");
    // The body once; the only other parse is of the token's own header and claims, before the body is read.
    expect(webhook.match(/JSON\.parse\(raw\)/g)).toHaveLength(1);
    expect(webhook.match(/JSON\.parse\(/g)).toHaveLength(2);
    expect(webhook).toContain('JSON.parse(Buffer.from(part, "base64url").toString("utf8"))');
    expect(webhook).toMatch(/deps\.reread\(event\)/);
    const route = read("src/app/api/integrations/jira/webhook/route.ts");
    expect(route).toContain("reread: (event) => rereadForDelivery(event, provider),");
    expect(route).not.toMatch(PAYMENT_CODE);
  });
});
