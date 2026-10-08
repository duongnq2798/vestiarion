import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { cashOutlook } from "./cash-outlook";
import { getChainProvider } from "./circle";
import { sendToCircle } from "./circle/liveProvider";
import { circleCall } from "./circle/provision";
import { awaitSettlement, FAILED_STATES } from "./circle/settlement";
import { stablecoinEntry } from "./circle/stablecoins";
import type { VestiarionConfig } from "./config";
import { currentOrgConfig, currentOrgId, currentShadowFloat } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntry, assertLedgerCanSign } from "./ledger";
import { txUrl } from "./payee-chains";
import { assertPaymentsEnabled } from "./payments-switch";
import { listAccounts, listInvoices, listMilestones } from "./queries";
import { readShadowMode } from "./shadow-mode";
import { DEFAULT_WEEKLY_LIMIT, takenInWindow, testUsdcAmount, testUsdcKey, WEEK_MS, type GrantEntry } from "./test-usdc-rules";
import { workspaceNetwork } from "./workspace-network";

/**
 * Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md). A workspace in shadow mode
 * pays each bill a person agrees to in USDC on Arc testnet, at the bill's real amount, so its operating wallet needs
 * that USDC first; Circle's faucet gives 20 every two hours. Vestiarion keeps a float of test USDC in a wallet of its
 * own, in the hosted Circle account, and a workspace takes from it what its open bills need: minus safe to spend, at
 * least 1 USDC, within its weekly limit and the float's USDC.
 *
 * Circle is the record of what the float sent the workspace (review fixes A, B): its list of the float's transfers to
 * the operating wallet decides the week's total and the transfer's idempotency key, so two presses that listed the
 * same transfers send one; nothing is sent while one is still confirming; and a confirmed transfer the ledger never
 * recorded (a request that died between Circle and the ledger) is recorded first, from Circle's own figures. One signed
 * `test_usdc_added` entry per transfer. Runs inside an organization scope; who may ask for it (`records.write`) is the
 * caller's check.
 */

export type TestUsdcErrorCode =
  | "not_in_shadow"
  | "mainnet"
  | "not_live"
  | "unavailable"
  | "in_flight"
  | "nothing_needed"
  | "limit_reached"
  | "float_empty";

const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

function message(code: TestUsdcErrorCode, weeklyLimit: number): string {
  switch (code) {
    case "not_in_shadow":
      return "Test USDC is for shadow mode. An owner turns it on in Settings.";
    case "mainnet":
      return "Test USDC is for Arc testnet. On Arc mainnet the agent pays your real bills.";
    case "not_live":
      return "Go live on Arc testnet first: test USDC goes to the operating wallet.";
    case "unavailable":
      return "Vestiarion's test USDC float is not set up on this deployment.";
    case "in_flight":
      return "Arc testnet is still confirming the last test USDC. Try again in a minute.";
    case "nothing_needed":
      return "Nothing to add: the operating wallet covers your open bills.";
    case "limit_reached":
      return `This workspace took its ${usdc(weeklyLimit)} test USDC for this week.`;
    case "float_empty":
      return "Vestiarion's test USDC float is empty just now.";
  }
}

export class TestUsdcError extends Error {
  constructor(
    readonly code: TestUsdcErrorCode,
    weeklyLimit: number = DEFAULT_WEEKLY_LIMIT
  ) {
    super(message(code, weeklyLimit));
    this.name = "TestUsdcError";
  }
}

export type FloatClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "createTransaction" | "getTransaction" | "getWalletTokenBalance" | "getWallet" | "listTransactions"
>;
export type FloatClientFactory = (credentials: { apiKey: string; entitySecret: string }) => FloatClient;
const defaultFloatClient: FloatClientFactory = (credentials) => initiateDeveloperControlledWalletsClient(credentials);

/** Whether this deployment offers test USDC: a float wallet, and the hosted account it lives in. */
export function testUsdcAvailable(config: VestiarionConfig = currentOrgConfig()): boolean {
  return Boolean(config.shadowFloat?.walletId && config.chain.hostedAvailable);
}

const weeklyLimitOf = (config: VestiarionConfig) => config.shadowFloat?.weeklyLimit ?? DEFAULT_WEEKLY_LIMIT;
const sameAddress = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The float's address, by wallet id: it never changes, so it is read once per process. */
const floatAddresses = new Map<string, string>();

