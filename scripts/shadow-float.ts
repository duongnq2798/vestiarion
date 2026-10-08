/**
 * Vestiarion's test USDC float for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T1): one
 * wallet on Arc testnet in the platform's hosted Circle account, from which a shadow workspace takes the test USDC its
 * open bills need.
 *
 *   npm run shadow-float -- setup    makes the wallet, once, and prints its id and address
 *   npm run shadow-float -- status   prints its USDC, and what each workspace took in the last 7 days and in all
 *
 * The float is filled from outside the code: TestMint (destination Arc Testnet, recipient the float's address) or
 * Circle's faucet. Nothing here spends real USDC, and nothing prints a secret: Circle's errors are reported by call and
 * status only. Reads HOSTED_CIRCLE_API_KEY and HOSTED_CIRCLE_ENTITY_SECRET; `status` also SHADOW_FLOAT_WALLET_ID.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const USAGE = "npm run shadow-float -- setup|status";
const WALLET_SET = "vestiarion-shadow-float";
const TESTMINT = "https://testmint.myproceeds.xyz";

const usdc = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

async function hostedClient() {
  const { configFromEnv } = await import("../src/lib/config");
  const { defaultCircleClient } = await import("../src/lib/circle/check");
  const platform = configFromEnv(process.env);
  const { hostedCircleApiKey: apiKey, hostedCircleEntitySecret: entitySecret } = platform.chain;
  if (!apiKey || !entitySecret) throw new Error("Set HOSTED_CIRCLE_API_KEY and HOSTED_CIRCLE_ENTITY_SECRET: the float lives in the hosted Circle account.");
  const { initiateDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
  return { platform, provisioning: defaultCircleClient({ apiKey, entitySecret }), wallets: initiateDeveloperControlledWalletsClient({ apiKey, entitySecret }) };
}

async function setup() {
  const { provisioning } = await hostedClient();
  const { createWallet, walletIdempotencyKey, walletSetIdNamed } = await import("../src/lib/circle/provision");
  const { ARC_TESTNET } = await import("../src/lib/network");
  // Found by its name, or made the first time; the wallet is keyed, so running this again returns the same one.
  const walletSetId = await walletSetIdNamed(provisioning, WALLET_SET);
  const wallet = await createWallet(provisioning, {
    walletSetId,
    chain: ARC_TESTNET.circleBlockchain,
    accountType: "SCA",
    idempotencyKey: walletIdempotencyKey("platform", "shadow-float"),
  });
  console.log(`SHADOW_FLOAT_WALLET_ID=${wallet.id}`);
  console.log(`address ${wallet.address}`);
  console.log(`Buy on ${TESTMINT}: destination Arc Testnet, recipient ${wallet.address}`);
  console.log("Then set SHADOW_FLOAT_WALLET_ID on the deployment and redeploy.");
}

async function status() {
  const { platform, wallets } = await hostedClient();
  const walletId = platform.shadowFloat?.walletId;
  if (!walletId) throw new Error("Set SHADOW_FLOAT_WALLET_ID: `npm run shadow-float -- setup` prints it.");
  const { circleCall } = await import("../src/lib/circle/provision");
  const { stablecoinEntry } = await import("../src/lib/circle/stablecoins");
  const { ARC_TESTNET } = await import("../src/lib/network");
  const { takenInWindow } = await import("../src/lib/test-usdc-rules");

  const [wallet, balances] = await Promise.all([
    circleCall("getWallet", () => wallets.getWallet({ id: walletId }), false),
    circleCall("getWalletTokenBalance", () => wallets.getWalletTokenBalance({ id: walletId, includeAll: true }), false),
  ]);
  const held = stablecoinEntry(balances.data?.tokenBalances, "USDC", ARC_TESTNET, ARC_TESTNET.circleBlockchain);
  console.log(`Float ${walletId}`);
  console.log(`address ${wallet.data?.wallet?.address ?? "unknown"}`);
  console.log(`USDC ${usdc(Number(held?.amount ?? 0))} on Arc testnet`);
  console.log(`Weekly limit per workspace: ${usdc(platform.shadowFloat?.weeklyLimit ?? 0)} USDC`);

  // Every workspace's grants, read with the service role: this is the operator's view across workspaces.
  const { createContext } = await import("../src/lib/context");
  const db = createContext(platform).db;
  const entries = await db.from("ledger_entries").select("org_id, ts, detail").eq("action", "test_usdc_added").order("seq", { ascending: true });
  if (entries.error) throw new Error(entries.error.message);
  const rows = (entries.data ?? []) as Array<{ org_id: string; ts: string; detail: { amount?: unknown; status?: unknown } }>;
  if (rows.length === 0) {
    console.log("\nNo workspace has taken test USDC yet.");
    return;
  }
  const orgIds = [...new Set(rows.map((row) => row.org_id))];
  const orgs = await db.from("orgs").select("id, slug").in("id", orgIds);
  if (orgs.error) throw new Error(orgs.error.message);
  const slugs = new Map(((orgs.data ?? []) as Array<{ id: string; slug: string }>).map((org) => [org.id, org.slug]));

  const now = Date.now();
  console.log("\nworkspace  last 7 days  in all  grants");
  for (const orgId of orgIds) {
    const own = rows.filter((row) => row.org_id === orgId);
    // In all, as in the last 7 days: a transfer Circle reported failed moved nothing.
    const all = own.reduce((sum, row) => {
      const amount = Number(row.detail?.amount);
      return Number.isFinite(amount) && amount > 0 && row.detail?.status !== "failed" ? sum + amount : sum;
    }, 0);
    console.log(`${slugs.get(orgId) ?? orgId}  ${usdc(takenInWindow(own, now))}  ${usdc(all)}  ${own.length}`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "setup") return setup();
  if (command === "status") return status();
  console.error(`Usage: ${USAGE}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
