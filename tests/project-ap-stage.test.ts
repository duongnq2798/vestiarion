import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { onChainLimitGate } from "@/lib/agent/onchain-limit";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { ARC_TESTNET } from "@/lib/network";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP stage with projects (docs/superpowers/specs/2026-10-13-project-budgets-design.md P5, P9), run for real over a
 * recorded fake: the agent's own rule-based policy decides (no model key), the guardrails run, then the checks after
 * them, then `payInvoice` over the shared `payment_intents` table, with a fake chain whose transfers are counted. The
 * database's reservation is played by a small budget below, which answers as `reserve_project_budget` does.
 *
 * What it shows: a bill in no project is never asked about; a payment another check stopped is left as it was; a
 * project that cannot hold a bill holds it for a person and nothing is sent; the same purchase order as an earlier
 * milestone holds the bill; and the budget never lets the agent pay past the cash it has: a bill the cash cannot cover
 * still waits, as it did before projects.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b1b1";
const NORTHWIND = "018f8ce0-1557-7b54-a931-4d777f6bb003";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bb005";
const PROJECT = "018f8ce0-1557-7b54-a931-4d777f6bb0aa";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;

beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-13T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

function orgRow() {
  return {
    id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null, circle_entity_secret_enc: null,
  };
}

/** A correct bill due today, with no terms: the policy pays it now when the cash covers it. */
function bill(id: string, amount: string, overrides: Record<string, unknown> = {}) {
  return {
    id, direction: "payable", status: "pending", amount, memo: `Work order ${id.slice(-3)}`, po_reference: `PO-${id.slice(-3)}`,
    goods_received: true, due_date: "2026-10-13T12:00:00+00:00", counterparty_id: NORTHWIND, currency: "USDC",
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, created_at: "2026-10-12T09:00:00Z", project_id: PROJECT,
    counterparties: {
      id: NORTHWIND, name: "Northwind", role: "vendor", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: "0xnorth", address_changed_at: null, address_confirmed_at: null,
    },
    ...overrides,
  };
}

class Chain implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: `circle-tx-${this.transfers.length}`, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/**
 * `reserve_project_budget` as migration 0111 answers it, over one project: a bill's money is set aside only when the
 * budget, less its buffer, less what is set aside, holds it. `fail` answers every call with an error instead.
 */
function budget(budgetMinor: number, options: { fail?: boolean } = {}) {
  const reserved = new Map<string, number>();
  return {
    reserved,
    respond(request: RecordedRequest, book: Array<Record<string, unknown>>) {
      if (options.fail) return { status: 500, body: { code: "XX000", message: "connection reset" } };
      const { p_invoice_id: invoiceId } = request.body as { p_invoice_id: string };
      const row = book.find((entry) => entry.id === invoiceId);
      if (!row?.project_id) return { body: { state: "no_project" } };
      const needed = Math.round(Number(row.amount) * 100);
      const held = [...reserved.values()].reduce((sum, minor) => sum + minor, 0);
      const figures = { projectId: PROJECT, projectName: "Website rebuild", neededMinor: needed, budgetMinor, bufferMinor: 0, reservedMinor: held, paidMinor: 0, availableMinor: budgetMinor - held };
      if (reserved.has(invoiceId)) return { body: { state: "reserved", already: true, reservationId: `r-${invoiceId}`, ...figures } };
      if (needed > budgetMinor - held) return { body: { state: "over", ...figures } };
      reserved.set(invoiceId, needed);
      return { body: { state: "reserved", already: false, reservationId: `r-${invoiceId}`, ...figures } };
    },
  };
}

function stageOver(options: { book: Array<Record<string, unknown>>; reserve?: ReturnType<typeof budget>; milestones?: Array<Record<string, unknown>>; twoApprovals?: number }) {
  const intents = paymentIntentsBackend(ORG);
  const reserve = options.reserve ?? budget(1_000_000);
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/approval_policies") return { body: options.twoApprovals ? [{ two_approvals_above: String(options.twoApprovals) }] : [] };
    if (["/rest/v1/agent_budgets", "/rest/v1/shadow_modes"].includes(request.path)) return { body: [] };
    if (request.path === "/rest/v1/ledger_entries" && request.method === "GET" && request.params.has("actor")) return { body: [] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (request.path === "/rest/v1/rpc/reserve_project_budget") return reserve.respond(request, options.book);
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
      return { body: statuses ? options.book.filter((row) => statuses.includes(row.status as string)) : options.book };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    // The milestones a bill may repeat (they carry a purchase order), and the verified ones falling due today.
    if (request.path === "/rest/v1/milestones") return { body: request.params.get("select")?.includes("po_reference") ? (options.milestones ?? []) : [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "1000", apy: "0" } };
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
    return intents.respond(request);
  });
  const chain = new Chain();
  const lines: CycleLogLine[] = [];
  const run = (operatingBalance: number) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(),
          provider: chain,
          operating: { id: ACCOUNT_ID },
          operatingBalance,
          reserveApy: 0,
          reserveBalance: 0,
          metrics: new CycleMetricsCollector(),
          lines,
          onChainLimit: onChainLimitGate({ read: async () => null }),
        })
      )
    );
  return { fake, chain, reserve, run };
}

const entries = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => (r.body as { p_detail: Record<string, unknown> }).p_detail);
const reserveCalls = (requests: RecordedRequest[]) => requests.filter((r) => r.path === "/rest/v1/rpc/reserve_project_budget");

