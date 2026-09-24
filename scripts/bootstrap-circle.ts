/**
 * One-time setup for live mode. Creates a real Circle developer-controlled
 * wallet on Arc testnet for every treasury account and every counterparty
 * that doesn't have one, and writes the ids and addresses back to Supabase.
 *
 *   npm run seed
 *   npm run bootstrap:circle
 *
 * Counterparties get wallets here so the demo is verifiable: when the agent
 * pays Priya, you can watch the USDC land at a real Arc-testnet address. A
 * real deployment would store the address the counterparty gives you instead
 * of minting one on their behalf.
 *
 * Safe to re-run — it skips anything already provisioned.
 */
import { config } from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

config({ path: [".env.local", ".env"], quiet: true });

const SET_NAME = "vestiarion-treasury";

type ApiError = { response?: { data?: unknown }; message?: string };
const explain = (e: unknown) =>
  JSON.stringify((e as ApiError)?.response?.data ?? (e as ApiError)?.message ?? e);

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    console.error("Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env.local first.");
    process.exit(1);
  }

  const { supabase, unwrap } = await import("../src/lib/supabase");
  const db = supabase();
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // The SDK types wallet sets as a union whose end-user variant has no
  // `name`; developer-controlled sets always do.
  const sets = ((await client.listWalletSets()).data?.walletSets ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  let walletSetId = sets.find((s) => s.name === SET_NAME)?.id;
  if (!walletSetId) {
    walletSetId = (await client.createWalletSet({ name: SET_NAME })).data?.walletSet?.id;
    console.log(`created wallet set ${walletSetId}`);
  } else {
    console.log(`reusing wallet set ${walletSetId}`);
  }
  if (!walletSetId) throw new Error("could not resolve a wallet set id");

  async function provision(chain: string): Promise<{ id: string; address: string }> {
    const created = await client.createWallets({
      blockchains: [chain as never],
      count: 1,
      walletSetId: walletSetId!,
      accountType: "SCA",
    });
    const wallet = created.data?.wallets?.[0];
    if (!wallet?.id || !wallet.address) throw new Error(`no wallet returned for ${chain}`);
    return { id: wallet.id, address: wallet.address };
  }

  // ------------------------------------------------------------- accounts
  const accounts = unwrap(
    await db.from("accounts").select("id, name, chain, circle_wallet_id, kind")
  ) as Array<{
    id: string;
    name: string;
    chain: string;
    circle_wallet_id: string | null;
    kind: string;
  }>;

  for (const account of accounts) {
    if (account.circle_wallet_id) {
      console.log(`skip  ${account.name} (already provisioned)`);
      continue;
    }
    const wallet = await provision(account.chain);
    const res = await db
      .from("accounts")
      .update({ circle_wallet_id: wallet.id, address: wallet.address })
      .eq("id", account.id);
    if (res.error) throw new Error(res.error.message);
    console.log(`ok    ${account.name} (${account.chain}) -> ${wallet.address}`);
  }

  // ------------------------------------------------------- counterparties
  const counterparties = unwrap(
    await db.from("counterparties").select("id, name, chain, address")
  ) as Array<{ id: string; name: string; chain: string | null; address: string | null }>;

  for (const counterparty of counterparties) {
    if (counterparty.address) {
      console.log(`skip  ${counterparty.name} (already has an address)`);
      continue;
    }
    const wallet = await provision(counterparty.chain ?? "ARC-TESTNET");
    const res = await db
      .from("counterparties")
      .update({ address: wallet.address })
      .eq("id", counterparty.id);
    if (res.error) throw new Error(res.error.message);
    console.log(`ok    ${counterparty.name} -> ${wallet.address}`);
  }

  const operating = accounts.find((a) => a.kind === "operating");
  const refreshed = operating
    ? ((
        await db.from("accounts").select("address").eq("id", operating.id).single()
      ).data as { address: string | null } | null)
    : null;

  console.log("\nNext: fund the operating wallet with testnet USDC.");
  if (refreshed?.address) {
    console.log(`  Address: ${refreshed.address}`);
    console.log("  Faucet:  https://faucet.circle.com  (select Arc Testnet, 20 USDC / 2h)");
  }
  console.log("Then run `npm run circle:doctor` to confirm the balance landed.");
}

main().catch((e) => {
  console.error(explain(e));
  process.exit(1);
});
