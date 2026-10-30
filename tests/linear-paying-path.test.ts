import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing on the paying or deciding path changes for Linear except through the milestone's existing verification state
 * (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN12, LN13), pinned as source structure, as Asana's is
 * (tests/asana-paying-path.test.ts):
 * - the agent reaches Linear only through the reads of accepted work Asana's go through, `refreshAcceptedWork` and
 *   `recheckAcceptedWork` in src/lib/milestone-verification.ts, which read both tools at once;
 * - the payments, the held milestone decisions and the escrow never name Linear;
 * - Linear's code writes a milestone only through 0147's two functions (its verification) and its criteria, never an
 *   amount, a payee, an address or a payment intent;
 * - Pay now's one Linear check only refuses the payee.
 */

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const IMPORTS_LINEAR = /from "(?:\.\.?\/)+(?:lib\/)?linear\/|from "@\/lib\/linear\//;

describe("the agent and the payments (Linear acceptance LN12, LN13)", () => {
  it("never import Linear, but for the reads of accepted work beside Asana's", () => {
    const watched = [
      ...files(path.join(root, "src", "lib", "agent")),
      ...files(path.join(root, "src", "lib", "circle")),
      path.join(root, "src", "lib", "payments.ts"),
      path.join(root, "src", "lib", "payout-route.ts"),
      path.join(root, "src", "lib", "two-approvals.ts"),
      ...["payables.ts", "payment-plan.ts", "bookings.ts", "allocations.ts"].map((name) => path.join(root, "src", "lib", "commands", name)),
    ];
    for (const file of watched) expect(readFileSync(file, "utf8"), path.relative(root, file)).not.toMatch(IMPORTS_LINEAR);
    const verification = read("src/lib/milestone-verification.ts");
    expect(verification).toContain('import { recheckLinearBeforeSending, refreshLinearMilestones } from "./linear/workspace";');
    // Both tools read at once, so the read before sending still waits at most its one deadline.
    expect(verification).toMatch(/Promise\.all\(\[refreshAsanaMilestones\(\), refreshLinearMilestones\(\)\]\)/);
    expect(verification).toMatch(/Promise\.all\(\[recheckBeforeSending\(milestoneIds\), recheckLinearBeforeSending\(milestoneIds\)\]\)/);
    const orchestrator = read("src/lib/agent/orchestrator.ts");
    expect(orchestrator).toMatch(/if \(!recheck\.linear\.complete\) \{\s*lines\.push\(/);
  });
});

describe("Linear's own code", () => {
  const linear = files(path.join(root, "src", "lib", "linear")).map((file) => ({ file: path.relative(root, file), source: readFileSync(file, "utf8") }));
  const commands = { file: path.join("src", "lib", "commands", "linear.ts"), source: read("src/lib/commands/linear.ts") };

  it("writes no payment intent, amount, payee or address", () => {
    for (const { file, source } of [...linear, commands]) {
      expect(source, file).not.toMatch(/from\("payment_intents"\)/);
      for (const write of source.matchAll(/\.(?:update|insert|upsert)\(\{([\s\S]*?)\}\)/g)) {
        expect(write[1], file).not.toMatch(/\b(?:amount|contractor_id|address|payout|escrow_\w+)\s*:/);
      }
    }
  });

  it("writes a milestone only to keep its criteria; its verification moves only in 0147's two functions", () => {
    const writes = [...linear, commands].flatMap(({ file, source }) =>
      [...source.matchAll(/\.from\("milestones"\)\s*\.(update|insert|upsert|delete)\(([^)]*)\)/g)].map((match) => ({ file, args: match[2] }))
    );
    expect(writes).toEqual([{ file: path.join("src", "lib", "linear", "links.ts"), args: "{ acceptance_criteria: criteria, acceptance_criteria_by: by, acceptance_criteria_at: nowIso }" }]);
    const sql = read("supabase/migrations/0147_linear_acceptance.sql");
    const updates = [...sql.matchAll(/update public\.milestones\s+set([\s\S]*?)\s+where/g)].map((match) => match[1]);
    expect(updates).toHaveLength(2);
    for (const set of updates) {
      expect(set).not.toMatch(/\b(amount|contractor_id|escrow_|tx_ref|address)\b/);
      expect(set).toMatch(/verified =/);
    }
  });

  it("calls Linear from Pay now only to refuse its payee, by email, without asking Linear", () => {
    const milestones = read("src/lib/commands/milestones.ts");
    expect(milestones).toContain('import { approvesOwnLinearPayout } from "../linear/identities";');
    expect(milestones).toMatch(/if \(await approvesOwnLinearPayout\(actor, input\.milestoneId\)\) return refused\("self_payout"/);
    expect(milestones.match(/approvesOwnLinearPayout/g)).toHaveLength(2);
    expect(read("src/lib/linear/identities.ts")).toMatch(/identitiesOf\(member, milestone, null\)/);
  });

  it("reads a webhook's body for the Linear workspace and the issue's id only", () => {
    const webhook = read("src/lib/linear/webhook.ts");
    expect(webhook.match(/JSON\.parse/g)).toHaveLength(1);
    expect(webhook).toMatch(/deps\.reread\(event\)/);
  });
});