/**
 * The address of Vestiarion's float, read with the hosted pair, or null: when the float is not set up, or the read
 * failed. It never throws, so the receipts stage that asks for it is never stopped by it, and a failed read is not
 * kept, so the next asks again.
 */
export async function floatAddress(deps: { circle?: FloatClientFactory } = {}): Promise<string | null> {
  try {
    const { walletId, apiKey, entitySecret } = currentShadowFloat();
    if (!walletId || !apiKey || !entitySecret) return null;
    const known = floatAddresses.get(walletId);
    if (known) return known;
    const client = (deps.circle ?? defaultFloatClient)({ apiKey, entitySecret });
    const wallet = await circleCall("getWallet", () => client.getWallet({ id: walletId }), false);
    const address = wallet.data?.wallet?.address ?? null;
    if (address) floatAddresses.set(walletId, address);
    return address;
  } catch (error) {
    console.warn("test USDC: the float's address was not read", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

type GrantRow = GrantEntry & { detail: { amount?: unknown; txHash?: unknown; status?: unknown; transferId?: unknown } };

/** Every grant this workspace took, newest first. */
async function grants(): Promise<GrantRow[]> {
  return unwrap(
    await db().from("ledger_entries").select("ts, detail").eq("action", "test_usdc_added").order("seq", { ascending: false })
  ) as GrantRow[];
}

/** Whether the ledger records this transfer already: another press that sent under the same key may have. */
async function recordedTransfer(transferId: string): Promise<boolean> {
  const rows = unwrap(
    await db().from("ledger_entries").select("ts, detail").eq("action", "test_usdc_added").eq("detail->>transferId", transferId).limit(1)
  ) as GrantRow[];
  return rows.length > 0;
}

export interface TestUsdcWeek {
  takenThisWeek: number;
  weeklyLimit: number;
  latest: { amount: number; at: string; txHash: string | null } | null;
}

/** What the workspace took in the last 7 days, its limit, and its newest grant that did not fail: for the console. */
export async function readTestUsdcWeek(now: number = Date.now()): Promise<TestUsdcWeek> {
  const rows = await grants();
  const newest = rows.find((row) => row.detail?.status !== "failed");
  return {
    takenThisWeek: takenInWindow(rows, now),
    weeklyLimit: weeklyLimitOf(currentOrgConfig()),
    latest: newest
      ? { amount: Number(newest.detail.amount), at: newest.ts, txHash: typeof newest.detail.txHash === "string" ? newest.detail.txHash : null }
      : null,
  };
}

/** Circle's states after which a transfer changes no more; any other means Arc testnet still confirms it. */
const SETTLED = new Set(["COMPLETE", "CONFIRMED", ...FAILED_STATES]);
/** Circle's states in which the USDC arrived. */
const ARRIVED = new Set(["COMPLETE", "CONFIRMED"]);
const LIST_PAGE_SIZE = 50;
const LIST_PAGE_LIMIT = 100;

interface FloatTransfer {
  id: string;
  state: string;
  amount: number;
  createdAt: string;
  txHash: string | null;
  from: string | null;
}

/**
 * Every transfer Circle lists from the float to `to` on `blockchain`, newest first, a page at a time to the end. Each
 * page is its own `circleCall`, under its own deadline. A list longer than `LIST_PAGE_LIMIT` pages is refused rather than
 * read in part, since its length is the next transfer's key.
 */
async function sentFromFloat(client: FloatClient, walletId: string, to: string, blockchain: string): Promise<FloatTransfer[]> {
  const sent: FloatTransfer[] = [];
  let pageAfter: string | undefined;
  for (let page = 0; page < LIST_PAGE_LIMIT; page += 1) {
    const after = pageAfter;
    const listed = await circleCall(
      "listTransactions",
      () =>
        client.listTransactions({
          walletIds: [walletId],
          destinationAddress: to,
          txType: "OUTBOUND",
          blockchain,
          // Every token, as the balance reads do (mainnet pre-flight).
          includeAll: true,
          pageSize: LIST_PAGE_SIZE,
          ...(after ? { pageAfter: after } : {}),
        } as Parameters<FloatClient["listTransactions"]>[0]),
      false
    );
    const transactions = listed.data?.transactions ?? [];
    for (const transaction of transactions) {
      // Circle filters by both already; one that says otherwise is not the float's transfer to this wallet.
      if (transaction.transactionType && transaction.transactionType !== "OUTBOUND") continue;
      if (transaction.destinationAddress && !sameAddress(transaction.destinationAddress, to)) continue;
      const amount = Number(transaction.amounts?.[0]);
      sent.push({
        id: transaction.id,
        state: transaction.state,
        amount: Number.isFinite(amount) ? amount : 0,
        createdAt: transaction.createDate,
        txHash: transaction.txHash ?? null,
        from: transaction.sourceAddress ?? null,
      });
    }
    if (transactions.length < LIST_PAGE_SIZE) return sent;
    pageAfter = transactions[transactions.length - 1].id;
  }
  throw new Error(`Circle listed more than ${LIST_PAGE_LIMIT * LIST_PAGE_SIZE} transfers from the float to this workspace; nothing was sent`);
}

/** Safe to spend today as the console works it out, with the operating wallet's USDC read from the chain. */
async function safeToSpendNow(operatingUsdc: number, now: number): Promise<number> {
  const [accounts, invoices, milestones] = await Promise.all([listAccounts(), listInvoices(), listMilestones()]);
  return cashOutlook({
    now,
    operatingUsdc,
    reserveUsdc: Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0),
    payables: invoices
      .filter((invoice) => invoice.direction === "payable")
      .map((invoice) => ({ ...invoice, counterparty: invoice.counterparty_name, currency: invoice.currency ?? null, scheduled_for: invoice.scheduled_for ?? null })),
    milestones: milestones.map((milestone) => ({ ...milestone, contractor: milestone.contractor_name })),
    receivables: invoices
      .filter((invoice) => invoice.direction === "receivable")
      .map((invoice) => ({ ...invoice, counterparty: invoice.counterparty_name, currency: invoice.currency ?? null })),
  }).safeToSpend;
}

export interface TestUsdcAdded {
  amount: number;
  status: "confirmed" | "pending" | "failed";
  txHash: string | null;
  txUrl: string | null;
}

const statusOf = (state: string): TestUsdcAdded["status"] => (ARRIVED.has(state) ? "confirmed" : FAILED_STATES.includes(state) ? "failed" : "pending");

export async function addTestUsdc(
  input: { actorId: string },
  deps: { circle?: FloatClientFactory; now?: number; settle?: typeof awaitSettlement } = {}
): Promise<TestUsdcAdded> {
  const now = deps.now ?? Date.now();
  const weeklyLimit = weeklyLimitOf(currentOrgConfig());
  if (!(await readShadowMode(db()))) throw new TestUsdcError("not_in_shadow", weeklyLimit);
  const network = workspaceNetwork();
  if (network.id !== "arc-testnet") throw new TestUsdcError("mainnet", weeklyLimit);
  // The float lives in the platform's hosted account, which a workspace's own configuration never carries (R4).
  const { walletId, apiKey, entitySecret } = currentShadowFloat();
  if (!walletId || !apiKey || !entitySecret) throw new TestUsdcError("unavailable", weeklyLimit);

  const provider = getChainProvider();
  const operating = (await listAccounts()).find((account) => account.kind === "operating");
  if (provider.mode !== "live" || !operating?.address) throw new TestUsdcError("not_live", weeklyLimit);
  const to = operating.address;
  // Money moves on chain, so the platform's stop switch stops it as it stops a payment (T2).
  await assertPaymentsEnabled();
  // A transfer is recorded once it is sent: with no key to sign that entry, nothing is sent (review fix C).
  assertLedgerCanSign();

  const client = (deps.circle ?? defaultFloatClient)({ apiKey, entitySecret });
  const [balance, entries, listed, floatBalances, float] = await Promise.all([
    provider.getTokenBalance ? provider.getTokenBalance(operating.id, "USDC") : provider.getBalance(operating.id),
    grants(),
    sentFromFloat(client, walletId, to, network.circleBlockchain),
    circleCall("getWalletTokenBalance", () => client.getWalletTokenBalance({ id: walletId, includeAll: true }), false),
    circleCall("getWallet", () => client.getWallet({ id: walletId }), false),
  ]);
  const from = float.data?.wallet?.address ?? null;
  if (listed.some((transfer) => !SETTLED.has(transfer.state))) throw new TestUsdcError("in_flight", weeklyLimit);

  // A transfer that arrived but that no entry names: its request died before the ledger was written. Recorded first,
  // oldest first, from Circle's own figures (review fix A2).
  const recorded = new Set(entries.map((entry) => entry.detail?.transferId).filter((id): id is string => typeof id === "string"));
  for (const transfer of [...listed].reverse()) {
    if (!ARRIVED.has(transfer.state) || recorded.has(transfer.id)) continue;
    await appendLedgerEntry({
      actor: "human",
      domain: "treasury",
      action: "test_usdc_added",
      summary: `Recorded ${usdc(transfer.amount)} test USDC that Vestiarion's float sent earlier to the operating wallet, on Arc testnet`,
      detail: { by: null, amount: transfer.amount, from: transfer.from ?? from, to, transferId: transfer.id, txHash: transfer.txHash, status: "confirmed", shortfall: null, weeklyLimit, recovered: true },
    });
    recorded.add(transfer.id);
  }

  // What the float sent this workspace in the last 7 days, by Circle's list; money that never moved does not count (A4).
  const takenThisWeek = listed
    .filter((transfer) => !FAILED_STATES.includes(transfer.state) && Date.parse(transfer.createdAt) > now - WEEK_MS)
    .reduce((sum, transfer) => sum + transfer.amount, 0);
  const safeToSpend = await safeToSpendNow(balance.balance, now);
  const held = stablecoinEntry(floatBalances.data?.tokenBalances, "USDC", network, network.circleBlockchain);
  const decided = testUsdcAmount({ safeToSpend, takenThisWeek, weeklyLimit, floatBalance: Number(held?.amount ?? 0) });
  if ("refused" in decided) throw new TestUsdcError(decided.refused, weeklyLimit);
  if (!held?.token?.id) throw new TestUsdcError("float_empty", weeklyLimit);

  const transferId = await sendToCircle(
    client.createTransaction({
      walletId,
      tokenId: held.token.id,
      destinationAddress: to,
      amount: [decided.amount.toFixed(6)],
      // Every transfer Circle listed, in any state, so two presses that listed the same ones send one transfer (A3).
      idempotencyKey: testUsdcKey(currentOrgId(), listed.length + 1),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    }),
    "createTransaction",
    "the test USDC transfer"
  );
  // Circle answered with a transfer it had listed already: a press at the same moment sent it, and it is recorded (B).
  const earlier = listed.find((transfer) => transfer.id === transferId);
  if (earlier) return { amount: earlier.amount, status: statusOf(earlier.state), txHash: earlier.txHash, txUrl: earlier.txHash ? txUrl(network.id, earlier.txHash) : null };

  const settlement = await (deps.settle ?? awaitSettlement)(client, transferId);
  const transaction = settlement.transaction;
  if (transaction?.destinationAddress && !sameAddress(transaction.destinationAddress, to)) {
    throw new Error(`Circle's transfer ${transferId} names another destination than the operating wallet; it was not recorded`);
  }
  // What Circle says it sent, which is what arrived; the amount asked for while it does not say.
  const reported = Number(transaction?.amounts?.[0]);
  const amount = Number.isFinite(reported) && reported > 0 ? reported : decided.amount;
  const txHash = transaction?.txHash ?? null;
  const status = settlement.status === "confirmed" ? "confirmed" : settlement.status === "failed" ? "failed" : "pending";
  const result = { amount, status, txHash, txUrl: txHash ? txUrl(network.id, txHash) : null } as const;
  // Checked right before writing: a press at the same moment may have recorded this transfer while this one waited (B).
  if (await recordedTransfer(transferId)) return result;
  // Written while the transfer still settles too, so the weekly limit counts it (T5).
  await appendLedgerEntry({
    actor: "human",
    domain: "treasury",
    action: "test_usdc_added",
    summary: `Added ${usdc(amount)} test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow mode`,
    detail: { by: input.actorId, amount, from, to, transferId, txHash, status, shortfall: decided.shortfall, weeklyLimit },
  });
  return result;
}
