import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  approvalAgrees,
  clearApprovals,
  giveApproval,
  mayGiveApproval,
  openApprovals,
  standingApprovals,
  useApprovals,
} from "@/lib/agent/second-approval";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The approvals people give a payment above the workspace's figure (docs/superpowers/specs/2026-10-05-two-approvals-design.md
 * T4–T6): bound to the payment they approved, counted only while they agree with it and their giver may still approve,
 * used once by the approval that pays, cleared by Reject, Return and Close.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const ANNA = "a1b2c3d4-0000-4000-8000-0000000000e1";
const BAO = "a1b2c3d4-0000-4000-8000-0000000000e2";
const CHI = "a1b2c3d4-0000-4000-8000-0000000000e3";
const INVOICE = "11111111-2222-4333-8444-555555555555";
const SOURCE = { type: "invoice" as const, id: INVOICE };
const PAYMENT = { amount: 120, currency: "USDC" as const, address: "0xAbC0000000000000000000000000000000000001" };

const row = (by: string, over: Record<string, unknown> = {}) => ({
  id: `appr-${by.slice(-2)}`,
  approved_by: by,
  approved_at: "2026-10-05T08:00:00.000Z",
  amount: "120.000000",
  currency: "USDC",
  address: "0xabc0000000000000000000000000000000000001",
  ...over,
});

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ANNA }), fn);

function workspace(over: { open?: unknown[]; approvers?: string[]; besides?: number; insert?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/payment_approvals" && r.method === "GET") return { body: over.open ?? [] };
    if (r.path === "/rest/v1/payment_approvals" && r.method === "POST") {
      return over.insert ?? { status: 201, body: { id: "appr-new", approved_by: (r.body as { approved_by: string }).approved_by, approved_at: "2026-10-05T09:00:00.000Z", amount: "120", currency: "USDC", address: PAYMENT.address } };
    }
    if (r.path === "/rest/v1/payment_approvals") return { body: [] };
    if (r.path === "/rest/v1/rpc/approvers_among") return { body: over.approvers ?? [ANNA, BAO, CHI] };
    if (r.path === "/rest/v1/rpc/approvers_besides") return { body: over.besides ?? 2 };
    return { body: [] };
  };
}

describe("openApprovals", () => {
  it("reads a payment's open approvals, oldest first", async () => {
    fake = fakeSupabase(workspace({ open: [row(ANNA)] }));
    expect(await run(() => openApprovals(SOURCE))).toEqual([
      { id: "appr-e1", by: ANNA, at: "2026-10-05T08:00:00.000Z", amount: 120, currency: "USDC", address: "0xabc0000000000000000000000000000000000001" },
    ]);
    const read = fake.requests.find((r) => r.path === "/rest/v1/payment_approvals")!;
    expect(read.params.get("source_type")).toBe("eq.invoice");
    expect(read.params.get("source_id")).toBe(`eq.${INVOICE}`);
    expect(read.params.get("used_at")).toBe("is.null");
    expect(read.params.get("order")).toBe("approved_at.asc");
  });
});

describe("approvalAgrees", () => {
  const given = { id: "a", by: ANNA, at: "t", amount: 120, currency: "USDC", address: "0xabc0000000000000000000000000000000000001" };

  it("agrees with the payment it approved, the address's case aside", () => {
    expect(approvalAgrees(given, PAYMENT)).toBe(true);
  });

  it("does not once the amount, the currency or the address changed", () => {
    expect(approvalAgrees(given, { ...PAYMENT, amount: 121 })).toBe(false);
    expect(approvalAgrees(given, { ...PAYMENT, currency: "EURC" })).toBe(false);
    expect(approvalAgrees(given, { ...PAYMENT, address: "0xdef0000000000000000000000000000000000002" })).toBe(false);
    expect(approvalAgrees(given, { ...PAYMENT, address: null })).toBe(false);
  });
});

