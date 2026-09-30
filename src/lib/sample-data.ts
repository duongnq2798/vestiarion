import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { RECLAIM_AFTER_MS } from "./agent/approvals";
import { currentOrgId } from "./context";
import { db, platformDb, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Sample data (docs/superpowers/specs/2026-09-30-sample-data-design.md): one
 * click fills a simulated sandbox with example counterparties, invoices and
 * milestones chosen so that one cycle shows every outcome, and a second click
 * removes exactly those rows. Every export that touches the database runs
 * inside an organization scope.
 *
 * Only counterparties carry the `sample` mark (S2): an invoice or milestone is
 * sample because its counterparty is, and leaves with it through the
 * `on delete cascade` the tables already have. Payment intents name their
 * invoice or milestone without a foreign key, so removal deletes them first.
 *
 * Sample data lives only where payments are simulated (S1). A sample
 * counterparty has no address, and a workspace that holds Circle credentials
 * pays for real whatever its mode, so loading is refused unless the workspace
 * is a sandbox that has neither connected Circle nor chosen a hosted wallet,
 * and go-live refuses to connect while sample data exists (`hasSampleData`).
 */

export type SampleDataErrorCode = "not_sandbox" | "connected" | "already_loaded" | "not_loaded" | "cycle_running" | "payment_in_flight";

const MESSAGES: Record<SampleDataErrorCode, string> = {
  not_sandbox: "Sample data can only be loaded into a sandbox workspace.",
  connected: "This workspace pays through Circle, so it cannot hold sample data: sample data is only for trying the agent with simulated payments.",
  already_loaded: "Sample data is already loaded.",
  not_loaded: "There is no sample data to remove.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  payment_in_flight: "A payment to a sample counterparty is still being sent. Try again in a minute.",
};

export class SampleDataError extends Error {
  constructor(readonly code: SampleDataErrorCode) {
    super(MESSAGES[code]);
    this.name = "SampleDataError";
  }
}

export type SampleKey = "northwind" | "harbor" | "kestrel" | "lumen" | "pinecrest" | "marlow";

export interface SampleFixture {
  counterparties: Array<{ key: SampleKey; name: string; role: "vendor" | "client" | "contractor"; limit: number | null }>;
  invoices: Array<{
    counterparty: SampleKey;
    direction: "payable" | "receivable";
    amount: number;
    memo: string;
    po_reference: string | null;
    goods_received: boolean;
    due_date: string;
    early_pay_discount_pct?: number;
    discount_due_date?: string;
    status?: "paid";
    decided_at?: string;
    settled_at?: string;
    agent_reasoning?: string;
  }>;
  milestones: Array<{
    contractor: SampleKey;
    title: string;
    amount: number;
    verification_source: string;
    verified: boolean;
    status: "verified" | "pending";
    verification_method: "seed";
    verification_status: "verified" | "unverified";
    verified_at?: string;
    verification_detail: { sample: true };
  }>;
}

export interface SampleDataCounts {
  counterparties: number;
  invoices: number;
  milestones: number;
}

const DAY_MS = 86_400_000;

/**
 * The rows to insert, dated from `now` (spec §3). Every outcome follows from
 * the invoice facts and the limits alone, never from the watchlist, so the
 * sample behaves the same whether screening is bundled or OpenSanctions (S6).
 * Amounts fit inside the 10,000 simulated USDC every new sandbox starts with.
 */
export function sampleFixture(now: Date): SampleFixture {
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString();
  return {
    counterparties: [
      { key: "northwind", name: "Northwind Hosting", role: "vendor", limit: 2000 },
      { key: "harbor", name: "Harbor Office Supply", role: "vendor", limit: 500 },
      { key: "kestrel", name: "Kestrel Print Co", role: "vendor", limit: 1500 },
      { key: "lumen", name: "Lumen Retail Co", role: "client", limit: null },
      { key: "pinecrest", name: "Pinecrest Engineering — Backend Contractor", role: "contractor", limit: 5000 },
      { key: "marlow", name: "Marlow Design Studio — Design Contractor", role: "contractor", limit: 2500 },
    ],
    invoices: [
      // Paid: a full three-way match, well under the limit, due today.
      { counterparty: "northwind", direction: "payable", amount: 240, memo: "Hosting — September", po_reference: "PO-1042", goods_received: true, due_date: at(0) },
      // Awaiting information: no purchase order and nothing received.
      { counterparty: "northwind", direction: "payable", amount: 95, memo: "Bandwidth overage", po_reference: null, goods_received: false, due_date: at(4) },
      // Scheduled: 2/10 net 30. The discount is worth more than the yield on
      // the cash kept until the due date, so the agent pays on the deadline.
      {
        counterparty: "northwind",
        direction: "payable",
        amount: 400,
        memo: "Annual support plan",
        po_reference: "PO-1044",
        goods_received: true,
        due_date: at(30),
        early_pay_discount_pct: 2,
        discount_due_date: at(10),
      },
      // Held: a clean invoice over Harbor's 500 USDC limit.
      { counterparty: "harbor", direction: "payable", amount: 1200, memo: "Standing desks", po_reference: "PO-2210", goods_received: true, due_date: at(6) },
      // History for the next row: already paid, last month.
      {
        counterparty: "kestrel",
        direction: "payable",
        amount: 180,
        memo: "Brochure print run",
        po_reference: "PO-3307",
        goods_received: true,
        due_date: at(-20),
        status: "paid",
        decided_at: at(-21),
        settled_at: at(-20),
        agent_reasoning: "Sample history: paid last month against PO-3307.",
      },
      // Flagged: the same purchase order and amount as the paid invoice above.
      { counterparty: "kestrel", direction: "payable", amount: 180, memo: "Brochure print run", po_reference: "PO-3307", goods_received: true, due_date: at(2) },
      // Money coming in, for the forecast.
      { counterparty: "lumen", direction: "receivable", amount: 3000, memo: "Q4 platform retainer", po_reference: "SO-771", goods_received: true, due_date: at(10) },
    ],
    milestones: [
      {
        contractor: "pinecrest",
        title: "API rate-limiting module shipped",
        amount: 1200,
        verification_source: "timesheet:kimai",
        verified: true,
        status: "verified",
        verification_method: "seed",
        verification_status: "verified",
        verified_at: at(0),
        verification_detail: { sample: true },
      },
      {
        contractor: "marlow",
        title: "Landing page redesign — milestone 2",
        amount: 900,
        verification_source: "timesheet:kimai",
        verified: false,
        status: "pending",
        verification_method: "seed",
        verification_status: "unverified",
        verification_detail: { sample: true },
      },
    ],
  };
}

async function requireSimulatedSandbox(orgId: string): Promise<void> {
  const org = unwrap(
    await platformDb().from("orgs").select("mode, wallet_host, api_key_iv:circle_api_key_enc->>iv").eq("id", orgId).single()
  ) as { mode: "sandbox" | "live"; wallet_host: "own" | "hosted" | null; api_key_iv: string | null };
  if (org.mode !== "sandbox") throw new SampleDataError("not_sandbox");
  if (org.wallet_host !== null || org.api_key_iv !== null) throw new SampleDataError("connected");
}

function isSampleSetClash(error: { code?: string; message: string }): boolean {
  return error.code === "23505" && error.message.includes("counterparties_one_sample_set");
}

export async function loadSampleData(input: { actorId: string; now?: Date }): Promise<SampleDataCounts> {
  const orgId = currentOrgId();
  await requireSimulatedSandbox(orgId);
  const fixture = sampleFixture(input.now ?? new Date());

  // Every insert here passes `defaultToNull: false`: a bulk insert names the union
  // of its rows' keys, and without it a key one row leaves out is written as NULL
  // rather than the column's default (only the paid history row sets `status`).
  //
  // One statement, so the counterparties arrive together or not at all (S3).
  const inserted = await db()
    .from("counterparties")
    .insert(
      fixture.counterparties.map((row) => ({
        name: row.name,
        role: row.role,
        chain: "ARC-TESTNET",
        payment_limit: row.limit,
        baseline_payment_limit: row.limit,
        sample: true,
      })),
      { defaultToNull: false }
    )
    .select("id, name");
  if (inserted.error) {
    if (isSampleSetClash(inserted.error)) throw new SampleDataError("already_loaded");
    throw new Error(inserted.error.message);
  }
  const rows = inserted.data as Array<{ id: string; name: string }>;
  const idOf = (key: SampleKey): string => {
    const name = fixture.counterparties.find((row) => row.key === key)?.name;
    const match = rows.find((row) => row.name === name);
    if (!match) throw new Error(`sample data: no counterparty inserted for ${key}`);
    return match.id;
  };

  try {
    const invoices = await db()
      .from("invoices")
      .insert(
        fixture.invoices.map(({ counterparty, ...invoice }) => ({ ...invoice, counterparty_id: idOf(counterparty) })),
        { defaultToNull: false }
      );
    if (invoices.error) throw new Error(invoices.error.message);
    const milestones = await db()
      .from("milestones")
      .insert(
        fixture.milestones.map(({ contractor, ...milestone }) => ({ ...milestone, contractor_id: idOf(contractor) })),
        { defaultToNull: false }
      );
    if (milestones.error) throw new Error(milestones.error.message);
  } catch (error) {
    // Half a sample would block the next load on the index while showing no outcomes;
    // taking the counterparties back (their cascades take anything inserted) leaves nothing behind.
    const cleanup = await db().from("counterparties").delete().in("id", rows.map((row) => row.id));
    if (cleanup.error) console.error("sample data: cleanup after a failed load failed", orgId, cleanup.error.message);
    throw error;
  }

  const counts: SampleDataCounts = {
    counterparties: rows.length,
    invoices: fixture.invoices.length,
    milestones: fixture.milestones.length,
  };
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "sample_data_loaded",
    summary: `Sample data loaded: ${counts.counterparties} counterparties, ${counts.invoices} invoices and ${counts.milestones} milestones`,
    detail: { by: input.actorId, ...counts },
  });
  return counts;
}

