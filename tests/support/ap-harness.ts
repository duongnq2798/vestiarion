import { vi, type Mock } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { onChainLimitGate, type OnChainLimitGate } from "@/lib/agent/onchain-limit";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { DecideParams } from "@/lib/agent/decide";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { MAY_HAVE_BEEN_ACCEPTED } from "@/lib/circle/settlement";
import { ARC_TESTNET } from "@/lib/network";
import type { NewPayeeFacts } from "@/lib/new-payee-facts";
import { fakeSupabase, type RecordedRequest } from "./fake-supabase";
import { paymentIntentsBackend } from "./payment-intents";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./signed-org";

/**
 * The AP stage as production runs it, over fakes, for a test that drives whole scenarios through it: the Quality Lab
 * (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL1). Built from tests/ap-stage.test.ts's `apFake`, `model()`
 * and `Chain`, which that file and its copies keep as they are.
 *
 * What runs for real: `runApStage` and everything after the model, the load, duplicate detection, the timing policy, the
 * guardrails, the checks after them, the pause, `payInvoice` and `executePayment` over the shared `payment_intents`
 * table, the invoice write, and a ledger entry really signed with the organization's key (`signedOrgs`). What is faked:
 * PostgREST (`fakeSupabase`), the clock (`today`, `Date` only, so promises and fetches still run), the chain provider
 * (`LabChain`, which counts what it took), and the model, which the test file stubs with `vi.mock` and scripts here
 * (`scriptModel`). Two inputs are handed in rather than read: the spending limit contract's answer on Arc (`onChainLimit`,
 * whose verdict the test scripts, so `spendingLimitVerdict` never asks Arc; with none, no contract is enforced, as for a
 * workspace without one), and the new payee facts (`newPayee`), so `loadNewPayeeFacts` does not run while the check on
 * them does. The book is written back: what one cycle wrote, the next one reads.
 *
 * Call `apHarness()` at the top of a test file, so the signing hooks register there.
 */

export const LAB_ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c1c1";
export const LAB_ACCOUNT = "018f8ce0-1557-7b54-a931-4d777f6bc005";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

/** Sets the clock to `iso` for `Date` only: timers, promises and fetches still run. */
export function today(iso: string) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

/**
 * A model that answers `answer(params)`, parsed by the real schema as `decide` parses a reply, with the written
 * policy's answer recorded beside it: `decide` stubbed this way is the only part of the decision that is not the code's.
 */
export function scriptModel(decide: Mock, answer: (params: DecideParams<unknown>) => unknown) {
  decide.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse(answer(params)) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

/** What a provider answers for a transfer it took. */
function taken(count: number): TransferResult {
  return {
    providerTxId: `circle-tx-${count}`, txHash: `0xlab${count}`, txRef: `0xlab${count}`, chain: "ARC-TESTNET", status: "confirmed",
    feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
  };
}

/**
 * A live chain provider that counts money moved: `asked` is every transfer the code asked for, `sent` every one it
 * took. Each send it takes is a transfer, whatever its key: unlike Circle, it never merges a second send under the same
 * key into the first, so a second send for one bill counts as a second payment. `lostAnswer` loses the answer to the
 * first send, as a timeout or a 5xx does, after the provider took it or before; the lookup by reference
 * (`findTransferByRef`) then finds only what it took.
 */
export class LabChain implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  readonly asked: TransferParams[] = [];
  readonly sent: TransferParams[] = [];
  private readonly results = new Map<string, TransferResult>();

  constructor(private readonly lostAnswer: "after_taking" | "before_taking" | null = null) {}

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.asked.push(params);
    const lost = this.lostAnswer !== null && this.asked.length === 1;
    const timedOut = new Error(`Circle did not answer within 20000 ms; the transfer ${MAY_HAVE_BEEN_ACCEPTED}`);
    if (lost && this.lostAnswer === "before_taking") throw timedOut;
    this.sent.push(params);
    const result = taken(this.sent.length);
    this.results.set(params.memo ?? params.idempotencyKey, result);
    if (lost) throw timedOut;
    return result;
  }

  async findTransferByRef(_fromAccountId: string, refId: string): Promise<TransferResult | null> {
    return this.results.get(refId) ?? null;
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    const found = [...this.results.values()].find((result) => result.providerTxId === providerTxId);
    if (!found) throw new Error(`no transfer ${providerTxId}`);
    return found;
  }

  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

export interface ApWorldOptions {
  /** The whole payable book, each row with its `counterparties` row nested, as the stage's load selects it. */
  book: Array<Record<string, unknown>>;
  paused?: boolean;
  /** Milestone rows: verified ones count among what falls due, and a bill naming one's purchase order repeats it. */
  milestones?: Array<Record<string, unknown>>;
  /** The agent's spending limit row (outflow budget spec); none when absent. */
  budget?: { daily_usdc: string | null; weekly_usdc: string | null };
  /** The spending limit enforced on Arc, as the stage sees it; not enforced when absent. */
  onChainLimit?: OnChainLimitGate;
  /** The new payee facts of a live workspace; unchecked when absent. */
  newPayee?: NewPayeeFacts;
  /** The figure above which a payment needs two approvals; none when absent. */
  twoApprovals?: number;
  /** The payee lock; off when absent. */
  payeeLock?: { on: boolean; hours?: number };
  /** The business's currency, when the workspace is in shadow mode; off when absent. */
  shadow?: string;
  /** The bills whose purchase order a vendor's document wrote, as the stage's read of `document_requests` finds them. */
  vendorDocuments?: string[];
  chain?: LabChain;
}

