import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { followUpHeldMilestones } from "@/lib/agent/orchestrator";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The contractor stage in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S2), read from its
 * source as tests/milestone-cash-hold.test.ts reads it: a release that passed every check waits for a person to agree,
 * never planned and never sent, and its entry says why.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("await writeDecision({"));

describe("the contractor stage in shadow mode", () => {
  it("reads shadow mode once for the stage, when anything is decided", () => {
    expect(stage).toContain("const shadow = milestones.length > 0 ? await readShadowMode(db) : null;");
  });

  it("holds a release for a person after every guardrail, before it is weighed against the cash, counted or planned", () => {
    expect(release).toContain("} else if (shadow) {");
    expect(release).toContain("heldForVerdict = true;");
    expect(release).toContain("reasoning += SHADOW_HELD_NOTE;");
    expect(release.indexOf("} else if (shadow) {")).toBeGreaterThan(release.indexOf("} else if (onChainHold) {"));
    expect(release.indexOf("} else if (shadow) {")).toBeLessThan(release.indexOf("releaseCashShort("));
    expect(release.indexOf("} else if (shadow) {")).toBeLessThan(release.indexOf("budget.spend(amount);"));
    expect(release.indexOf("} else if (shadow) {")).toBeLessThan(release.indexOf("planned.push("));
  });

  it("records why it held, so the follow-up never reopens it", () => {
    const entry = stage.slice(stage.indexOf("action: `milestone_${decision.action}`"));
    expect(entry).toContain("...(heldForVerdict ? { heldBecause: HELD_FOR_VERDICT } : {}),");
    expect(stage).toContain("heldForVerdict,");
  });
});

describe("the follow-up of a milestone held in shadow mode", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });
  const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b1b1";
  const MILESTONE = "018f8ce0-1557-7b54-a931-4d777f6bb001";

  it("reads why it held from its entry, and leaves it held though the contractor's risk changed since", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: { id: ORG, slug: "shadow-co", name: "Shadow Co", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
      if (request.path === "/rest/v1/milestones" && request.method === "GET") {
        return { body: [{ id: MILESTONE, title: "Launch", amount: "5", verification_source: "PR #84", counterparties: { risk_level: "high", payment_limit: "10" } }] };
      }
      if (request.path === "/rest/v1/ledger_entries" && request.method === "GET") {
        return {
          body: [
            {
              detail: {
                milestoneId: MILESTONE,
                decision: { action: "release" },
                observed: { riskLevel: "clear", paymentLimit: 10, verificationSource: "PR #84" },
                execution: { resultingStatus: "held", heldBecause: "shadow_verdict" },
              },
            },
          ],
        };
      }
      return { body: [] };
    });
    const lines = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => followUpHeldMilestones(db())));
    expect(lines).toEqual([]);
    expect(fake.requests.filter((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH")).toHaveLength(0);
    expect(fake.requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry")).toHaveLength(0);
  });
});
