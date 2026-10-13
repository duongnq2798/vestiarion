import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { OrgMembership } from "@/lib/auth/membership";
import type { Portfolio } from "@/lib/accountant/read";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

vi.mock("server-only", () => ({}));

import { readLimitsSet, readOnboardingMarks, readPersonActs, recordOnboardingMarks } from "@/lib/onboarding/read";
import { readAccountantOnboarding } from "@/lib/onboarding/accountant";

/**
 * What a member's checklist is ticked from (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * R4): the marks of migration 0114 and the person's own signed acts, read and written in the workspace's scope only;
 * before 0114 runs, nothing is marked and nothing throws.
 */

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const ME = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a2";
const NOT_SET_UP: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.onboarding_marks' in the schema cache" } };

function inScope<T>(respond: (sent: RecordedRequest) => FakeReply, fn: () => Promise<T>) {
  const fake = fakeSupabase(respond);
  return { fake, run: () => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ME }), fn) };
}

describe("readOnboardingMarks", () => {
  it("reads the workspace's marks: this person's own, and whether anyone kept the limits", async () => {
    const { fake, run } = inScope(
      () => ({
        body: [
          { user_id: ME, mark: "approvals_opened" },
          { user_id: OTHER, mark: "dismissed_approver" },
          { user_id: OTHER, mark: "limits_confirmed" },
          { user_id: ME, mark: "not_a_mark" },
        ],
      }),
      () => readOnboardingMarks(ME)
    );
    const marks = await run();
    expect(marks.available).toBe(true);
    expect([...marks.mine]).toEqual(["approvals_opened"]);
    expect(marks.limitsConfirmed).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe("/rest/v1/onboarding_marks");
    expect(fake.requests[0].params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("reads as not set up before migration 0114 runs, and never throws", async () => {
    const marks = await inScope(() => NOT_SET_UP, () => readOnboardingMarks(ME)).run();
    expect(marks).toEqual({ available: false, mine: new Set(), limitsConfirmed: false });
    const failed = await inScope(() => ({ status: 500, body: { code: "XX000", message: "boom" } }), () => readOnboardingMarks(ME)).run();
    expect(failed.available).toBe(false);
  });
});

describe("recordOnboardingMarks", () => {
  it("adds each mark once for this person in this workspace, leaving one already there as it is", async () => {
    const { fake, run } = inScope(() => ({ status: 201, body: [] }), () => recordOnboardingMarks(ME, ["approvals_opened", "held_reason_seen", "approvals_opened"]));
    expect(await run()).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const [sent] = fake.requests;
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/rest/v1/onboarding_marks");
    expect(sent.params.get("on_conflict")).toBe("org_id,user_id,mark");
    expect(sent.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(sent.body).toEqual([
      { user_id: ME, mark: "approvals_opened", org_id: ORG },
      { user_id: ME, mark: "held_reason_seen", org_id: ORG },
    ]);
  });

  it("saves nothing before migration 0114 runs, and says so without throwing", async () => {
    expect(await inScope(() => NOT_SET_UP, () => recordOnboardingMarks(ME, ["dismissed_owner"])).run()).toBe(false);
  });

  it("sends nothing for no mark", async () => {
    const { fake, run } = inScope(() => ({ body: [] }), () => recordOnboardingMarks(ME, []));
    expect(await run()).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("readPersonActs", () => {
  it("reads this person's own signed acts: decisions, a booking, a receipt applied, a hand-off", async () => {
    const { fake, run } = inScope(() => ({ body: [{ action: "approval_returned" }, { action: "handoff_exported" }] }), () => readPersonActs(ME));
    expect(await run()).toEqual({ decided: true, booked: false, applied: false, handedOff: true });
    const [sent] = fake.requests;
    expect(sent.path).toBe("/rest/v1/ledger_entries");
    expect(sent.params.get("actor")).toBe("eq.human");
    expect(sent.params.get("detail->>by")).toBe(`eq.${ME}`);
    expect(sent.params.get("org_id")).toBe(`eq.${ORG}`);
    const actions = sent.params.get("action") ?? "";
    for (const action of ["approval_paid", "approval_rejected", "approval_returned", "decision_verdict", "accounting_payment_approved", "ar_payment_applied", "handoff_exported"]) {
      expect(actions).toContain(action);
    }
  });

  it("ticks a booking and a receipt applied from their own entries", async () => {
    expect(await inScope(() => ({ body: [{ action: "accounting_payment_approved" }] }), () => readPersonActs(ME)).run()).toMatchObject({ booked: true, applied: false });
    expect(await inScope(() => ({ body: [{ action: "ar_payment_applied" }] }), () => readPersonActs(ME)).run()).toMatchObject({ booked: false, applied: true });
  });

  it("ticks nothing when the read fails", async () => {
    expect(await inScope(() => ({ status: 500, body: { message: "boom" } }), () => readPersonActs(ME)).run()).toEqual({ decided: false, booked: false, applied: false, handedOff: false });
  });
});

describe("readLimitsSet", () => {
  it("is true once a person changed the spending limit or the two-approval figure", async () => {
    const { fake, run } = inScope(() => ({ body: [{ seq: 12 }] }), () => readLimitsSet());
    expect(await run()).toBe(true);
    expect(fake.requests[0].params.get("actor")).toBe("eq.human");
    expect(fake.requests[0].params.get("action")).toBe("in.(agent_budget_changed,approval_policy_changed)");
    expect(await inScope(() => ({ body: [] }), () => readLimitsSet()).run()).toBe(false);
  });
});

describe("readAccountantOnboarding (R3)", () => {
  const HARBOR = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c11";
  const LUMEN = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c12";
  const OWNED = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c13";
  const membership = (orgId: string, slug: string, role: OrgMembership["role"]): OrgMembership => ({ orgId, slug, name: slug, mode: "live", role, network: "arc-testnet" });
  const MEMBERSHIPS = [membership(HARBOR, "harbor-bakery", "accountant"), membership(LUMEN, "lumen-studio", "accountant"), membership(OWNED, "own-shop", "owner")];
  const EMPTY: Portfolio = { workspaces: [], items: [] };

  function claimsOf(request: RecordedRequest): Record<string, unknown> {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    return JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as Record<string, unknown>;
  }

  function world(perOrg: Record<string, { marks?: Array<{ user_id: string; mark: string }>; acts?: string[]; marksMissing?: boolean }>) {
    const fake = fakeSupabase((sent): FakeReply => {
      if (sent.path === "/rest/v1/orgs") {
        const id = sent.params.get("id")?.replace(/^eq\./, "") ?? "";
        return { body: orgs.orgRow(id, { slug: "x", mode: "live", network: "arc-testnet" }) };
      }
      const orgId = String(claimsOf(sent).org_id ?? "");
      const state = perOrg[orgId] ?? {};
      if (sent.path === "/rest/v1/onboarding_marks") {
        if (state.marksMissing) return NOT_SET_UP;
        return sent.method === "POST" ? { status: 201, body: [] } : { body: state.marks ?? [] };
      }
      if (sent.path === "/rest/v1/ledger_entries") return { body: (state.acts ?? []).map((action) => ({ action })) };
      return { body: [] };
    });
    const read = (portfolio: Portfolio = EMPTY, queue: string | null = null) =>
      runWith({ config, db: fake.client, fetch: fake.fetch }, () => readAccountantOnboarding(ME, MEMBERSHIPS, portfolio, queue));
    return { fake, read };
  }

  it("shows nobody who keeps no workspace's books a checklist", async () => {
    const { fake } = world({});
    const none = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => readAccountantOnboarding(ME, [membership(OWNED, "own-shop", "owner")], EMPTY, null));
    expect(none).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("ticks the console as open, records it in each workspace the person keeps the books of, as them, and never in their own", async () => {
    const { fake, read } = world({});
    const onboarding = await read();
    expect(onboarding?.checklist.steps.find((step) => step.id === "console")?.done).toBe(true);
    expect(onboarding?.canDismiss).toBe(true);
    const writes = fake.requests.filter((sent) => sent.path === "/rest/v1/onboarding_marks" && sent.method === "POST");
    expect(writes.map((sent) => claimsOf(sent).org_id).sort()).toEqual([HARBOR, LUMEN]);
    for (const sent of writes) {
      expect(claimsOf(sent).sub).toBe(ME);
      expect(sent.body).toEqual([{ user_id: ME, mark: "accountant_console_opened", org_id: claimsOf(sent).org_id }]);
    }
    expect(fake.requests.some((sent) => claimsOf(sent).org_id === OWNED)).toBe(false);
  });

  it("records one workspace's queue opened when the console is narrowed to it", async () => {
    const { fake, read } = world({});
    const onboarding = await read(EMPTY, "lumen-studio");
    expect(onboarding?.checklist.steps.find((step) => step.id === "queue")?.done).toBe(true);
    const lumen = fake.requests.find((sent) => sent.method === "POST" && claimsOf(sent).org_id === LUMEN);
    expect(lumen?.body).toEqual([
      { user_id: ME, mark: "accountant_console_opened", org_id: LUMEN },
      { user_id: ME, mark: "accountant_queue_opened", org_id: LUMEN },
    ]);
  });

  it("ticks a step done in any of the person's workspaces, and stays dismissed once dismissed in one", async () => {
    const { read } = world({
      [HARBOR]: { marks: [{ user_id: ME, mark: "accountant_console_opened" }], acts: ["ar_payment_applied"] },
      [LUMEN]: { marks: [{ user_id: ME, mark: "dismissed_accountant" }], acts: ["handoff_exported"] },
    });
    const onboarding = await read();
    const done = Object.fromEntries(onboarding!.checklist.steps.map((step) => [step.id, step.done]));
    expect(done).toEqual({ console: true, queue: false, book: true, handoff: true });
    expect(onboarding?.checklist.show).toBe(false);
  });

  it("opens the bookings review where a payment waits for this accountant, in that workspace", async () => {
    const { read } = world({});
    const portfolio: Portfolio = {
      workspaces: [],
      items: [
        {
          key: "lumen-studio:to_book:p1",
          kind: "to_book",
          workspace: { slug: "lumen-studio", name: "Lumen Studio" },
          title: "A payment of Oct 12, 2026",
          detail: "Waiting for review before it is booked in Xero.",
          amount: { value: 640, currency: "USDC" },
          since: "2026-10-12T15:20:00.000Z",
          href: "/o/lumen-studio/invoices?review=book-xero",
          canAct: true,
          who: "You can book it",
        },
      ],
    };
    const onboarding = await read(portfolio);
    expect(onboarding?.slug).toBe("lumen-studio");
    expect(onboarding?.checklist.steps.find((step) => step.id === "book")).toMatchObject({ path: "/invoices?review=book-xero", needs: "accounting.book" });
    expect(onboarding?.checklist.steps.find((step) => step.id === "handoff")?.href).toBe("/api/accountant/handoff?org=lumen-studio&format=csv");
  });

  it("before migration 0114 runs, still shows the checklist, ticks the console from this visit, and offers no Don't show again", async () => {
    const { read } = world({ [HARBOR]: { marksMissing: true }, [LUMEN]: { marksMissing: true } });
    const onboarding = await read();
    expect(onboarding?.canDismiss).toBe(false);
    expect(onboarding?.checklist.show).toBe(true);
    expect(onboarding?.checklist.steps[0].done).toBe(true);
  });
});