export async function removeSampleData(input: { actorId: string }): Promise<SampleDataCounts & { paymentIntents: number }> {
  const orgId = currentOrgId();
  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new SampleDataError("cycle_running");

  const counterparties = unwrap(await db().from("counterparties").select("id").eq("sample", true)) as Array<{ id: string }>;
  if (counterparties.length === 0) throw new SampleDataError("not_loaded");
  const counterpartyIds = counterparties.map((row) => row.id);

  const invoices = unwrap(
    await db().from("invoices").select("id, status, reviewed_at").in("counterparty_id", counterpartyIds)
  ) as Array<{ id: string; status: string; reviewed_at: string | null }>;
  // Approve-and-pay (src/lib/agent/approvals.ts) claims an invoice — status "processing", reviewed_at set —
  // before it inserts the payment intent; a removal in that window must not delete the invoice out from
  // under it. A stale claim (RECLAIM_AFTER_MS old, or missing reviewed_at) is not a claim, so it never blocks.
  const now = Date.now();
  const claimedInvoice = invoices.find((invoice) => {
    if (invoice.status !== "processing") return false;
    if (invoice.reviewed_at === null) return false;
    const claimedAt = Date.parse(invoice.reviewed_at);
    return !Number.isNaN(claimedAt) && claimedAt >= now - RECLAIM_AFTER_MS;
  });
  if (claimedInvoice) throw new SampleDataError("payment_in_flight");

  const milestones = unwrap(await db().from("milestones").select("id").in("contractor_id", counterpartyIds)) as Array<{ id: string }>;
  const sources = [...invoices, ...milestones].map((row) => row.id);

  const intents =
    sources.length === 0
      ? []
      : (unwrap(await db().from("payment_intents").select("id, status").in("source_id", sources)) as Array<{ id: string; status: string }>);
  if (intents.some((intent) => intent.status === "submitting" || intent.status === "pending")) {
    throw new SampleDataError("payment_in_flight");
  }
  if (intents.length > 0) {
    const deleted = await db().from("payment_intents").delete().in("id", intents.map((intent) => intent.id));
    if (deleted.error) throw new Error(deleted.error.message);
  }

  const removed = unwrap(await db().from("counterparties").delete().eq("sample", true).select("id")) as Array<{ id: string }>;
  const result = {
    counterparties: removed.length,
    invoices: invoices.length,
    milestones: milestones.length,
    paymentIntents: intents.length,
  };
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "sample_data_removed",
    summary: `Sample data removed: ${result.counterparties} counterparties, with ${result.invoices} invoices and ${result.milestones} milestones`,
    detail: { by: input.actorId, ...result },
  });
  return result;
}

/** Whether any sample counterparty exists in the workspace in scope. */
export async function hasSampleData(): Promise<boolean> {
  const rows = unwrap(await db().from("counterparties").select("id").eq("sample", true).limit(1)) as Array<{ id: string }>;
  return rows.length > 0;
}