describe("standingApprovals", () => {
  it("keeps the open approvals that agree with the payment and whose giver may still approve", async () => {
    fake = fakeSupabase(workspace({ open: [row(ANNA), row(BAO, { amount: "99" }), row(CHI)], approvers: [ANNA] }));
    const standing = await run(() => standingApprovals(SOURCE, PAYMENT));
    expect(standing.map((approval) => approval.by)).toEqual([ANNA]);
    const asked = fake.requests.find((r) => r.path === "/rest/v1/rpc/approvers_among");
    expect(asked?.body).toEqual({ p_org_id: ORG, p_users: [ANNA, CHI] });
  });

  it("asks nothing more when no open approval agrees", async () => {
    fake = fakeSupabase(workspace({ open: [row(BAO, { currency: "EURC" })] }));
    expect(await run(() => standingApprovals(SOURCE, PAYMENT))).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/approvers_among")).toBe(false);
  });
});

describe("giveApproval", () => {
  it("replaces the person's earlier open approval with one of the payment as it stands", async () => {
    fake = fakeSupabase(workspace());
    const given = await run(() => giveApproval(SOURCE, BAO, PAYMENT));
    expect(given).toMatchObject({ by: BAO, at: "2026-10-05T09:00:00.000Z" });
    const [removed, inserted] = fake.requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method !== "GET");
    expect(removed.method).toBe("DELETE");
    expect(removed.params.get("approved_by")).toBe(`eq.${BAO}`);
    expect(removed.params.get("used_at")).toBe("is.null");
    expect(inserted.method).toBe("POST");
    expect(inserted.body).toMatchObject({
      org_id: ORG,
      source_type: "invoice",
      source_id: INVOICE,
      approved_by: BAO,
      amount: 120,
      currency: "USDC",
      address: PAYMENT.address,
    });
  });
});

describe("useApprovals and clearApprovals", () => {
  it("marks a payment's open approvals used", async () => {
    fake = fakeSupabase(workspace());
    await run(() => useApprovals(SOURCE));
    const patch = fake.requests.find((r) => r.method === "PATCH")!;
    expect(patch.path).toBe("/rest/v1/payment_approvals");
    expect(patch.params.get("source_id")).toBe(`eq.${INVOICE}`);
    expect(patch.params.get("used_at")).toBe("is.null");
    expect(Object.keys(patch.body as object)).toEqual(["used_at"]);
  });

  it("deletes a payment's open approvals", async () => {
    fake = fakeSupabase(workspace());
    await run(() => clearApprovals(SOURCE));
    const removed = fake.requests.find((r) => r.method === "DELETE")!;
    expect(removed.params.get("source_type")).toBe("eq.invoice");
    expect(removed.params.get("used_at")).toBe("is.null");
  });
});

describe("mayGiveApproval", () => {
  it("lets anyone not left out give one", async () => {
    fake = fakeSupabase(workspace({ besides: 0 }));
    expect(await run(() => mayGiveApproval({ actorId: ANNA, excluded: [BAO, null] }))).toBe(true);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/approvers_besides")).toBe(false);
  });

  it("lets whoever entered it, or gave the address, give one only when fewer than two others can", async () => {
    fake = fakeSupabase(workspace({ besides: 2 }));
    expect(await run(() => mayGiveApproval({ actorId: ANNA, excluded: [ANNA, BAO] }))).toBe(false);
    expect(fake.requests.find((r) => r.path === "/rest/v1/rpc/approvers_besides")?.body).toEqual({ p_org_id: ORG, p_excluded: [ANNA, BAO] });
    fake = fakeSupabase(workspace({ besides: 1 }));
    expect(await run(() => mayGiveApproval({ actorId: ANNA, excluded: [ANNA, ANNA, null] }))).toBe(true);
    expect(fake.requests.find((r) => r.path === "/rest/v1/rpc/approvers_besides")?.body).toEqual({ p_org_id: ORG, p_excluded: [ANNA] });
  });

  it("leaves out only members: a payee who gave its own address is no one here", async () => {
    fake = fakeSupabase(workspace({ besides: 1 }));
    expect(await run(() => mayGiveApproval({ actorId: ANNA, excluded: ["payee", ANNA] }))).toBe(true);
    expect(fake.requests.find((r) => r.path === "/rest/v1/rpc/approvers_besides")?.body).toEqual({ p_org_id: ORG, p_excluded: [ANNA] });
  });
});
