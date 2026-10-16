import { chainModes, getChainProvider } from "../circle";
import { networkRpcUrl } from "../circle/arcFees";
import { readTokenBalance } from "../circle/bank-payout";
import { blindpaySettingsFromEnv } from "../blindpay/settings";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { NetworkProfile } from "../network";
import { workspaceNetwork } from "../workspace-network";
import { BankPayoutsError } from "./commands";
import { readPayoutPartner } from "./store";

/**
 * BlindPay's test token on Arc testnet (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B13). On a development
 * instance BlindPay takes USDB, not USDC, from the operating wallet; BlindPay's dashboard mints it only to a browser
 * wallet, so a workspace on Arc testnet mints it to its own operating wallet here. Anyone may mint USDB to themselves
 * with `mintUSDB(uint256)`; it has 18 decimals and no value. Arc mainnet has no USDB: BlindPay takes USDC there.
 */

/** USDB on Arc testnet, as BlindPay's dashboard names it under Utilities, Mint USDB. */
export const USDB_ARC_TESTNET = "0x83cD7E0a1e8ae37eC75842544d77E190F386B73A";
/** What one press mints, in USDB. */
export const TEST_USDB_MINT = 100;

const UNITS = 10n ** 18n;

/** Whole USDB, from its base units, to two decimals. */
const whole = (units: bigint) => Number((units * 100n) / UNITS) / 100;

/**
 * The operating wallet's USDB on `network`, whole, read on chain (B13); null when it cannot be read, or the network has
 * no USDB. What the agent weighs a bank payout against on Arc testnet, in place of USDC.
 */
export async function readTestUsdb(network: NetworkProfile, address: string, fetchImpl?: typeof fetch): Promise<number | null> {
  if (network.id !== "arc-testnet" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const units = await readTokenBalance(networkRpcUrl(network), USDB_ARC_TESTNET, address, fetchImpl);
  return units === null ? null : whole(units);
}

/** Whether a bank payout on this network takes BlindPay's test token rather than USDC (B13): Arc testnet, USDB. */
export function bankPayoutTakesTestToken(network: Pick<NetworkProfile, "id">): boolean {
  return blindpaySettingsFromEnv()?.route(network.id).token === "USDB" && network.id === "arc-testnet";
}

/** Whether this workspace pays bank payouts in USDB: live, on Arc testnet, with BlindPay's development token. */
function takesTestToken(): boolean {
  const settings = blindpaySettingsFromEnv();
  const network = workspaceNetwork();
  return Boolean(settings) && network.id === "arc-testnet" && settings?.route(network.id).token === "USDB" && chainModes().mode === "live";
}

async function operatingWallet(): Promise<{ id: string; address: string } | null> {
  const read = await db().from("accounts").select("id, address").eq("kind", "operating").maybeSingle<{ id: string; address: string | null }>();
  if (read.error) throw new Error(read.error.message);
  const address = read.data?.address;
  return read.data && address && /^0x[0-9a-fA-F]{40}$/.test(address) ? { id: read.data.id, address } : null;
}

/** The operating wallet's USDB, for the Bank payouts card; null where bank payouts take no test token, or it cannot be read. */
export async function testTokenView(): Promise<{ balance: number | null } | null> {
  if (!takesTestToken()) return null;
  const wallet = await operatingWallet().catch(() => null);
  if (!wallet) return { balance: null };
  const units = await readTokenBalance(networkRpcUrl(workspaceNetwork()), USDB_ARC_TESTNET, wallet.address);
  return { balance: units === null ? null : whole(units) };
}

/**
 * Mints `TEST_USDB_MINT` USDB to the operating wallet, from the wallet itself, as a Circle contract execution, and waits
 * for it to settle. Recorded in the ledger as `bank_payouts_test_token_minted`. Refused where bank payouts take no test
 * token, before the workspace is set up, or without an operating wallet.
 */
export async function mintTestUsdb(input: { actorId: string; requestId: string }): Promise<{ txHash: string | null; amount: number }> {
  if (!takesTestToken()) throw new BankPayoutsError("Test USDB is minted only for bank payouts on Arc testnet.");
  const partner = await readPayoutPartner();
  if (!partner?.customerId) throw new BankPayoutsError("Set up bank payouts first.");
  const wallet = await operatingWallet();
  if (!wallet) throw new BankPayoutsError("The workspace has no operating wallet yet.");
  const provider = getChainProvider();
  if (!provider.mintTestToken) throw new BankPayoutsError("Test USDB is minted only for bank payouts on Arc testnet.");
  const minted = await provider.mintTestToken(
    wallet.id,
    { contractAddress: USDB_ARC_TESTNET, abiFunctionSignature: "mintUSDB(uint256)", abiParameters: [(BigInt(TEST_USDB_MINT) * UNITS).toString()] },
    input.requestId
  );
  if (minted.status === "failed") throw new BankPayoutsError("The mint of test USDB failed on Arc testnet. Try again in a moment.");
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "treasury",
    action: "bank_payouts_test_token_minted",
    summary: `${TEST_USDB_MINT} test USDB minted to the operating wallet for bank payouts`,
    detail: { by: input.actorId, token: "USDB", contract: USDB_ARC_TESTNET, amount: TEST_USDB_MINT, txHash: minted.txHash, status: minted.status },
  });
  return { txHash: minted.txHash, amount: TEST_USDB_MINT };
}
