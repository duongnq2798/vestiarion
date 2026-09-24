/**
 * End-to-end proof that live mode works: creates two developer-controlled
 * wallets on Arc testnet, pulls testnet USDC from Circle's faucet, and sends
 * a real transfer between them. Prints the USDC token id you need for
 * CIRCLE_USDC_TOKEN_ID.
 *
 *   npm run arc:proof
 */
import { config } from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

config({ path: [".env.local", ".env"], quiet: true });

type ApiError = { response?: { data?: unknown }; message?: string };
const explain = (e: unknown) =>
  JSON.stringify((e as ApiError)?.response?.data ?? (e as ApiError)?.message ?? e);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SET_NAME = "vestiarion-treasury";

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY!;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET!;
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // 1. Wallet set (reuse if it already exists).
  const existingSets = ((await client.listWalletSets()).data?.walletSets ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  let walletSetId = existingSets.find((s) => s.name === SET_NAME)?.id;
  if (!walletSetId) {
    walletSetId = (await client.createWalletSet({ name: SET_NAME })).data?.walletSet?.id;
    console.log(`created wallet set ${walletSetId}`);
  } else {
    console.log(`reusing wallet set ${walletSetId}`);
  }
  if (!walletSetId) throw new Error("no wallet set id");

  // 2. Two wallets on Arc testnet.
  let wallets = (
    await client.listWallets({ blockchain: "ARC-TESTNET", walletSetId })
  ).data?.wallets ?? [];

  if (wallets.length < 2) {
    const created = await client.createWallets({
      blockchains: ["ARC-TESTNET"],
      count: 2 - wallets.length,
      walletSetId,
      accountType: "SCA",
    });
    console.log(`created ${created.data?.wallets?.length ?? 0} wallet(s)`);
    wallets = (await client.listWallets({ blockchain: "ARC-TESTNET", walletSetId })).data
      ?.wallets ?? [];
  }

  const [source, destination] = wallets;
  console.log(`source      ${source.id}  ${source.address}`);
  console.log(`destination ${destination.id}  ${destination.address}`);

  // 3. Faucet.
  console.log("\nrequesting testnet USDC from the Circle faucet…");
  try {
    await client.requestTestnetTokens({
      address: source.address!,
      blockchain: "ARC-TESTNET",
      usdc: true,
    });
    console.log("faucet request accepted");
  } catch (e) {
    console.log(`faucet request failed (may be rate-limited): ${explain(e)}`);
  }

  // 4. Wait for the balance to land, and learn the USDC token id.
  let usdc: { amount?: string; token?: { id?: string; symbol?: string } } | undefined;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const balances = (await client.getWalletTokenBalance({ id: source.id })).data
      ?.tokenBalances ?? [];
    usdc = balances.find((b) => b.token?.symbol === "USDC");
    if (usdc && Number(usdc.amount) > 0) break;
    console.log(`  waiting for funds… (${attempt}/12)`);
    await sleep(5000);
  }

  if (!usdc || Number(usdc.amount) === 0) {
    console.log("\nNo USDC arrived. Fund the source wallet manually, then re-run:");
    console.log(`  circle wallet fund --address ${source.address} --chain ARC-TESTNET`);
    return;
  }

  console.log(`\nsource balance: ${usdc.amount} USDC`);
  console.log(`CIRCLE_USDC_TOKEN_ID=${usdc.token?.id}`);

  // 5. A real transfer on Arc.
  console.log("\nsending 1.00 USDC source -> destination…");
  const tx = await client.createTransaction({
    walletId: source.id,
    tokenId: usdc.token!.id!,
    destinationAddress: destination.address!,
    amount: ["1.00"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const txId = tx.data?.id;
  console.log(`transaction id: ${txId}  state: ${tx.data?.state}`);

  if (!txId) return;
  try {
    const settled = await client.getTransaction({
      id: txId,
      waitForState: "CONFIRMED",
      signal: AbortSignal.timeout(60_000),
    });
    const tx = settled.data?.transaction;
    console.log(`\nSettled on Arc testnet. state=${tx?.state} hash=${tx?.txHash}`);
  } catch (e) {
    console.log(`\nDid not confirm within 60s: ${explain(e)}`);
  }
}

main().catch((e) => {
  console.error(explain(e));
  process.exit(1);
});
