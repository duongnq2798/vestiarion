import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { ApprovalPolicyError, changeTwoApprovals, readTwoApprovalsAbove, twoApprovalsStatus } from "@/lib/approval-policy";
import { can } from "@/lib/auth/roles";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The figure above which a payment needs two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1):
 * one row per workspace, an owner's to change, two approvers needed to turn it on or lower it, refused while a cycle
 * runs, each change signed.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d";
const OWNER = "a1b2c3d4-0000-4000-8000-0000000000d1";

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: OWNER }), fn);

function workspace(over: { policy?: unknown[]; running?: unknown[]; approvers?: number; upsert?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/approval_policies" && r.method === "GET") return { body: over.policy ?? [] };
    if (r.path === "/rest/v1/approval_policies" && r.method === "POST") return over.upsert ?? { status: 201, body: null };
    if (r.path === "/rest/v1/cycle_runs") return { body: over.running ?? [] };
    if (r.path === "/rest/v1/rpc/approvers_besides") return { body: over.approvers ?? 2 };
    return { body: [] };
  };
}

const posted = () => fake.requests.filter((r) => r.path === "/rest/v1/approval_policies" && r.method === "POST");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("readTwoApprovalsAbove", () => {
  it("is the workspace's figure, or null with none set or one turned off", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "250.000000" }] }));
    expect(await run(() => readTwoApprovalsAbove(db()))).toBe(250);
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: null }] }));
    expect(await run(() => readTwoApprovalsAbove(db()))).toBeNull();
    fake = fakeSupabase(workspace());
    expect(await run(() => readTwoApprovalsAbove(db()))).toBeNull();
  });
});

describe("readTwoApprovalsAbove when the figure cannot be read", () => {
  it("fails, rather than read no figure and let one approval pay any amount, the table missing included", async () => {
    fake = fakeSupabase((r) =>
      r.path === "/rest/v1/approval_policies"
        ? { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.approval_policies' in the schema cache" } }
        : { body: [] }
    );
    await expect(run(() => readTwoApprovalsAbove(db()))).rejects.toThrow(/approval_policies/);
    fake = fakeSupabase((r) => (r.path === "/rest/v1/approval_policies" ? { status: 500, body: { code: "XX000", message: "boom" } } : { body: [] }));
    await expect(run(() => readTwoApprovalsAbove(db()))).rejects.toThrow("boom");
  });
});

describe("changeTwoApprovals", () => {
  it("turns it on with two people who can approve, as one row for the workspace, and signs the change", async () => {
    fake = fakeSupabase(workspace({ approvers: 2 }));
    const result = await run(() => changeTwoApprovals({ actorId: OWNER, value: "100" }));

    expect(result).toEqual({ from: null, to: 100 });
    expect(posted()[0].params.get("on_conflict")).toBe("org_id");
    expect(posted()[0].body).toMatchObject({ org_id: ORG, two_approvals_above: 100, updated_by: OWNER });
    const counted = fake.requests.find((r) => r.path === "/rest/v1/rpc/approvers_besides");
    expect(counted?.body).toEqual({ p_org_id: ORG, p_excluded: [] });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "approval_policy_changed",
      summary: "Payments above 100 USDC now need two approvals",
      detail: { by: OWNER, from: null, to: 100 },
    });
  });

  it("refuses turning it on, or lowering it, with fewer than two people who can approve", async () => {
    fake = fakeSupabase(workspace({ approvers: 1 }));
    const on = run(() => changeTwoApprovals({ actorId: OWNER, value: "100" }));
    await expect(on).rejects.toBeInstanceOf(ApprovalPolicyError);
    await expect(on).rejects.toThrow("Two approvals need two people who can approve payments. Add an approver on Members first.");

    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }], approvers: 1 }));
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "50" }))).rejects.toThrow(/Add an approver on Members first/);
    expect(posted()).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("lets it be raised or turned off whoever can approve", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }], approvers: 1 }));
    expect(await run(() => changeTwoApprovals({ actorId: OWNER, value: "500" }))).toEqual({ from: 100, to: 500 });
    expect(ledgerMock.mock.calls[0][1].summary).toBe("Raised the figure for two approvals from 100 USDC to 500 USDC");
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/approvers_besides")).toBe(false);

    ledgerMock.mockClear();
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }], approvers: 1 }));
    expect(await run(() => changeTwoApprovals({ actorId: OWNER, value: "" }))).toEqual({ from: 100, to: null });
    expect(posted()[0].body).toMatchObject({ two_approvals_above: null });
    expect(ledgerMock.mock.calls[0][1].summary).toBe("Turned off two approvals above 100 USDC");
  });

  it("names a lowered figure in its summary", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }], approvers: 3 }));
    await run(() => changeTwoApprovals({ actorId: OWNER, value: "40" }));
    expect(ledgerMock.mock.calls[0][1].summary).toBe("Lowered the figure for two approvals from 100 USDC to 40 USDC");
  });

  it("refuses a figure that is not one, and the figure it already has", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "ten" }))).rejects.toThrow("The figure must be a number of USDC.");
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }] }));
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "100.0" }))).rejects.toThrow("Payments above 100 USDC already need two approvals.");
    fake = fakeSupabase(workspace());
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "" }))).rejects.toThrow("Two approvals are already off.");
    expect(posted()).toHaveLength(0);
  });

  it("is refused while a cycle is running, which read the figure when it began", async () => {
    fake = fakeSupabase(workspace({ running: [{ id: "run-1" }] }));
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "100" }))).rejects.toThrow("A cycle is running. Try again in a minute, once it has finished.");
    expect(posted()).toHaveLength(0);
  });

  it("is reported as not saved when the write fails, with nothing signed", async () => {
    fake = fakeSupabase(workspace({ upsert: { status: 500, body: { message: "boom" } } }));
    await expect(run(() => changeTwoApprovals({ actorId: OWNER, value: "100" }))).rejects.toThrow("boom");
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("twoApprovalsStatus", () => {
  it("is the figure and how many people can approve payments", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "75" }], approvers: 3 }));
    expect(await run(() => twoApprovalsStatus())).toEqual({ above: 75, approvers: 3 });
  });
});

describe("who changes it", () => {
  it("is an owner alone", () => {
    expect(can("owner", "approval.policy")).toBe(true);
    for (const role of ["admin", "approver", "viewer"] as const) expect(can(role, "approval.policy")).toBe(false);
  });
});

describe("changeTwoApprovals on Arc mainnet (mainnet limits L2)", () => {
  const onMainnet = <T,>(fn: () => Promise<T>) =>
    runWith(orgTestContext({ config: { ...config, network: "arc-mainnet" }, client: fake.client, orgId: ORG, userId: OWNER }), fn);

  it("keeps a figure: turning it off is refused, and nothing is written", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }] }));
    const attempt = onMainnet(() => changeTwoApprovals({ actorId: OWNER, value: "" }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalPolicyError);
    await expect(attempt).rejects.toMatchObject({ code: "mainnet_keeps_figure", message: "A workspace on Arc mainnet keeps two approvals above a figure." });
    expect(posted()).toEqual([]);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("still raises it, and records the change", async () => {
    fake = fakeSupabase(workspace({ policy: [{ two_approvals_above: "100" }] }));
    await onMainnet(() => changeTwoApprovals({ actorId: OWNER, value: "500" }));
    expect(posted()[0].body).toMatchObject({ two_approvals_above: 500 });
    expect(ledgerMock).toHaveBeenCalledTimes(1);
  });
});
