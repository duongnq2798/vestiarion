import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { cashOutlook } from "./cash-outlook";
import { getChainProvider } from "./circle";
import { sendToCircle } from "./circle/liveProvider";
import { circleCall } from "./circle/provision";
import { awaitSettlement } from "./circle/settlement";
import { stablecoinEntry } from "./circle/stablecoins";
import type { VestiarionConfig } from "./config";
import { currentOrgConfig, currentOrgId, currentPlatformConfig } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";
import { txUrl } from "./payee-chains";
import { assertPaymentsEnabled } from "./payments-switch";
import { listAccounts, listInvoices, listMilestones } from "./queries";
import { readShadowMode } from "./shadow-mode";
import { DEFAULT_WEEKLY_LIMIT, takenInWindow, testUsdcAmount, testUsdcKey, type GrantEntry } from "./test-usdc-rules";
import { workspaceNetwork } from "./workspace-network";

/**
 * Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md). A workspace in shadow mode
 * pays each bill a person agrees to in USDC on Arc testnet, at the bill's real amount, so its operating wallet needs
 * that USDC first; Circle's faucet gives 20 every two hours. Vestiarion keeps a float of test USDC in a wallet of its
 * own, in the hosted Circle account, and a workspace takes from it what its open bills need: minus safe to spend, at
 * least 1 USDC, within its weekly limit and the float's USDC. One signed `test_usdc_added` entry per grant; the
 * grants counted so far key the transfer, so two clicks together make one. Runs inside an organization scope; who
 * may ask for it (`records.write`) is the caller's check.
 */

export type TestUsdcErrorCode = "not_in_shadow" | "mainnet" | "not_live" | "unavailable" | "nothing_needed" | "limit_reached" | "float_empty";

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

export type FloatClient = Pick<CircleDeveloperControlledWalletsClient, "createTransaction" | "getTransaction" | "getWalletTokenBalance" | "getWallet">;
export type FloatClientFactory = (credentials: { apiKey: string; entitySecret: string }) => FloatClient;
const defaultFloatClient: FloatClientFactory = (credentials) => initiateDeveloperControlledWalletsClient(credentials);

/** Whether this deployment offers test USDC: a float wallet, and the hosted account it lives in. */
export function testUsdcAvailable(config: VestiarionConfig = currentOrgConfig()): boolean {
  return Boolean(config.shadowFloat?.walletId && config.chain.hostedAvailable);
}

const weeklyLimitOf = (config: VestiarionConfig) => config.shadowFloat?.weeklyLimit ?? DEFAULT_WEEKLY_LIMIT;

type GrantRow = GrantEntry & { detail: { amount?: unknown; txHash?: unknown } };

/** Every grant this workspace took, newest first. */
async function grants(): Promise<GrantRow[]> {
  return unwrap(
    await db().from("ledger_entries").select("ts, detail").eq("action", "test_usdc_added").order("seq", { ascending: false })
  ) as GrantRow[];
}

export interface TestUsdcWeek {
  takenThisWeek: number;
  weeklyLimit: number;
  latest: { amount: number; at: string; txHash: string | null } | null;
}

/** What the workspace took in the last 7 days, its limit, and its newest grant: for the console. */
export async function readTestUsdcWeek(now: number = Date.now()): Promise<TestUsdcWeek> {
  const rows = await grants();
  const newest = rows[0];
  return {
    takenThisWeek: takenInWindow(rows, now),
    weeklyLimit: weeklyLimitOf(currentOrgConfig()),
    latest: newest
      ? { amount: Number(newest.detail.amount), at: newest.ts, txHash: typeof newest.detail.txHash === "string" ? newest.detail.txHash : null }
      : null,
  };
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
  const platform = currentPlatformConfig();
  const walletId = platform.shadowFloat?.walletId;
  const { hostedCircleApiKey: apiKey, hostedCircleEntitySecret: entitySecret } = platform.chain;
  if (!walletId || !apiKey || !entitySecret) throw new TestUsdcError("unavailable", weeklyLimit);

  const provider = getChainProvider();
  const operating = (await listAccounts()).find((account) => account.kind === "operating");
  if (provider.mode !== "live" || !operating?.address) throw new TestUsdcError("not_live", weeklyLimit);
  // Money moves on chain, so the platform's stop switch stops it as it stops a payment (T2).
  await assertPaymentsEnabled();

  const [balance, earlier] = await Promise.all([
    provider.getTokenBalance ? provider.getTokenBalance(operating.id, "USDC") : provider.getBalance(operating.id),
    grants(),
  ]);
  const safeToSpend = await safeToSpendNow(balance.balance, now);
  const client = (deps.circle ?? defaultFloatClient)({ apiKey, entitySecret });
  const floatBalances = await circleCall("getWalletTokenBalance", () => client.getWalletTokenBalance({ id: walletId, includeAll: true }), false);
  const held = stablecoinEntry(floatBalances.data?.tokenBalances, "USDC", network, network.circleBlockchain);
  const decided = testUsdcAmount({ safeToSpend, takenThisWeek: takenInWindow(earlier, now), weeklyLimit, floatBalance: Number(held?.amount ?? 0) });
  if ("refused" in decided) throw new TestUsdcError(decided.refused, weeklyLimit);
  if (!held?.token?.id) throw new TestUsdcError("float_empty", weeklyLimit);

  const float = await circleCall("getWallet", () => client.getWallet({ id: walletId }), false);
  const from = float.data?.wallet?.address ?? null;
  const transferId = await sendToCircle(
    client.createTransaction({
      walletId,
      tokenId: held.token.id,
      destinationAddress: operating.address,
      amount: [decided.amount.toFixed(6)],
      // Every grant ever counted, so two clicks that read the same entries send one transfer (T4).
      idempotencyKey: testUsdcKey(currentOrgId(), earlier.length + 1),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    }),
    "createTransaction",
    "the test USDC transfer"
  );
  const settlement = await (deps.settle ?? awaitSettlement)(client, transferId);
  const txHash = settlement.transaction?.txHash ?? null;
  const status = settlement.status === "confirmed" ? "confirmed" : settlement.status === "failed" ? "failed" : "pending";
  // Written while the transfer still settles too, so the weekly limit counts it (T5).
  await appendLedgerEntry({
    actor: "human",
    domain: "treasury",
    action: "test_usdc_added",
    summary: `Added ${usdc(decided.amount)} test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow mode`,
    detail: { by: input.actorId, amount: decided.amount, from, to: operating.address, transferId, txHash, status, shortfall: decided.shortfall, weeklyLimit },
  });
  return { amount: decided.amount, status, txHash, txUrl: txHash ? txUrl(network.id, txHash) : null };
}
