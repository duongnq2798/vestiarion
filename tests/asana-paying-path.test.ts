import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stillVerified } from "@/lib/agent/orchestrator";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Nothing on the paying or deciding path changes for Asana except through the milestone's existing verification state
 * (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A12), pinned as source structure:
 * - the agent reaches Asana through two calls, `refreshAcceptedWork`, beside GitHub's check, before the contractor stage,
 *   and `recheckAcceptedWork`, on the releases the stage is about to send, right before its still-verified check; and
 *   that stage still pays only milestones `verified` and in status `verified`;
 * - the payments, the held milestone decisions and the escrow never name Asana;
 * - Asana's code writes a milestone only through 0115's two functions (its verification) and its criteria, never an
 *   amount, a payee, an address or a payment intent;
 * - Pay now's one Asana check only refuses the payee.
 */

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const IMPORTS_ASANA = /from "(?:\.\.?\/)+(?:lib\/)?asana\/|from "@\/lib\/asana\//;

describe("the agent and the payments", () => {
  it("never import Asana, but for the reads of accepted work beside GitHub's check and before sending", () => {
    const watched = [
      ...files(path.join(root, "src", "lib", "agent")),
      ...files(path.join(root, "src", "lib", "circle")),
      path.join(root, "src", "lib", "payments.ts"),
      path.join(root, "src", "lib", "payout-route.ts"),
      path.join(root, "src", "lib", "two-approvals.ts"),
      ...["payables.ts", "payment-plan.ts", "bookings.ts", "allocations.ts"].map((name) => path.join(root, "src", "lib", "commands", name)),
    ];
    for (const file of watched) expect(readFileSync(file, "utf8"), path.relative(root, file)).not.toMatch(IMPORTS_ASANA);
    const orchestrator = read("src/lib/agent/orchestrator.ts");
    expect(orchestrator).toContain('import { recheckAcceptedWork, refreshAcceptedWork, refreshGitHubMilestones } from "../milestone-verification";');
    // Read before the contractor stage, as GitHub's pull requests are.
    expect(orchestrator.indexOf("await refreshAcceptedWork()")).toBeGreaterThan(orchestrator.indexOf("await refreshGitHubMilestones()"));
    expect(orchestrator.indexOf("await refreshAcceptedWork()")).toBeLessThan(orchestrator.indexOf('await stage("contractors"'));
    // The contractor stage decides only what is verified, by the existing state.
    const stage = orchestrator.slice(orchestrator.indexOf('await stage("contractors"'));
    expect(stage.slice(0, 600)).toMatch(/\.from\("milestones"\)[\s\S]*?\.eq\("verified", true\)\s*\.eq\("status", "verified"\)/);
  });

  it("send a release only for a milestone still verified just before it is sent, after every decision of the stage", () => {
    // A task reopened while the stage decides (a webhook's read, say) takes the verification back; the release the stage
    // planned before that is held to the milestone as it is now, and one no longer verified is neither sent nor written.
    const orchestrator = read("src/lib/agent/orchestrator.ts");
    const stage = orchestrator.slice(orchestrator.indexOf('await stage("contractors"'), orchestrator.indexOf('await stage("treasury"'));
    const check = stage.indexOf("await stillVerified(db, planned.map((entry) => entry.milestone.id))");
    expect(check).toBeGreaterThan(stage.lastIndexOf("planned.push("));
    expect(check).toBeLessThan(stage.indexOf("await releaseMilestones("));
    // The accepted Asana tasks of exactly those releases are read once more first, so a task reopened while the stage
    // decided takes its verification back before the check (on Arc testnet, Oct 14: a task reopened 3 seconds after the
    // cycle's read had its release sent 6 seconds later).
    const recheck = stage.indexOf("await recheckAcceptedWork(planned.map((entry) => entry.milestone.id))");
    expect(recheck).toBeGreaterThan(stage.lastIndexOf("planned.push("));
    expect(recheck).toBeLessThan(check);
    expect(stage.match(/recheckAcceptedWork\(/g)).toHaveLength(1);
    expect(stage).toMatch(/const sending = planned\.filter\(\(entry\) => verifiedNow\.has\(entry\.milestone\.id\)\);/);
    expect(stage).toMatch(/await releaseMilestones\(\s*sending\.map\(/);
    expect(stage).toMatch(/for \(const \[position, entry\] of sending\.entries\(\)\)/);
  });

  it("read which milestones are still verified, and waiting to be paid, from the milestones themselves", async () => {
    const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-0000000a5a99";
    const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
    const fake = fakeSupabase((sent) => (sent.path === "/rest/v1/milestones" ? { body: [{ id: "m-still" }] } : { body: [] }));
    const found = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => stillVerified(db(), ["m-still", "m-taken-back"]));
    expect([...found]).toEqual(["m-still"]);
    const sent = fake.requests.find((one) => one.path === "/rest/v1/milestones");
    expect(sent?.params.get("id")).toBe("in.(m-still,m-taken-back)");
    expect(sent?.params.get("verified")).toBe("eq.true");
    expect(sent?.params.get("status")).toBe("eq.verified");
    expect(await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => stillVerified(db(), []))).toEqual(new Set());
  });

  it("call Asana from Pay now only to refuse its payee", () => {
    const milestones = read("src/lib/commands/milestones.ts");
    expect(milestones).toContain('import { paysOwnPayout } from "../asana/identities";');
    expect(milestones).toMatch(/if \(await paysOwnPayout\(actor, input\.milestoneId\)\) return refused\("self_payout"/);
    expect(milestones.match(/paysOwnPayout/g)).toHaveLength(2);
  });
});

describe("Asana's own code", () => {
  const asana = files(path.join(root, "src", "lib", "asana")).map((file) => ({ file: path.relative(root, file), source: readFileSync(file, "utf8") }));

  it("writes no payment intent, amount, payee or address", () => {
    for (const { file, source } of asana) {
      expect(source, file).not.toMatch(/from\("payment_intents"\)/);
      // Every object it writes: none names an amount, a payee or an address.
      for (const write of source.matchAll(/\.(?:update|insert|upsert)\(\{([\s\S]*?)\}\)/g)) {
        expect(write[1], file).not.toMatch(/\b(?:amount|contractor_id|address|payout|escrow_\w+)\s*:/);
      }
    }
  });

  it("writes a milestone only to keep its criteria; its verification moves only in 0115's two functions", () => {
    const writes = asana.flatMap(({ file, source }) => [...source.matchAll(/\.from\("milestones"\)\s*\.(update|insert|upsert|delete)\(([^)]*)\)/g)].map((match) => ({ file, args: match[2] })));
    expect(writes).toEqual([{ file: path.join("src", "lib", "asana", "links.ts"), args: "{ acceptance_criteria: criteria, acceptance_criteria_by: by, acceptance_criteria_at: nowIso }" }]);
    const sql = read("supabase/migrations/0115_asana_acceptance.sql");
    const updates = [...sql.matchAll(/update public\.milestones\s+set([\s\S]*?)\s+where/g)].map((match) => match[1]);
    expect(updates).toHaveLength(2);
    for (const set of updates) {
      expect(set).not.toMatch(/\b(amount|contractor_id|escrow_|tx_ref|address)\b/);
      expect(set).toMatch(/verified =/);
    }
  });

  it("reads a webhook's body for nothing but its signature and whether it is a heartbeat", () => {
    const webhook = read("src/lib/asana/webhook.ts");
    expect(webhook).not.toMatch(/JSON\.parse/);
    expect(webhook).toMatch(/deps\.reread\(webhook\)/);
  });
});