describe("the AP stage and a project's budget", () => {
  it("sets a bill's money aside before paying it, and records the project's figures", async () => {
    const { fake, chain, run } = stageOver({ book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400")] });
    await run(1000);
    expect(chain.transfers).toHaveLength(1);
    expect(reserveCalls(fake.requests)).toHaveLength(1);
    expect(reserveCalls(fake.requests)[0].body).toMatchObject({ p_invoice_id: "018f8ce0-1557-7b54-a931-4d777f6bb101", p_milestone_id: null, p_via: "agent", p_by: null, p_org_id: ORG });
    const [entry] = entries(fake.requests);
    expect(entry).toMatchObject({ guardrailBlocked: false, guardrailRule: null, observed: { projectId: PROJECT, project: { id: PROJECT, state: "reserved", neededMinor: 40_000 } } });
  });

  it("holds the bill its project cannot hold for a person, and sends nothing for it", async () => {
    const first = "018f8ce0-1557-7b54-a931-4d777f6bb101";
    const second = "018f8ce0-1557-7b54-a931-4d777f6bb102";
    const { fake, chain, run } = stageOver({ book: [bill(first, "400"), bill(second, "350", { created_at: "2026-10-12T10:00:00Z" })], reserve: budget(50_000) });
    await run(1000);
    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0]).toMatchObject({ amount: 400 });
    const [paid, held] = entries(fake.requests);
    expect(paid).toMatchObject({ guardrailRule: null, execution: { resultingStatus: "paid" } });
    expect(held).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "project.budget_exceeded",
      execution: { resultingStatus: "held", heldBecause: "project_budget" },
      observed: { project: { state: "over", neededMinor: 35_000, availableMinor: 10_000 } },
    });
    expect(String((held.decision as { reasoning: string }).reasoning)).not.toContain("guardrail override");
    const patches = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");
    expect(patches[1].body).toMatchObject({ status: "held" });
    expect(String((patches[1].body as { agent_reasoning: string }).agent_reasoning)).toContain('project "Website rebuild" has 100.00 USDC of its 500.00 USDC budget left to set aside');
  });

  it("never asks about a bill in no project, and pays it as before", async () => {
    const { fake, chain, run } = stageOver({ book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400", { project_id: null })] });
    await run(1000);
    expect(chain.transfers).toHaveLength(1);
    expect(reserveCalls(fake.requests)).toHaveLength(0);
    expect(entries(fake.requests)[0]).not.toHaveProperty("observed.projectId");
  });

  it("leaves a payment another check stopped as it was, and asks the project nothing", async () => {
    // The policy decides to pay; two approvals above 100 USDC stop it in code, before the project is asked.
    const { fake, chain, run } = stageOver({ book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400")], reserve: budget(0), twoApprovals: 100 });
    await run(1000);
    expect(chain.transfers).toHaveLength(0);
    expect(reserveCalls(fake.requests)).toHaveLength(0);
    expect(entries(fake.requests)[0]).toMatchObject({ decision: { action: "pay" }, guardrailBlocked: true, guardrailRule: "workspace.two_approvals" });
    expect(entries(fake.requests)[0]).not.toHaveProperty("observed.project");
  });

  it("holds a bill whose project could not be read, rather than pay past a budget no one could check", async () => {
    const { fake, chain, run } = stageOver({ book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400")], reserve: budget(1_000_000, { fail: true }) });
    await run(1000);
    expect(chain.transfers).toHaveLength(0);
    expect(entries(fake.requests)[0]).toMatchObject({ guardrailRule: "project.budget_exceeded", observed: { project: { state: "unreadable" } }, execution: { resultingStatus: "held" } });
    expect(entries(fake.requests)[0]).not.toHaveProperty("execution.heldBecause");
  });

  it("still holds a bill the cash cannot cover, whatever its project's budget holds", async () => {
    const { fake, chain, reserve, run } = stageOver({ book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400")], reserve: budget(1_000_000) });
    // The budget holds it; the cash, 300 USDC, does not.
    await run(300);
    expect(chain.transfers).toHaveLength(0);
    expect(entries(fake.requests)[0]).toMatchObject({ decision: { action: "hold" }, guardrailRule: null, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } });
    // A hold sets nothing aside: the budget was never asked.
    expect(reserve.reserved.size).toBe(0);
    expect(reserveCalls(fake.requests)).toHaveLength(0);
  });
});

describe("the AP stage and the same work as a milestone", () => {
  it("holds a bill for the purchase order an earlier milestone already names, and sets nothing aside for it", async () => {
    const { fake, chain, run } = stageOver({
      book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400", { po_reference: "PO-1042" })],
      milestones: [{ id: "m1", contractor_id: NORTHWIND, title: "Design phase", status: "verified", created_at: "2026-10-01T00:00:00Z", verification_source: null, po_reference: "po 1042" }],
    });
    await run(1000);
    expect(chain.transfers).toHaveLength(0);
    expect(reserveCalls(fake.requests)).toHaveLength(0);
    expect(entries(fake.requests)[0]).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "obligation.duplicate_reference",
      execution: { resultingStatus: "held" },
      observed: { sameWork: [{ otherKind: "milestone", otherId: "m1", signal: "purchase_order" }] },
    });
  });

  it("pays the first of the two as usual: a milestone entered after the bill holds nothing", async () => {
    const { chain, run } = stageOver({
      book: [bill("018f8ce0-1557-7b54-a931-4d777f6bb101", "400", { po_reference: "PO-1042", project_id: null })],
      milestones: [{ id: "m1", contractor_id: NORTHWIND, title: "Design phase", status: "verified", created_at: "2026-10-12T12:00:00Z", verification_source: null, po_reference: "PO-1042" }],
    });
    await run(1000);
    expect(chain.transfers).toHaveLength(1);
  });
});