/** A PostgREST filter value `eq.x`, `is.null` or `in.(a,b)` as a test on one column's value. */
function matchesFilter(value: unknown, filter: string): boolean {
  if (filter === "is.null") return value === null || value === undefined;
  if (filter.startsWith("eq.")) return String(value) === filter.slice(3);
  const list = /^in\.\((.*)\)$/.exec(filter)?.[1];
  if (list !== undefined) return list.split(",").includes(String(value));
  return true;
}

/** Rows sorted as PostgREST sorts them for `order=col.asc,col2.desc`; left in the book's order when none is named. */
function orderedAs(rows: Array<Record<string, unknown>>, order: string | null): Array<Record<string, unknown>> {
  if (!order) return rows;
  const keys = order.split(",").map((term) => {
    const [column, direction] = term.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { column, sign } of keys) {
      const left = String(a[column] ?? "");
      const right = String(b[column] ?? "");
      if (left !== right) return left < right ? -sign : sign;
    }
    return 0;
  });
}

const INVOICE_FILTERS = ["id", "status", "direction"];

/** Sets up signing for the test file, and builds worlds the AP stage runs in. */
export function apHarness() {
  const { orgRow } = signedOrgs();

  /** One workspace: its fake database and provider, and `stage()` to run the AP stage once over them. */
  function world(options: ApWorldOptions) {
    const intents = paymentIntentsBackend(LAB_ORG);
    const book = options.book;
    const fake = fakeSupabase((request) => {
      const { path, method, params } = request;
      if (path === "/rest/v1/orgs") return { body: orgRow(LAB_ORG) };
      if (path === "/rest/v1/agent_budgets") return { body: options.budget ? [options.budget] : [] };
      if (path === "/rest/v1/approval_policies") {
        if (!options.twoApprovals && !options.payeeLock) return { body: [] };
        return {
          body: [
            {
              two_approvals_above: options.twoApprovals ? String(options.twoApprovals) : null,
              payee_lock: options.payeeLock?.on ?? false,
              payee_lock_cooling_hours: options.payeeLock?.hours ?? 0,
            },
          ],
        };
      }
      if (path === "/rest/v1/shadow_modes") return { body: options.shadow ? [{ currency: options.shadow, started_at: "2026-09-01T00:00:00Z", started_by: null }] : [] };
      // The spending limit's read of what the agent paid lately: nothing before this world.
      if (path === "/rest/v1/ledger_entries" && method === "GET") return { body: [] };
      if (path === "/rest/v1/rpc/append_ledger_entry") return { body: { ...APPENDED_LEDGER_ROW, actor: "agent", domain: "ap" } };
      if (path === "/rest/v1/rpc/agent_paused") return { body: options.paused ?? false };
      // The marker 0144's check_document_request writes on a bill whose purchase order a vendor's document wrote (DK8).
      if (path === "/rest/v1/document_requests" && method === "GET") {
        const asked = /^in\.\((.*)\)$/.exec(params.get("invoice_id") ?? "")?.[1].split(",") ?? [];
        if (params.get("po_written") !== "eq.true") return { body: [] };
        const written = (options.vendorDocuments ?? []).filter((id) => asked.includes(id));
        return { body: written.map((id, index) => ({ id: `document-request-${index + 1}`, invoice_id: id, source: "vendor", file_sha256: "ab".repeat(32) })) };
      }
      if (path === "/rest/v1/invoices" && method === "GET") {
        const rows = book.filter((row) => INVOICE_FILTERS.every((column) => !params.has(column) || matchesFilter(row[column], params.get(column)!)));
        return { body: orderedAs(rows, params.get("order")) };
      }
      // Every write lands in the book where its filters match, as PostgREST applies it, and answers with the rows it wrote.
      if (path === "/rest/v1/invoices" && method === "PATCH") {
        const rows = book.filter((row) => INVOICE_FILTERS.every((column) => !params.has(column) || matchesFilter(row[column], params.get(column)!)));
        for (const row of rows) Object.assign(row, request.body as Record<string, unknown>);
        return { body: rows.map((row) => ({ id: row.id })) };
      }
      if (path === "/rest/v1/milestones") {
        const status = params.get("status");
        return { body: (options.milestones ?? []).filter((row) => !status || matchesFilter(row.status, status)) };
      }
      if (path === "/rest/v1/accounts" && method === "GET") return { body: { id: LAB_ACCOUNT, chain: "ARC-TESTNET", token: "USDC", balance: "5000", apy: "0" } };
      return intents.respond(request);
    });
    const chain = options.chain ?? new LabChain();
    const metrics = new CycleMetricsCollector();
    const lines: CycleLogLine[] = [];
    const stage = (operatingBalance = 5000) =>
      runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
        withOrg(LAB_ORG, () =>
          runApStage({
            db: db(),
            provider: chain,
            operating: { id: LAB_ACCOUNT },
            operatingBalance,
            reserveApy: 0.045,
            reserveBalance: 0,
            metrics,
            lines,
            onChainLimit: options.onChainLimit ?? onChainLimitGate({ read: async () => null }),
            ...(options.newPayee ? { newPayee: { load: async () => options.newPayee! } } : {}),
          })
        )
      );
    return { fake, chain, intents, metrics, lines, stage, book };
  }

  return { world };
}

/** The ledger entries a run appended, as `append_ledger_entry` was called. */
export function ledgerEntries(requests: RecordedRequest[]): Array<{ action: string; detail: Record<string, unknown> }> {
  return requests
    .filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry")
    .map((r) => {
      const body = r.body as { p_action: string; p_detail: Record<string, unknown> };
      return { action: body.p_action, detail: body.p_detail };
    });
}

/** The writes to one invoice, in order. */
export function invoiceWrites(requests: RecordedRequest[], invoiceId: string): Array<Record<string, unknown>> {
  return requests
    .filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH" && r.params.get("id") === `eq.${invoiceId}`)
    .map((r) => r.body as Record<string, unknown>);
}
