import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planFollowUp, type DecisionFacts, type FrozenInvoice } from "@/lib/agent/follow-up";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { firstPaymentFrom, loadNewPayeeFacts, newPayeeFollowUp } from "@/lib/new-payee-facts";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The cycle's wiring of the new payee check (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N3, N5),
 * pinned as source structure where a full `runAgentCycle()` is out of proportion (see tests/orchestrator.test.ts). The
 * rule is tested in tests/new-payee.test.ts and tests/guardrails.test.ts, its reads in tests/new-payee-facts.test.ts,
 * and the AP stage end to end in tests/ap-stage.test.ts. What is left is the cycle passing it wherever payments are real,
 * and, for an address a payee link brought in, what the contractor stage and the follow-up make of the facts they read.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

describe("the cycle and the first payment to a new payee", () => {
  it("gives the AP stage the check wherever payments are real", () => {
    const ap = source.slice(source.indexOf('await stage("ap"'), source.indexOf('await stage("contractors"'));
    expect(ap).toContain('...(provider.mode === "live" ? { newPayee: { load: (ids: string[]) => loadNewPayeeFacts(db, ids) } } : {}),');
  });

  it("holds a milestone's first release to an address one party alone stands behind", () => {
    const contractors = source.slice(source.indexOf('await stage("contractors"'), source.indexOf('await stage("treasury"'));
    expect(contractors).toContain('provider.mode === "live" && milestones.length > 0 ? await loadNewPayeeFacts(db, [...new Set(milestones.map((m) => m.contractor_id))]) : null');
    // The check for each contractor at its address, as tests below run it.
    expect(contractors).toContain("const firstReleaseTo = (contractor: { id: string; address: string | null }) => (newPayeeFacts ? firstPaymentFrom(newPayeeFacts, contractor) : null);");
    expect(contractors).toContain("const newPayeeHeld = firstRelease !== null && !firstRelease.twoParties;");
    expect(contractors).toContain('guardrailRule = "counterparty.new_payee"');
    // Recorded as the AP stage records it, the member who asked for the address included (tests/new-payee.test.ts).
    expect(contractors).toContain("...(firstRelease ? { newPayee: newPayeeObserved(firstRelease) } : {}),");
  });
});

describe("the follow-up and a payable held as a new payee (new payee check N7)", () => {
  const followUp = source.slice(source.indexOf("const frozenRows = unwrap("), source.indexOf("followUpHeldMilestones(db, budget)"));

  it("reads the payee's address with each frozen payable, and which decisions held it as a new payee", () => {
    expect(followUp).toMatch(/"id, status, amount, currency, due_date, decided_at, escalated_at, po_reference, goods_received, counterparty_id, counterparties\([^)]*address,/);
    expect(followUp).toContain('newPayeeHeld: entry.detail.guardrailRule === "counterparty.new_payee",');
  });

  it("asks who stands behind those addresses now, wherever payments are real, and hands it to the plan", () => {
    expect(followUp).toContain('provider.mode === "live" && newPayeeHeldIds.length > 0 ? await loadNewPayeeFacts(db, newPayeeHeldIds) : null');
    expect(followUp).toContain("const now = newPayeeFollowUp(newPayeeFacts, { id: row.counterparty_id, address: row.counterparties.address ?? null });");
    expect(followUp).toContain("...(newPayeeNow.has(row.id) ? { newPayee: newPayeeNow.get(row.id) } : {}),");
  });
});

/**
 * An address a payee link brought in (independent review, 2026-10-15), through the facts the contractor stage and the
 * follow-up read, as wired above: the member who created the link, read from its signed entry, is not a second person.
 */
describe("the contractor stage and the follow-up, for an address sent through a payee link", () => {
  const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0c0";
  const ANNA = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
  const BAO = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
  const LINK = "7c1e2d3f-0000-4000-8000-00000000c1c1";
  const PAYEE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc002";
  const ADDRESS = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  /** Anna created the link, the payee sent the address through it, and `confirmedBy` confirmed it. Anna's account may since be gone. */
  async function facts(confirmedBy: string, linkRow: { created_by: string | null } = { created_by: ANNA }) {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") {
        return { body: { id: ORG, slug: "demo", name: "Demo", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
      }
      if (request.path === "/rest/v1/payment_intents") return { body: [] };
      if (request.path === "/rest/v1/payee_links") return { body: [{ id: LINK, ...linkRow }] };
      if (request.path === "/rest/v1/ledger_entries") {
        return {
          body: [
            { action: "counterparty_address_confirmed", detail: { by: confirmedBy, counterpartyId: PAYEE_ID, address: ADDRESS, via: "confirm" } },
            { action: "counterparty_address_changed", detail: { by: null, via: "payee_link", linkId: LINK, counterpartyId: PAYEE_ID, from: null, to: ADDRESS } },
            { action: "payee_link_created", detail: { by: ANNA, counterpartyId: PAYEE_ID, linkId: LINK, expiresAt: "2026-10-22T00:00:00Z" } },
          ],
        };
      }
      return { body: [] };
    });
    return runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => loadNewPayeeFacts(db(), [PAYEE_ID])));
  }
  const contractor = { id: PAYEE_ID, address: ADDRESS };

  it("the contractor stage holds the first release when the member who created the link is the one who confirmed the address", async () => {
    const firstRelease = firstPaymentFrom(await facts(ANNA), contractor);
    expect(firstRelease).toMatchObject({ linkCreatedBy: ANNA, confirmedBy: ANNA, twoParties: false });
    // The stage's own condition for `counterparty.new_payee`, pinned above.
    expect(firstRelease !== null && !firstRelease.twoParties).toBe(true);
  });

  it("the contractor stage releases it when another member confirmed the address", async () => {
    const firstRelease = firstPaymentFrom(await facts(BAO), contractor);
    expect(firstRelease).toMatchObject({ linkCreatedBy: ANNA, confirmedBy: BAO, twoParties: true });
    expect(firstRelease !== null && !firstRelease.twoParties).toBe(false);
  });

  describe("the follow-up", () => {
    const NOW = Date.parse("2026-10-15T12:00:00.000Z");
    const heldAsNewPayee: DecisionFacts = { poReference: "PO-1", goodsReceived: true, riskLevel: "clear", paymentLimit: 2, newPayeeHeld: true };
    const held = (newPayee: FrozenInvoice["newPayee"]): FrozenInvoice => ({
      id: "inv-1",
      status: "held",
      amount: 0.95,
      dueDate: "2026-10-20T00:00:00.000Z",
      decidedAt: "2026-10-14T12:00:00.000Z",
      escalatedAt: null,
      poReference: "PO-1",
      goodsReceived: true,
      riskLevel: "clear",
      paymentLimit: 2,
      newPayee,
    });
    const plan = async (confirmedBy: string, linkRow?: { created_by: string | null }) =>
      planFollowUp(held(newPayeeFollowUp(await facts(confirmedBy, linkRow), contractor) ?? undefined), heldAsNewPayee, NOW, { staleAfterDays: 3, reEscalateAfterDays: 7 });

    it("does not reopen a payable held as a new payee when only the member who created the link confirmed the address", async () => {
      expect((await plan(ANNA)).action).toBe("wait");
    });

    it("does not reopen it either once that member's account is deleted", async () => {
      expect((await plan(ANNA, { created_by: null })).action).toBe("wait");
    });

    it("reopens it once another member confirmed the address", async () => {
      const reopened = await plan(BAO);
      expect(reopened.action).toBe("reopen");
      expect(reopened.changes).toEqual(["a second person now stands behind the payee's address"]);
    });
  });
});
